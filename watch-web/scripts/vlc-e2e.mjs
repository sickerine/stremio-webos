// End-to-end check of the VLC follower (server/vlc-follow.ps1) with no TV and no CDN: ffmpeg
// makes two short files, a relay and a fake TV run in this process, and real VLC on a
// Windows machine has to follow them. The follower is the file the watch page hands out.
// Needs ffmpeg here and VLC on the Windows side.
//   node scripts/vlc-e2e.mjs                on Windows
//   SSH=<host> node scripts/vlc-e2e.mjs     from another machine: VLC runs on <host> over SSH
//   HOST=<address>   this machine as the Windows side reaches it (default: the address the SSH host sees)
//   SHOW=1           VLC's real window and sound instead of hidden outputs
//   DEBUG=1          the follower logs every reading to %TEMP%\watch-party-vlc\follow.log
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRelayServer } from "../server/server.js";
import { fakeTv, serveMedia } from "./e2e-rig.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const host = process.env.HOST || (process.env.SSH ? String(execFileSync("ssh", [process.env.SSH, "echo %SSH_CLIENT%"])).trim().split(" ")[0] : "127.0.0.1");
const dir = mkdtempSync(path.join(tmpdir(), "watch-vlc-e2e-"));
const make = (name, source, seconds) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${source}=s=1280x720:r=24`, "-f", "lavfi", "-i", "sine=f=440:b=4:r=48000",
  "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "1500k", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", path.join(dir, name)]);
make("first.mkv", "testsrc2", 300); make("second.mkv", "testsrc", 120);

const media = await serveMedia(dir, "0.0.0.0");
const password = "e2e", cookie = `watch_auth=${createHash("sha256").update(`watch-web cookie:${password}`).digest("hex")}`;
// A report is the follower's own reading of VLC (`t` seconds at relay time `at`). The gap is
// worked out here, on arrival, against the fake TV's clock, not taken from the follower.
const reports = [], log = console.log;
let tv = null;
console.log = (...a) => {
  const m = /^\[netlog\] \S+ (\{.*)$/.exec(String(a[0])); if (!m) return;
  try { const r = JSON.parse(m[1]); reports.push({ ...r, seen: Date.now(), gap: r.t == null ? null : r.t - tv.positionAt(r.at) }); } catch {}
};
// The relay would otherwise open the stream itself to follow redirects; only VLC's connections count here.
const relay = createRelayServer({ password, tvKey: "", resolve: async url => ({ url, size: null }) });
await relay.listen(0, "0.0.0.0");
const origin = `http://${host}:${relay.address().port}`, room = "vlc-e2e";
const url = name => `http://${host}:${media.port}/${name}`;
tv = fakeTv({ origin: `http://127.0.0.1:${relay.address().port}`, room, mediaUrl: url("first.mkv"), title: "first.mkv", position: 20 });

// The file a viewer downloads, run with hidden outputs unless SHOW=1.
const launcher = path.join(dir, "watch-vlc-e2e.cmd");
writeFileSync(launcher, Buffer.from(await (await fetch(`${origin}/vlc.cmd?room=${room}`, { headers: { cookie } })).arrayBuffer()));
if (process.env.SSH) execFileSync("scp", ["-q", launcher, `${process.env.SSH}:watch-vlc-e2e.cmd`]);
// The window title is this run's mark on its VLC, so stopping it cannot hit anyone else's.
const mark = `watch-vlc-e2e-${process.pid}-${Date.now().toString(36)}`;
const hidden = (process.env.DEBUG === "1" ? 'set "WATCH_DEBUG=1" && ' : "") + `set "WATCH_VLC_ARGS=--video-title=${mark}${process.env.SHOW === "1" ? "" : " --intf=dummy --dummy-quiet --vout=dummy --aout=dummy"}" && `;
const line = `${hidden}"${process.env.SSH ? "watch-vlc-e2e.cmd" : launcher}" < nul`;
const follower = process.env.SSH ? spawn("ssh", [process.env.SSH, line], { stdio: ["ignore", "pipe", "pipe"] }) : spawn(line, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
let output = ""; follower.stdout.on("data", d => (output += d)); follower.stderr.on("data", d => (output += d));
// Stops only the VLC this run started; its follower ends by itself once VLC is gone.
const stopFollower = () => {
  const kill = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='vlc.exe'\\" | Where-Object { $_.CommandLine -match '${mark}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Remove-Item watch-vlc-e2e.cmd -ErrorAction SilentlyContinue"`;
  try { process.env.SSH ? execFileSync("ssh", [process.env.SSH, kill], { stdio: "ignore" }) : execFileSync(kill, { shell: true, stdio: "ignore" }); } catch {}
  follower.kill();
};

async function report(seconds, what, accept, since = Date.now()) {
  for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(200)) {
    const found = reports.find(r => r.seen >= since && accept(r));
    if (found) return { ...found, took: (found.seen - since) / 1000 };
  }
  assert.fail(`${what}: not within ${seconds} s. Last reports: ${JSON.stringify(reports.slice(-3))}\nFollower output: ${output.slice(-600)}`);
}
const playingInSync = r => r.status === "playing" && Math.abs(r.gap) < 0.1;

let failed = false;
try {
  await tv.ready;
  const start = await report(60, "start", playingInSync);
  log(`ok  starts and reaches the TV (first in-sync report after ${start.took.toFixed(0)} s)`);

  const from = Date.now(); await sleep(20000);
  const steady = reports.filter(r => r.seen > from && r.status === "playing");
  assert.ok(steady.length >= 3, `expected a report every 5 s, got ${steady.length}`);
  // gapMs is the follower's own estimate; the check is on the gap worked out here.
  const seen = steady.map(r => Math.abs(r.gap) * 1000), worst = Math.max(...seen, ...steady.map(r => r.maxMs));
  assert.ok(worst < 60, `drifted while playing: ${JSON.stringify(steady)}`);
  log(`ok  holds for 20 s (gap ${seen.map(g => g.toFixed(0)).join(", ")} ms at each report, worst the follower saw ${Math.max(...steady.map(r => r.maxMs))} ms)`);

  let at = Date.now(); await tv.skip(60);
  log(`ok  follows a 60 s skip (in sync again after ${(await report(25, "after a skip", playingInSync, at)).took.toFixed(0)} s)`);

  at = Date.now(); tv.setPaused(true);
  // VLC waits a little past the TV's frame (what the TV covers before VLC can start on the news that it plays again).
  const parked = await report(12, "pause", r => r.status === "paused" && r.gap > -0.08 && r.gap < 0.3, at);
  at = Date.now(); tv.setPaused(false);
  log(`ok  pauses with the TV (${(parked.gap * 1000).toFixed(0)} ms past its frame) and resumes (in sync after ${(await report(15, "resume", playingInSync, at)).took.toFixed(0)} s)`);

  at = Date.now(); tv.setLoading(true); await sleep(4000); tv.setLoading(false);
  log(`ok  waits while the TV is loading (in sync after ${(await report(15, "after the TV loaded", playingInSync, at + 4000)).took.toFixed(0)} s)`);

  at = Date.now(); tv.open({ mediaUrl: url("second.mkv"), title: "second.mkv" }, 10);
  log(`ok  follows the next episode (in sync after ${(await report(40, "next episode", playingInSync, at)).took.toFixed(0)} s)`);

  at = Date.now(); tv.idle();
  await report(10, "TV stopped", r => r.status === "idle", at);
  log(`ok  stops when the TV does`);
  const c = media.connections;
  log(`    VLC opened ${c.total} connections to the file server, at most ${c.mostOpen} at once; more than one was open for ${c.overlapMs} ms in all, ${c.longestOverlapMs} ms at the longest`);
  assert.ok(c.longestOverlapMs < 3000, "VLC kept several connections open at once: the TorBox CDN bans that");
} catch (error) { failed = true; log(`FAIL ${error.message}`); }
finally { stopFollower(); tv.close(); await relay.close(); media.close(); rmSync(dir, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
