import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const H264_HLS_PROFILES = 'H.push("h264"),G.push("h264"),W.push("h264")';
const H264_TS_PROFILE = 'H.push("h264"),G.push("h264")';

function replaceExactlyOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected exactly one Jellyfin Web HLS profile pattern: ${before}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

export function preferTsForH264(source) {
  return replaceExactlyOnce(source, H264_HLS_PROFILES, H264_TS_PROFILE);
}

async function main(webRoot) {
  const bundlePath = path.join(webRoot, "main.jellyfin.bundle.js");
  const source = await readFile(bundlePath, "utf8");
  await writeFile(bundlePath, preferTsForH264(source), "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const webRoot = process.argv[2];
  if (!webRoot) throw new Error("Usage: patch-hls-profile.mjs <jellyfin-web-directory>");
  await main(webRoot);
}
