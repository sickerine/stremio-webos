import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createMediaLibrary } from "../src/media-library.js";

const temporaryDirectories = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

test("media library atomically publishes a strm without deleting an active queued stream", async () => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "watch-party-library-"));
  temporaryDirectories.push(mediaRoot);
  await writeFile(path.join(mediaRoot, "obsolete.strm"), "https://old.example/video.mkv\n");
  let indexedPath = "";
  let polls = 0;
  const jellyfin = {
    refreshLibrary: async () => {},
    findItemByPath: async itemPath => {
      indexedPath = itemPath;
      polls += 1;
      return polls === 2 ? { Id: "indexed-item" } : null;
    },
  };
  const library = createMediaLibrary({ jellyfin, mediaRoot, pollIntervalMs: 1, maxPolls: 3 });
  const item = await library.importStream({ mediaUrl: "https://torbox.example/real.mkv" });

  assert.equal(item.Id, "indexed-item");
  assert.equal(await readFile(indexedPath, "utf8"), "https://torbox.example/real.mkv\n");
  assert.deepEqual((await readdir(mediaRoot)).sort(), [path.basename(indexedPath), "obsolete.strm"].sort());
});
