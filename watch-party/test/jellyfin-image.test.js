import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const readProjectFile = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the Jellyfin image pins and verifies the official subtitle extractor", async () => {
  const dockerfile = await readProjectFile("jellyfin/Dockerfile");
  assert.match(dockerfile, /FROM jellyfin\/jellyfin:10\.11\.11/);
  assert.match(dockerfile, /SUBTITLE_EXTRACT_RELEASE=v7/);
  assert.match(dockerfile, /SUBTITLE_EXTRACT_VERSION=7\.0\.0\.0/);
  assert.match(dockerfile, /1e7c5f0d97b22cbf6a9a71274321202abc28a1f901a9e1bfad11388b3f1373d2/);
  assert.match(dockerfile, /sha256sum -c -/);
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
  assert.match(compose, /stremio-watch-party-jellyfin:10\.11\.11-subtitle-extract-v7/);
});
