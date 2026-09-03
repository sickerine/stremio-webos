import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const SEGMENT_SECONDS = 4;

function mediaKey(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function startOffset(positionSeconds) {
  const behindPlayhead = Math.max(0, positionSeconds - 12);
  return Math.floor(behindPlayhead / SEGMENT_SECONDS) * SEGMENT_SECONDS;
}

export function createMediaManager(options = {}) {
  const mediaRoot = options.mediaRoot || process.env.MEDIA_ROOT || "/data/media";
  const ffmpegBin = options.ffmpegBin || process.env.FFMPEG_BIN || "ffmpeg";
  const pollIntervalMs = options.pollIntervalMs || 250;
  const spawnProcess = options.spawnProcess || spawn;
  const records = new Map();

  function prepare(state, publish) {
    const key = mediaKey(state.sessionId);
    const directory = path.join(mediaRoot, key);
    const playlistPath = path.join(directory, "master.m3u8");
    const segmentPath = path.join(directory, "segment-%06d.ts");
    const offsetSeconds = startOffset(state.positionSeconds);
    const media = {
      status: "preparing",
      sessionId: state.sessionId,
      playbackUrl: `/media/${key}/master.m3u8`,
      offsetSeconds,
    };
    const record = {
      cancelled: false,
      child: null,
      directory,
      interval: null,
      publishedReady: false,
    };
    records.set(state.sessionId, record);

    publish(media);

    void (async () => {
      await rm(directory, { force: true, recursive: true });
      await mkdir(directory, { recursive: true });
      if (record.cancelled) {
        await rm(directory, { force: true, recursive: true });
        return;
      }

      const args = [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-ss",
        String(offsetSeconds),
        "-user_agent",
        "Stremio-Watch-Party/0.1",
        "-i",
        state.mediaUrl,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        process.env.FFMPEG_PRESET || "veryfast",
        "-crf",
        process.env.FFMPEG_CRF || "21",
        "-pix_fmt",
        "yuv420p",
        "-force_key_frames",
        `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        String(SEGMENT_SECONDS),
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_filename",
        segmentPath,
        playlistPath,
      ];
      const child = spawnProcess(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"] });
      record.child = child;
      let errorOutput = "";

      child.stderr?.on("data", chunk => {
        errorOutput = (errorOutput + chunk.toString()).slice(-4000);
      });

      const publishReady = () => {
        if (record.cancelled || record.publishedReady || !existsSync(playlistPath)) return;
        record.publishedReady = true;
        publish({ ...media, status: "ready" });
      };
      record.interval = setInterval(publishReady, pollIntervalMs);
      publishReady();

      child.once("error", error => {
        clearInterval(record.interval);
        record.interval = null;
        record.child = null;
        if (!record.cancelled) publish({ ...media, status: "error", error: error.message });
      });
      child.once("close", code => {
        clearInterval(record.interval);
        record.interval = null;
        publishReady();
        record.child = null;
        if (!record.cancelled && code && !record.publishedReady) {
          publish({
            ...media,
            status: "error",
            error: errorOutput.trim() || `FFmpeg exited with code ${code}`,
          });
        }
      });
    })().catch(error => {
      publish({ ...media, status: "error", error: error.message });
    });
  }

  function release(sessionId) {
    const record = records.get(sessionId);
    if (!record) return;
    record.cancelled = true;
    clearInterval(record.interval);
    if (record.child) record.child.kill("SIGTERM");
    records.delete(sessionId);
    void rm(record.directory, { force: true, recursive: true });
  }

  function close() {
    for (const record of records.values()) {
      record.cancelled = true;
      clearInterval(record.interval);
      if (record.child) record.child.kill("SIGTERM");
    }
    records.clear();
  }

  return { close, prepare, release };
}
