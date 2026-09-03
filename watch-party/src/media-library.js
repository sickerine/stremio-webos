import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function mediaKey(mediaUrl) {
  return createHash("sha256").update(mediaUrl).digest("hex").slice(0, 24);
}

export function createMediaLibrary({ jellyfin, mediaRoot = "/media", pollIntervalMs = 500, maxPolls = 120 }) {
  async function importStream(state) {
    const key = mediaKey(state.mediaUrl);
    const filename = `${key}.strm`;
    const finalPath = path.join(mediaRoot, filename);
    const temporaryPath = `${finalPath}.tmp`;
    const contents = `${state.mediaUrl}\n`;

    await mkdir(mediaRoot, { recursive: true });
    let unchanged = false;
    try { unchanged = await readFile(finalPath, "utf8") === contents; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if (unchanged) {
      const existingItem = await jellyfin.findItemByPath(finalPath);
      if (existingItem) return existingItem;
    } else {
      await writeFile(temporaryPath, contents, "utf8");
      await rename(temporaryPath, finalPath);
    }
    await jellyfin.refreshLibrary();

    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const item = await jellyfin.findItemByPath(finalPath);
      if (item) return item;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Jellyfin did not index ${filename}`);
  }

  return { importStream };
}
