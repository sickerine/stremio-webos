// Browser-side media pipeline: CDN bytes -> mediabunny demux -> fMP4 passthrough ->
// MediaSource. No decoding, no server. Timestamps are the file's own, so MSE's
// buffered ranges are real media time and a TV position maps 1:1.
import {
  Input, Output, MATROSKA, Mp4OutputFormat, AppendOnlyStreamTarget, StreamSource,
  EncodedPacketSink, EncodedVideoPacketSource, EncodedAudioPacketSource,
} from "mediabunny";
import { ByteSource } from "../net/byte-source.js";

const AHEAD_SECONDS = 90;      // don't mux more than this ahead of the playhead
const BEHIND_SECONDS = 45;     // evict buffer older than this

function mime(v, a) { return `video/mp4; codecs="${[v, a].filter(Boolean).join(", ")}"`; }

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
    const audioInfos = [];
    for (const a of audios) {
      const codec = await a.getCodecParameterString();
      const ok = codec ? MediaSource.isTypeSupported(mime(vCodec || "avc1.640028", codec)) : false;
      audioInfos.push({ id: a.id, track: a, codec: a.codec, codecString: codec, language: a.languageCode, name: a.name, channels: a.numberOfChannels, playable: ok, isDefault: Boolean(a.disposition?.default) });
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
    if (!this.tracks) throw new Error("open() first");
    await this._cancelRun();
    this.selectedAudioId = audioId;
    const audio = this.tracks.audios.find(a => a.id === audioId) || null;
    const codecs = mime(this.tracks.video.codecString, audio?.codecString);

    if (!this.mediaSource) {
      this.mediaSource = new MediaSource();
      this.video.src = URL.createObjectURL(this.mediaSource);
      await new Promise(r => this.mediaSource.addEventListener("sourceopen", r, { once: true }));
      this.mediaSource.duration = this.tracks.duration;
      this.sourceBuffer = this.mediaSource.addSourceBuffer(codecs);
      this.sourceBuffer.mode = "segments";
    } else {
      await this._whenIdle();
      try { this.sourceBuffer.abort(); } catch {}
      if (this.sourceBuffer.buffered.length) await this._remove(0, this.mediaSource.duration || 1e9);
      try { this.sourceBuffer.changeType(codecs); } catch {}
    }
    this.currentMime = codecs;

    const run = { cancelled: false, output: null, startAt, audioId };
    this.run = run;
    const writable = new WritableStream({ write: chunk => this._append(chunk) });
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }), target: new AppendOnlyStreamTarget(writable) });
    run.output = output;
    // (no track metadata: MSE ignores it and mediabunny insists on ISO 639-2 codes)
    const vSrc = new EncodedVideoPacketSource(this.tracks.video.codec);
    output.addVideoTrack(vSrc);
    let aSrc = null;
    if (audio) { aSrc = new EncodedAudioPacketSource(audio.codec); output.addAudioTrack(aSrc); }
    await output.start();

    this.onStatus?.({ phase: "muxing", startAt });
    void this._feed(run, vSrc, aSrc, audio?.track || null, startAt).catch(e => { if (!run.cancelled) this.onError?.(e); });
  }

  async _feed(run, vSrc, aSrc, audioTrack, startAt) {
    const v = this.tracks.video.track;
    const vSink = new EncodedPacketSink(v);
    const vKey = (await vSink.getKeyPacket(startAt)) || (await vSink.getFirstKeyPacket());
    if (!vKey) throw new Error("No keyframe found");
    const vCfg = await v.getDecoderConfig();
    const aSink = audioTrack ? new EncodedPacketSink(audioTrack) : null;
    const aCfg = audioTrack ? await audioTrack.getDecoderConfig() : null;
    let aPacket = aSink ? ((await aSink.getPacket(vKey.timestamp)) || (await aSink.getFirstPacket())) : null;
    let nv = 0, na = 0;
    const throttle = async () => {
      // keep no more than AHEAD_SECONDS muxed past the playhead
      while (!run.cancelled) {
        const end = this._bufferedEnd();
        if (end == null || end - this.video.currentTime < AHEAD_SECONDS) return;
        await new Promise(r => setTimeout(r, 250));
      }
    };
    for await (const p of vSink.packets(vKey)) {
      if (run.cancelled) break;
      await vSrc.add(p, nv === 0 ? { decoderConfig: vCfg } : undefined); nv++;
      // interleave audio up to this video timestamp
      while (aPacket && aPacket.timestamp <= p.timestamp + 0.5 && !run.cancelled) {
        await aSrc.add(aPacket, na === 0 ? { decoderConfig: aCfg } : undefined); na++;
        aPacket = await aSink.getNextPacket(aPacket);
      }
      if ((nv & 7) === 0) { await throttle(); this._evict(); }
    }
    if (run.cancelled) return;
    while (aPacket) { await aSrc.add(aPacket, na === 0 ? { decoderConfig: aCfg } : undefined); na++; aPacket = await aSink.getNextPacket(aPacket); }
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
    })).catch(e => { if (e?.name === "QuotaExceededError") this._evict(true); else this.onError?.(e); });
    return this.appendQueue;
  }
  _whenIdle() { return new Promise(r => { const sb = this.sourceBuffer; if (!sb || !sb.updating) return r(); sb.addEventListener("updateend", () => r(), { once: true }); }); }
  _remove(a, b) { return new Promise(r => { const sb = this.sourceBuffer; try { sb.remove(a, b); sb.addEventListener("updateend", () => r(), { once: true }); } catch { r(); } }); }
  _bufferedEnd() { const b = this.sourceBuffer?.buffered; if (!b || !b.length) return null; const t = this.video.currentTime; for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.5 && t <= b.end(i) + 0.5) return b.end(i); return b.end(b.length - 1); }
  buffered() { const b = this.sourceBuffer?.buffered; const out = []; if (b) for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]); return out; }
  _evict(force = false) {
    const sb = this.sourceBuffer; if (!sb || sb.updating || !sb.buffered.length) return;
    const t = this.video.currentTime, keep = force ? 10 : BEHIND_SECONDS;
    if (sb.buffered.start(0) < t - keep - 5) { try { sb.remove(0, t - keep); } catch {} }
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
    try { this.video.removeAttribute("src"); this.video.load(); } catch {}
    this.input?.dispose(); this.input = null;
    this.source?.dispose(); this.source = null;
    this.tracks = null; this.selectedAudioId = null;
  }
}
