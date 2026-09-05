// Browser-side media pipeline: CDN bytes -> mediabunny demux -> fMP4 -> MediaSource.
// Video and browser-native audio are COPIED (passthrough, no re-encode). The file's
// own timestamps are kept, so MSE buffered ranges are real media time and a TV
// position maps 1:1. Dolby/DTS audio, which no browser can decode, is decoded via a
// mediabunny extension and re-encoded to Opus in-browser (the only track that costs
// CPU, and audio is cheap).
import {
  Input, Output, MATROSKA, Mp4OutputFormat, AppendOnlyStreamTarget, StreamSource, canEncodeAudio,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource, AudioSampleSink, AudioSampleSource,
} from "mediabunny";
import { registerAc3Decoder } from "@mediabunny/ac3";
import { registerDtsDecoder } from "@mediabunny/dts";
import { ByteSource } from "../net/byte-source.js";

registerAc3Decoder();   // AC-3 + E-AC-3
registerDtsDecoder();   // DTS (incl. DTS-HD core)

const AHEAD_SECONDS = 90;      // don't mux more than this ahead of the playhead...
const AHEAD_BYTES = 120 * 1024 * 1024;   // ...nor more than this: Chrome's MSE quota is ~150 MB of video, and over-feeding
                                          // makes it evict from the tail, which the buffered-range check can't see
const BEHIND_SECONDS = 45;     // evict buffer older than this
const TRANSCODABLE = new Set(["ac3", "eac3", "dts"]);
const OPUS_BITRATE = 256_000;

function mime(v, a) { return `video/mp4; codecs="${[v, a].filter(Boolean).join(", ")}"`; }

let opusOk = null;
async function opusEncodable() { if (opusOk == null) opusOk = await canEncodeAudio("opus", { numberOfChannels: 2, sampleRate: 48000 }).catch(() => false); return opusOk; }

export class Pipeline {
  constructor(video, { onTracks, onStatus, onError } = {}) {
    this.video = video;
    this.onTracks = onTracks; this.onStatus = onStatus; this.onError = onError;
    this.source = null; this.input = null;
    this.mediaSource = null; this.sourceBuffer = null;
    this.run = null;               // current feed run {cancelled, output}
    this.tracks = null;
    this.selectedAudioId = null;
    this.appendQueue = Promise.resolve();
    this.pendingFirstAppend = null;
  }

  // ---- open a file: probe tracks, decide what's playable ----
  async open(cdnUrl, { tee, size } = {}) {
    await this.close();
    const source = new ByteSource(cdnUrl, { size });
    if (tee) source.setTee(tee);
    this.source = source;
    const fileSize = await source.getSize();
    this.input = new Input({ formats: [MATROSKA], source: new StreamSource({ getSize: () => fileSize, read: (s, e) => source.read(s, e), maxCacheSize: 8 * 1024 * 1024 }) });

    const video = await this.input.getPrimaryVideoTrack();
    if (!video) throw new Error("No video track in file");
    const audios = await this.input.getAudioTracks();
    const duration = (await video.getDurationFromMetadata()) ?? (await this.input.computeDuration());

    const vCodec = await video.getCodecParameterString();
    const vOk = vCodec ? MediaSource.isTypeSupported(mime(vCodec)) : false;
    const opus = await opusEncodable();
    const audioInfos = [];
    for (const a of audios) {
      const codecString = await a.getCodecParameterString().catch(() => null);
      const direct = codecString ? MediaSource.isTypeSupported(mime(vCodec || "avc1.640028", codecString)) : false;
      const transcode = !direct && TRANSCODABLE.has(a.codec) && opus;
      audioInfos.push({ id: a.id, track: a, codec: a.codec, codecString, language: a.languageCode, name: a.name, channels: a.numberOfChannels,
        playable: direct || transcode, direct, transcode, isDefault: Boolean(a.disposition?.default) });
    }
    this.tracks = {
      video: { track: video, codec: video.codec, codecString: vCodec, playable: vOk, width: video.displayWidth, height: video.displayHeight, hdr: await video.hasHighDynamicRange().catch(() => false) },
      audios: audioInfos, duration, size: fileSize,
    };
    if (!vOk) throw new Error(`This browser can't decode the video (${video.codec} ${vCodec || ""}).`);
    this.onTracks?.(this.tracks);
    return this.tracks;
  }

  pickDefaultAudio(prefer = ["jpn", "eng"]) {
    const list = this.tracks.audios.filter(a => a.playable);
    if (!list.length) return null;
    return (list.find(a => a.isDefault) || prefer.map(l => list.find(a => a.language === l)).find(Boolean) || list[0]).id;
  }

  // ---- start (or restart) muxing from `startAt` with the given audio track ----
  async start(startAt, audioId = this.selectedAudioId ?? this.pickDefaultAudio()) {
    this.startCount = (this.startCount || 0) + 1;
    if (!this.tracks) throw new Error("open() first");
    await this._cancelRun();
    this.selectedAudioId = audioId;
    const audio = this.tracks.audios.find(a => a.id === audioId) || null;
    const audioMime = audio ? (audio.transcode ? "opus" : audio.codecString) : null;
    const codecs = mime(this.tracks.video.codecString, audioMime);

    if (!this.mediaSource) {
      this.mediaSource = new MediaSource();
      this.video.__pipeline = this;                                   // whoever attached last owns the element
      this.video.src = URL.createObjectURL(this.mediaSource);
      await new Promise(r => this.mediaSource.addEventListener("sourceopen", r, { once: true }));
      this.mediaSource.duration = this.tracks.duration;
      this.sourceBuffer = this.mediaSource.addSourceBuffer(codecs);
      this.sourceBuffer.mode = "segments";
    } else {
      await this._whenIdle();
      try { this.sourceBuffer.abort(); } catch {}
      if ((this._ranges() || []).length) await this._remove(0, this.mediaSource.duration || 1e9);
      try { this.sourceBuffer.changeType(codecs); } catch {}
    }
    this.currentMime = codecs;

    const run = { cancelled: false, output: null, startAt, audioId, nv: 0, na: 0, stage: "init", transcode: Boolean(audio?.transcode) };
    this.run = run;
    const writable = new WritableStream({ write: chunk => this._append(chunk) });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }), target: new AppendOnlyStreamTarget(writable) });
    run.output = output;
    // (no track metadata: MSE ignores it and mediabunny insists on ISO 639-2 codes)
    const vSrc = new EncodedVideoPacketSource(this.tracks.video.codec);
    output.addVideoTrack(vSrc);
    let aSrc = null;
    if (audio) {
      // WebCodecs Opus only encodes mono/stereo, so downmix 5.1/7.1 to stereo.
      aSrc = audio.transcode
        ? new AudioSampleSource({ codec: "opus", bitrate: OPUS_BITRATE, transform: { numberOfChannels: 2, sampleRate: 48000 } })
        : new EncodedAudioPacketSource(audio.codec);
      output.addAudioTrack(aSrc);
    }
    await output.start();

    this.onStatus?.({ phase: "muxing", startAt });
    void this._feed(run, vSrc, aSrc, audio, startAt).catch(e => { if (!run.cancelled) this.onError?.(e); });
  }

  async _feed(run, vSrc, aSrc, audio, startAt) {
    const v = this.tracks.video.track;
    const vSink = new EncodedPacketSink(v);
    const vKey = (await vSink.getKeyPacket(startAt)) || (await vSink.getFirstKeyPacket());
    if (!vKey) throw new Error("No keyframe found");
    const vCfg = await v.getDecoderConfig();

    // Audio: passthrough (encoded packets) or transcode (decoded samples -> Opus).
    const aTrack = audio?.track || null;
    const transcode = Boolean(audio?.transcode);
    const packetSink = aTrack && !transcode ? new EncodedPacketSink(aTrack) : null;
    const aCfg = packetSink ? await aTrack.getDecoderConfig() : null;
    let aPacket = packetSink ? ((await packetSink.getPacket(vKey.timestamp)) || (await packetSink.getFirstPacket())) : null;
    run.stage = "audio-init";
    const sampleIter = aTrack && transcode ? new AudioSampleSink(aTrack).samples(vKey.timestamp) : null;
    let aSample = sampleIter ? (await sampleIter.next()).value || null : null;
    run.stage = "feeding";
    let nv = 0, na = 0, lastTs = startAt;
    const bytes0 = this.source.bytesFetched;

    // Pace on what we have FED (last video timestamp), not on MSE's buffered ranges:
    // once Chrome starts evicting, the range around the playhead stops growing and a
    // buffered-range check would feed the whole file. Cap by bytes too, estimated from
    // this run's own download so 4K gets ~15s ahead and 1080p the full 90s.
    const throttle = async () => {
      while (!run.cancelled) {
        const fed = lastTs - startAt;
        const rate = fed > 4 ? (this.source.bytesFetched - bytes0) / fed : 0;   // bytes per media second
        const limit = Math.max(8, rate > 0 ? Math.min(AHEAD_SECONDS, AHEAD_BYTES / rate) : AHEAD_SECONDS);
        if (lastTs - this.video.currentTime < limit) return;
        await new Promise(r => setTimeout(r, 250));
      }
    };
    const pumpAudioTo = async ts => {
      if (packetSink) {
        while (aPacket && aPacket.timestamp <= ts && !run.cancelled) {
          await aSrc.add(aPacket, na === 0 ? { decoderConfig: aCfg } : undefined); na++; run.na = na;
          aPacket = await packetSink.getNextPacket(aPacket);
        }
      } else if (sampleIter) {
        while (aSample && aSample.timestamp <= ts && !run.cancelled) {
          run.stage = 'encode'; await aSrc.add(aSample); na++; run.na = na; run.stage = 'feeding'; aSample.close?.();
          aSample = (await sampleIter.next()).value || null;
        }
      }
    };

    for await (const p of vSink.packets(vKey)) {
      if (run.cancelled) break;
      await vSrc.add(p, nv === 0 ? { decoderConfig: vCfg } : undefined); nv++; run.nv = nv; lastTs = p.timestamp; run.fedTs = lastTs;
      // Keep audio a few seconds ahead of video: MSE's playable range is the
      // INTERSECTION of the track buffers, so audio must fully cover each video
      // fragment or the range fragments into gaps.
      await pumpAudioTo(p.timestamp + 3);
      if ((nv & 7) === 0) { await throttle(); this._evict(); }
    }
    if (run.cancelled) { aSample?.close?.(); return; }
    await pumpAudioTo(Infinity);
    aSample?.close?.();
    await run.output.finalize();
    if (!run.cancelled && this.mediaSource.readyState === "open") { await this._whenIdle(); try { this.mediaSource.endOfStream(); } catch {} }
    this.onStatus?.({ phase: "complete" });
  }

  // ---- MSE plumbing ----
  _append(chunk) {
    const sb = this.sourceBuffer;
    this.appendQueue = this.appendQueue.then(() => new Promise((resolve, reject) => {
      if (!sb || this.mediaSource?.readyState !== "open") return resolve();
      const go = () => {
        try { sb.appendBuffer(chunk); } catch (e) { return reject(e); }
        sb.addEventListener("updateend", () => resolve(), { once: true });
      };
      if (sb.updating) sb.addEventListener("updateend", go, { once: true }); else go();
    })).catch(e => {
      if (e?.name === "QuotaExceededError") { this._evict(true); return; }
      // Detached/removed SourceBuffer: this pipeline lost the element to a newer one. Stop quietly.
      if (e?.name === "InvalidStateError") { if (this.run) this.run.cancelled = true; return; }
      this.onError?.(e);
    });
    return this.appendQueue;
  }
  _whenIdle() { return new Promise(r => { const sb = this.sourceBuffer; if (!sb || !sb.updating) return r(); sb.addEventListener("updateend", () => r(), { once: true }); }); }
  _remove(a, b) { return new Promise(r => { const sb = this.sourceBuffer; try { sb.remove(a, b); sb.addEventListener("updateend", () => r(), { once: true }); } catch { r(); } }); }
  // `.buffered` throws InvalidStateError once the SourceBuffer is detached from its
  // MediaSource (element re-attached elsewhere); treat that as "nothing buffered".
  _ranges() { try { return this.sourceBuffer?.buffered || null; } catch { return null; } }
  _bufferedEnd() { const b = this._ranges(); if (!b || !b.length) return null; const t = this.video.currentTime; for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return b.end(i); return b.end(b.length - 1); }
  buffered() { const b = this._ranges(); const out = []; if (b) for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]); return out; }
  _evict(force = false) {
    const sb = this.sourceBuffer, b = this._ranges(); if (!sb || sb.updating || !b || !b.length) return;
    const t = this.video.currentTime, keep = force ? 10 : BEHIND_SECONDS;
    if (b.start(0) < t - keep - 5) { try { sb.remove(0, t - keep); } catch {} }
  }
  async _cancelRun() {
    const run = this.run; if (!run) return;
    run.cancelled = true; this.run = null;
    try { await run.output?.cancel(); } catch {}
    await this.appendQueue.catch(() => {});
  }

  isBuffered(t, slack = 0.25) { for (const [s, e] of this.buffered()) if (t >= s - slack && t <= e - slack) return true; return false; }

  // TV jumped: play from the buffer if we have it, otherwise re-mux from there.
  async seekTo(t) {
    if (this.isBuffered(t)) { this.video.currentTime = t; return; }
    await this.start(Math.max(0, t), this.selectedAudioId);
    this.video.currentTime = t;
  }
  async selectAudio(audioId) {
    if (audioId === this.selectedAudioId) return;
    const t = this.video.currentTime;
    await this.start(Math.max(0, t - 0.1), audioId);
    this.video.currentTime = t;
  }

  async close() {
    await this._cancelRun();
    if (this.mediaSource) { try { if (this.mediaSource.readyState === "open") this.mediaSource.endOfStream(); } catch {} }
    this.mediaSource = null; this.sourceBuffer = null;
    // Only tear down the element if no newer pipeline has attached to it since.
    if (this.video.__pipeline === this) { this.video.__pipeline = null; try { this.video.removeAttribute("src"); this.video.load(); } catch {} }
    this.input?.dispose(); this.input = null;
    this.source?.dispose(); this.source = null;
    this.tracks = null; this.selectedAudioId = null;
  }
}
