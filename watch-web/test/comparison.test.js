import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRelayServer } from "../server/server.js";

async function fixture(t, password = "") {
  const root = await mkdtemp(path.join(tmpdir(), "watch-comparison-"));
  const distRoot = path.join(root, "dist"), comparisonRoot = path.join(root, "media");
  await Promise.all([mkdir(distRoot), mkdir(comparisonRoot)]);
  await Promise.all([
    writeFile(path.join(distRoot, "index.html"), "watch fixture"),
    writeFile(path.join(distRoot, "comparison.html"), "comparison fixture"),
    writeFile(path.join(comparisonRoot, "dolby-vision.mp4"), "0123456789"),
    writeFile(path.join(comparisonRoot, "hdr10.mp4"), "abcdefghij"),
    writeFile(path.join(comparisonRoot, "unlisted.mp4"), "private fixture"),
  ]);
  const server = createRelayServer({ distRoot, comparisonRoot, password });
  await server.listen(0, "127.0.0.1");
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("comparison page and clips use the existing login and preserve its return URL", async t => {
  const base = await fixture(t, "comparison-password");
  const page = await fetch(`${base}/comparison`, { headers: { accept: "text/html" } });
  assert.match(await page.text(), /type="password"/);
  assert.equal((await fetch(`${base}/comparison/media/dolby-vision.mp4`)).status, 401);
  const login = await fetch(`${base}/login?next=/comparison`, {
    method: "POST", body: new URLSearchParams({ password: "comparison-password" }), redirect: "manual",
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/comparison");
  const headers = { cookie: login.headers.get("set-cookie").split(";")[0] };
  assert.equal(await (await fetch(`${base}/comparison`, { headers })).text(), "comparison fixture");
  assert.equal(await (await fetch(`${base}/comparison/`, { headers })).text(), "comparison fixture");
  assert.equal(await (await fetch(`${base}/`, { headers })).text(), "watch fixture");
  assert.equal(await (await fetch(`${base}/comparison/media/dolby-vision.mp4`, { headers })).text(), "0123456789");
});

test("comparison clips support browser byte ranges and HEAD without serving unlisted files", async t => {
  const base = await fixture(t);
  const url = `${base}/comparison/media/hdr10.mp4`;
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "video/mp4");
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(head.headers.get("accept-ranges"), "bytes");
  assert.equal(await head.text(), "");
  for (const [range, body, contentRange] of [
    ["bytes=2-5", "cdef", "bytes 2-5/10"],
    ["bytes=7-", "hij", "bytes 7-9/10"],
    ["bytes=-3", "hij", "bytes 7-9/10"],
  ]) {
    const res = await fetch(url, { headers: { range } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), contentRange);
    assert.equal(res.headers.get("content-length"), String(body.length));
    assert.equal(await res.text(), body);
  }
  const invalid = await fetch(url, { headers: { range: "bytes=20-" } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */10");
  assert.equal((await fetch(`${base}/comparison/media/unlisted.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/comparison/media/missing.mp4`)).status, 404);
});
