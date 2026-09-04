import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// Thin media pipeline. The whole thesis of watch-lite lives here:
//   - anime torrent releases are overwhelmingly H.264 8-bit + AAC, which browsers
//     play natively, so we REMUX (-c copy) instead of transcoding. Copy runs at
//     ~60x realtime, so the first segment (and the subtitle segment beside it) is
//     ready in ~7s against a real TorBox stream, and the whole episode follows fast.
//   - only genuinely incompatible video (HEVC / 10-bit / VP9 / AV1) is transcoded,
//     and only then does CPU matter.
// ponytail: subtitles ship as WebVTT (dialogue, perfect timing, no ASS typesetting).
//   Upgrade path for signs/positioning: reuse service/mkv-subs.js + JASSUB in the
//   browser, same as the TV. Named ceiling, not an accident.

const SEGMENT_SECONDS = 4;
const LOOKBACK_SECONDS = 15;

const COPYABLE_VIDEO = new Set(["h264"]);
const COPYABLE_VIDEO_PIXFMT = new Set(["yuv420p", "yuvj420p"]);
const COPYABLE_AUDIO = new Set(["aac", "mp3"]);

function mediaKey(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function startOffset(positionSeconds) {
  const behind = Math.max(0, positionSeconds - LOOKBACK_SECONDS);
  return Math.floor(behind / SEGMENT_SECONDS) * SEGMENT_SECONDS;
}

function runProbe(ffprobeBin, url, userAgent) {
  return new Promise(resolve => {
    const args = [
      "-v", "error",
      "-user_agent", userAgent,
      "-rw_timeout", "30000000",
      "-print_format", "json",
      "-show_entries", "stream=index,codec_type,codec_name,pix_fmt:stream_tags=language",
      url,
    ];
    const child = spawn(ffprobeBin, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk.toString(); });
    child.once("error", () => resolve(null));
    child.once("close", code => {
      if (code) return resolve(null);
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
  });
}

// Decide copy vs transcode and pick the subtitle track. Pure, so it is unit-tested.
export function planFromProbe(probe, { preferLanguage = "eng" } = {}) {
  const streams = probe?.streams || [];
  const video = streams.find(s => s.codec_type === "video");
  const audio = streams.find(s => s.codec_type === "audio");
  const subs = streams.filter(s => s.codec_type === "subtitle");

  const copyVideo = Boolean(video)
    && COPYABLE_VIDEO.has(video.codec_name)
    && (!video.pix_fmt || COPYABLE_VIDEO_PIXFMT.has(video.pix_fmt));
  const copyAudio = Boolean(audio) && COPYABLE_AUDIO.has(audio.codec_name);

  const preferred = subs.find(s => (s.tags?.language || "").toLowerCase().startsWith(preferLanguage));
  const subtitle = preferred || subs[0] || null;

  return {
    copyVideo,
    copyAudio,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    subtitleIndex: subtitle ? subtitle.index : null,
    // if probe failed entirely we still try a copy; ffmpeg will tell us if it can't
    probed: Boolean(probe),
  };
}

// One ffmpeg process: video+audio HLS plus a SEGMENTED WebVTT subtitle rendition.
// Segmented (via var_stream_map) means subtitle cues stream out per 4s segment
// instead of only at process end, so subs appear the moment video does. copyVideo/
// copyAudio default true (optimistic): we start this BEFORE the probe returns,
// because the probe and the ffmpeg seek are two separate TorBox round-trips and
// running them serially is where the old ~12s went. On the rare incompatible codec
// the probe triggers exactly one restart.
// ffmpeg's own master playlist omits the video EXT-X-STREAM-INF line (upstream
// bug), so we write the master ourselves; ffmpeg only writes the variant lists.
function combinedArgs({ copyVideo, copyAudio, withSubtitle, subtitleMap }, ctx) {
  const { url, userAgent, offsetSeconds, dir, vcodec } = ctx;
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  if (offsetSeconds > 0) args.push("-ss", String(offsetSeconds));
  args.push("-user_agent", userAgent, "-rw_timeout", "30000000", "-i", url, "-map", "0:v:0", "-map", "0:a:0?");
  if (copyVideo) args.push("-c:v", "copy");
  else {
    args.push("-c:v", vcodec, "-b:v", process.env.WATCH_LITE_VBITRATE || "6M", "-pix_fmt", "yuv420p",
      "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`);
    if (vcodec === "libx264") args.push("-preset", "veryfast");
  }
  args.push("-c:a", copyAudio ? "copy" : "aac");
  if (!copyAudio) args.push("-b:a", "192k", "-ac", "2");

  let varMap = "v:0,a:0";
  if (withSubtitle) {
    args.push("-map", subtitleMap, "-c:s", "webvtt");
    varMap = "v:0,a:0,s:0,sgroup:subs";
  }
  args.push("-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_list_size", "0",
    "-hls_playlist_type", "event", "-hls_flags", "independent_segments+temp_file",
    "-var_stream_map", varMap, "-master_pl_name", "ffmaster.m3u8",
    "-hls_segment_filename", path.join(dir, "stream_%v_%06d.ts"), path.join(dir, "stream_%v.m3u8"));
  return args;
}

export function masterPlaylist({ withSubtitle }) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:6"];
  if (withSubtitle) {
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="stream_0_vtt.m3u8"');
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=8000000,SUBTITLES="subs"');
  } else {
    lines.push("#EXT-X-STREAM-INF:BANDWIDTH=8000000");
  }
  lines.push("stream_0.m3u8", "");
  return lines.join("\n");
}

export function createMediaManager(options = {}) {
  const mediaRoot = options.mediaRoot || process.env.MEDIA_ROOT || "/tmp/watch-lite-media";
  const ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg";
  const ffprobeBin = options.ffprobeBin || process.env.FFPROBE_BIN || "ffprobe";
  const vcodec = options.vcodec || process.env.WATCH_LITE_VCODEC || "h264_videotoolbox";
  const userAgent = options.userAgent || "Stremio-Watch-Lite/1.0";
  const pollIntervalMs = options.pollIntervalMs || 250;
  const spawnProcess = options.spawnProcess || spawn;
  const probe = options.probe || (url => runProbe(ffprobeBin, url, userAgent));
  const records = new Map();

  function prepare(state, publish) {
    const key = mediaKey(state.sessionId);
    const directory = path.join(mediaRoot, key);
    const streamPlaylist = path.join(directory, "stream_0.m3u8");
    const masterPath = path.join(directory, "master.m3u8");
    const offsetSeconds = startOffset(state.positionSeconds);
    const ctx = { url: state.mediaUrl, userAgent, offsetSeconds, dir: directory, vcodec };
    const media = { status: "preparing", sessionId: state.sessionId, playbackUrl: `/media/${key}/master.m3u8`, offsetSeconds };
    const record = { cancelled: false, child: null, directory, interval: null, publishedReady: false, finalized: false };
    records.set(state.sessionId, record);
    publish(media);

    const publishReady = () => {
      if (record.cancelled || record.publishedReady || !existsSync(streamPlaylist)) return;
      record.publishedReady = true;
      publish({ ...media, status: "ready" });
    };

    const writeMaster = plan => writeFileSync(masterPath, masterPlaylist(plan));

    const start = plan => {
      writeMaster(plan);
      const child = spawnProcess(ffmpegBin, combinedArgs(plan, ctx), { stdio: ["ignore", "ignore", "pipe"] });
      record.child = child;
      let errorOutput = "";
      child.stderr?.on("data", chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
      child.once("error", error => { if (!record.cancelled && record.finalized) publish({ ...media, status: "error", error: error.message }); });
      child.once("close", code => {
        if (record.child !== child) return; // superseded by a restart
        publishReady();
        record.child = null;
        if (!record.cancelled && record.finalized && code && !record.publishedReady) {
          publish({ ...media, status: "error", error: errorOutput.trim() || `FFmpeg exited ${code}` });
        }
      });
    };

    void (async () => {
      await rm(directory, { force: true, recursive: true });
      await mkdir(directory, { recursive: true });
      if (record.cancelled) { await rm(directory, { force: true, recursive: true }); return; }

      // Optimistic: copy + first subtitle track (0:s:0 = first subtitle by type),
      // started NOW in parallel with probe.
      const optimistic = { copyVideo: true, copyAudio: true, withSubtitle: true, subtitleMap: "0:s:0" };
      start(optimistic);
      record.interval = setInterval(publishReady, pollIntervalMs);

      const plan = planFromProbe(await probe(state.mediaUrl));
      if (record.cancelled) return;

      const final = plan.probed
        ? { copyVideo: plan.copyVideo, copyAudio: plan.copyAudio, withSubtitle: plan.subtitleIndex != null, subtitleMap: `0:${plan.subtitleIndex}` }
        : optimistic;
      const changed = final.copyVideo !== optimistic.copyVideo
        || final.copyAudio !== optimistic.copyAudio
        || final.withSubtitle !== optimistic.withSubtitle;
      // Only a codec/has-subs mismatch is worth a restart; a different sub index is not.
      if (changed && !record.publishedReady) {
        try { record.child?.kill("SIGKILL"); } catch {}
        record.child = null;
        await rm(directory, { force: true, recursive: true });
        await mkdir(directory, { recursive: true });
        if (record.cancelled) return;
        record.finalized = true;
        start(final);
      } else {
        record.finalized = true;
        publishReady();
      }
    })().catch(error => publish({ ...media, status: "error", error: error.message }));
  }

  function killChildren(record) {
    try { record.child?.kill("SIGTERM"); } catch {}
  }

  function release(sessionId) {
    const record = records.get(sessionId);
    if (!record) return;
    record.cancelled = true;
    clearInterval(record.interval);
    killChildren(record);
    records.delete(sessionId);
    void rm(record.directory, { force: true, recursive: true });
  }

  function close() {
    for (const record of records.values()) {
      record.cancelled = true;
      clearInterval(record.interval);
      killChildren(record);
    }
    records.clear();
  }

  return { close, prepare, release, planFromProbe };
}
