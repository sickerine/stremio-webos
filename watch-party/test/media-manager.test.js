import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createMediaManager } from "../src/media-manager.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {
    force: true,
    recursive: true,
  })));
});

test("media manager publishes a playable HLS session near the TV playhead", async () => {
  const mediaRoot = await mkdtemp(path.join(tmpdir(), "watch-party-media-"));
  temporaryDirectories.push(mediaRoot);
  const spawned = [];
  let killed = false;

  function spawnProcess(command, args) {
    const process = new EventEmitter();
    process.stderr = new EventEmitter();
    process.kill = () => { killed = true; };
    spawned.push({ command, args });

    queueMicrotask(async () => {
      const output = args.at(-1);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, "#EXTM3U\n#EXT-X-VERSION:3\n");
    });
    return process;
  }

  const manager = createMediaManager({ mediaRoot, pollIntervalMs: 5, spawnProcess });
  const updates = [];
  manager.prepare({
    sessionId: "bleach episode 3",
    mediaUrl: "https://media.example/bleach.mkv",
    positionSeconds: 36,
  }, media => updates.push(media));

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HLS session did not become ready")), 500);
    const poll = () => {
      if (updates.some(update => update.status === "ready")) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });

  assert.equal(updates[0].status, "preparing");
  assert.equal(updates.at(-1).status, "ready");
  assert.equal(updates.at(-1).offsetSeconds, 24);
  assert.match(updates.at(-1).playbackUrl, /^\/media\/[a-f0-9]{24}\/master\.m3u8$/);
  assert.equal(spawned[0].command, "ffmpeg");
  assert.deepEqual(spawned[0].args.slice(0, 4), ["-nostdin", "-hide_banner", "-loglevel", "warning"]);
  assert.ok(spawned[0].args.includes("24"));
  assert.ok(spawned[0].args.includes("https://media.example/bleach.mkv"));

  await manager.close();
  assert.equal(killed, true);
});
