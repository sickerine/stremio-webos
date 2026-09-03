import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { preferTsForH264 } from "../jellyfin/patch-hls-profile.mjs";

const readProjectFile = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the Jellyfin image pins and verifies the official subtitle extractor", async () => {
  const dockerfile = await readProjectFile("jellyfin/Dockerfile");
  assert.match(dockerfile, /FROM jellyfin\/jellyfin:10\.11\.11/);
  assert.match(dockerfile, /SUBTITLE_EXTRACT_RELEASE=v7/);
  assert.match(dockerfile, /SUBTITLE_EXTRACT_VERSION=7\.0\.0\.0/);
  assert.match(dockerfile, /1e7c5f0d97b22cbf6a9a71274321202abc28a1f901a9e1bfad11388b3f1373d2/);
  assert.match(dockerfile, /sha256sum -c -/);
});

test("H264 uses seekable TS HLS while HEVC and AV1 retain fMP4 support", async () => {
  const [dockerfile, compose] = await Promise.all([
    readProjectFile("jellyfin/Dockerfile"),
    readProjectFile("compose.yaml"),
  ]);
  const bundledCode = 'W.push("av1"),W.push("hevc"),H.push("h264"),G.push("h264"),W.push("h264"),W.push("vp9")';
  const patched = preferTsForH264(bundledCode);

  assert.match(patched, /W\.push\("av1"\)/);
  assert.match(patched, /W\.push\("hevc"\)/);
  assert.match(patched, /G\.push\("h264"\)/);
  assert.doesNotMatch(patched, /W\.push\("h264"\)/);
  assert.match(patched, /W\.push\("vp9"\)/);
  assert.match(dockerfile, /RUN node \/tmp\/patch-hls-profile\.mjs \/jellyfin-web/);
  assert.match(compose, /stremio-watch-party-jellyfin:10\.11\.11-watch-v1/);
});

test("Jellyfin pre-extracts text subtitles and attachments during stream scans", async () => {
  const [configuration, entrypoint, compose] = await Promise.all([
    readProjectFile("jellyfin/subtitle-extract.xml"),
    readProjectFile("jellyfin/entrypoint.sh"),
    readProjectFile("compose.yaml"),
  ]);

  assert.match(configuration, /<ExtractionDuringLibraryScan>true<\/ExtractionDuringLibraryScan>/);
  assert.match(configuration, /<IncludeTextSubtitles>true<\/IncludeTextSubtitles>/);
  assert.match(configuration, /<IncludeGraphicalSubtitles>false<\/IncludeGraphicalSubtitles>/);
  assert.match(entrypoint, /Jellyfin\.Plugin\.SubtitleExtract\.dll/);
  assert.match(entrypoint, /exec \/jellyfin\/jellyfin/);
  assert.match(compose, /build: \.\/jellyfin/);
  assert.match(compose, /stremio-watch-party-jellyfin:10\.11\.11-watch-v1/);
});
