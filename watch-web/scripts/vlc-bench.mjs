// Benchmark of the VLC follower (server/vlc-follow.ps1): how long each kind of disturbance takes
// to settle, under different networks. A relay and a fake TV run here; real VLC runs on a
// Windows machine with hidden outputs. The gap is VLC's own position reading set against
// where the fake TV really was at that moment, not against what the follower believed.
//   node scripts/vlc-bench.mjs [profile ...]                 on Windows
//   SSH=<host> node scripts/vlc-bench.mjs [profile ...]      VLC on <host> over SSH
//   KEEP=<folder>    keep each run's follower log there
// Profiles (default: all): lan   nothing in the way
//                          cdn   the stream answers 250 ms late at 2 MB/s, the relay is 40 ms away
//                          slow  the stream answers 1 s late at 600 kB/s (three times the bitrate)
//                          wan   the relay is 150 ms away give or take 60, and the TV reports noisily and late
// And on request only, the real thing: the fake TV joins a running relay and "plays" real streams.
//   live   needs LIVE=<the relay as the viewer reaches it, e.g. https://watch.example>, WATCH_PASSWORD,
//          TV_KEY, FIRST and SECOND (two stream links as the TV would report them);
//          LIVE_LOCAL=<the relay as this machine reaches it> and EPISODE=<an episode id> are optional
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRelayServer } from "../server/server.js";
import { delayProxy, fakeTv, serveMedia } from "./e2e-rig.mjs";

const PROFILES = {
  lan: {},
  cdn: { media: { firstByteMs: 250, bytesPerSecond: 2e6 }, relay: { ms: 40, jitterMs: 10 } },
  slow: { media: { firstByteMs: 1000, bytesPerSecond: 6e5 }, relay: { ms: 40, jitterMs: 10 } },
  wan: { relay: { ms: 150, jitterMs: 60 }, tv: { noiseMs: 12, lateMs: 80 } },
  live: { live: true },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ssh = process.env.SSH, log = console.log;
const run = (command, ms = 30000) => new Promise(resolve => {
  const child = ssh ? spawn("ssh", [ssh, command]) : spawn(command, { shell: true });
  let out = ""; child.stdout.on("data", d => (out += d)); child.stderr.on("data", d => (out += d));
  const timer = setTimeout(() => child.kill(), ms); child.on("close", () => { clearTimeout(timer); resolve(out); });
});
const host = process.env.HOST || (ssh ? String(execFileSync("ssh", [ssh, "echo %SSH_CLIENT%"])).trim().split(" ")[0] : "127.0.0.1");
const dir = mkdtempSync(path.join(tmpdir(), "watch-vlc-bench-"));
const make = (name, source, seconds) => execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${source}=s=1280x720:r=24`, "-f", "lavfi", "-i", "sine=f=440:b=4:r=48000",
  "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "1500k", "-g", "48", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", path.join(dir, name)]);
make("first.mkv", "testsrc2", 600); make("second.mkv", "testsrc", 120); make("other.mkv", "smptebars", 60);

// The Windows side of a run. `clock` pairs that machine's clock with this one's; the rest is
// what a viewer's click does, done through VLC's own control page and stamped as it is sent.
const VIEWER = `param([string]$Do, [string]$Arg)
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
Add-Type -AssemblyName System.Net.Http
$http = New-Object Net.Http.HttpClient
function Stamp { ([DateTime]::UtcNow.Ticks - 621355968000000000) / 10000.0 }
$out = Join-Path $env:TEMP 'watch-party-vlc\\bench.log'
if ($Do -eq 'clock') {
  $best = $null
  for ($i = 0; $i -lt 12; $i++) { $a = Stamp; $there = [double]$http.GetStringAsync($Arg).GetAwaiter().GetResult(); $b = Stamp; if ($i -gt 1 -and (-not $best -or $b - $a -lt $best.rtt)) { $best = @{ rtt = $b - $a; ahead = $there - ($a + $b) / 2 } } }
  Add-Content -Path $out -Value ('{0:0} clock {1:0.0} {2:0.0}' -f (Stamp), $best.ahead, $best.rtt); return
}
$vlc = Get-CimInstance Win32_Process -Filter "Name='vlc.exe'" | Where-Object { $_.CommandLine -match $env:WATCH_BENCH_MARK } | Select-Object -First 1
if (-not $vlc) { 'no VLC'; return }
$port = [regex]::Match($vlc.CommandLine, '--http-port=(\\d+)').Groups[1].Value; $secret = [regex]::Match($vlc.CommandLine, '--http-password=(\\w+)').Groups[1].Value
$http.DefaultRequestHeaders.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue ('Basic', [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes(":$secret")))
function Ask([string]$q) { $http.GetStringAsync("http://127.0.0.1:$port/follow.txt$q").GetAwaiter().GetResult().Trim() }
$t = [double]((Ask '') -split ' ')[0]
$query = switch ($Do) { 'pause' { '?pause=1' } 'seek' { '?t=' + [long]($t + 60e6) } 'speed' { '?rate=15000' } 'stop' { '?stop=1' } 'other' { '?open=' + [Uri]::EscapeDataString($Arg) } }
$now = Stamp; [void](Ask $query)
Add-Content -Path $out -Value ('{0:0} viewer {1}' -f $now, $Do)
`;

// The follower's debug log and the viewer script's notes, as rows in time order (ms on the Windows clock).
function parse(text) {
  const rows = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    const at = Number(line.slice(0, line.indexOf(" "))), rest = line.slice(line.indexOf(" ") + 1);
    if (!at) continue;
    const edge = /^edge t=([\d.]+) read ([\d.]+)\.\.([\d.]+)/.exec(rest);
    // A refresh caught between two readings far apart says little about the gap: left out.
    if (edge && edge[3] - edge[2] > 30) continue;
    rows.push(edge ? { at, t: Number(edge[1]), read: (Number(edge[2]) + Number(edge[3])) / 2 } : { at, text: rest });
  }
  return rows.sort((a, b) => a.at - b.at);
}
// VLC plays without a break from the last of these on.
const BREAK = /^(let go|park|open at|wait at|paused at|found at|stopped|another|stalled|never|the viewer)/;
// Seconds from `from` until the gap is within `limit` ms for good: the first reading after
// VLC's last break and its last reading outside the limit, provided readings then keep
// coming to the end of the step (`until`), never more than two seconds apart (pairing the
// clocks again after a dropped connection leaves about one without a close reading). 0 if
// VLC never left the limit; null if it never settled.
function settles(rows, from, until, limit) {
  const inStep = rows.filter(r => r.at >= from && r.at < until);
  const lastBreak = inStep.findLast(r => r.text && BREAK.test(r.text))?.at;
  const edges = inStep.filter(r => r.gap != null && r.at >= (lastBreak ?? from)), bad = edges.findLastIndex(r => Math.abs(r.gap) > limit);
  const good = edges.slice(bad + 1);
  if (good.length < 3 || until - good[good.length - 1].at > 2000 || good.some((e, i) => i && e.at - good[i - 1].at > 2000)) return null;
  return bad < 0 && lastBreak == null ? 0 : (good[0].at - from) / 1000;
}
// The value at `x` of a line through `points` ({ at, v }, in order), held flat beyond its ends.
function along(points, x) {
  const i = points.findIndex(p => p.at >= x);
  if (i <= 0) return (i < 0 ? points[points.length - 1] : points[0]).v;
  const a = points[i - 1], b = points[i];
  return a.v + (b.v - a.v) * (x - a.at) / (b.at - a.at);
}
const seconds = v => (v == null ? "  never" : v.toFixed(1).padStart(5) + " s");

async function bench(name) {
  const profile = PROFILES[name], room = `bench-${name}`;
  const media = await serveMedia(dir, "0.0.0.0", profile.media);
  const live = profile.live ? process.env : null;
  const password = live ? live.WATCH_PASSWORD : "bench", cookie = `watch_auth=${createHash("sha256").update(`watch-web cookie:${password}`).digest("hex")}`;
  // The relay would otherwise open the stream itself to follow redirects; only VLC's connections count here.
  const relay = live ? null : createRelayServer({ password, tvKey: "", resolve: async url => ({ url, size: null }) });
  await relay?.listen(0, "0.0.0.0");
  const hop = relay && await delayProxy(relay.address().port, profile.relay);
  const url = file => `http://${host}:${media.port}/${file}`;
  const first = live ? live.FIRST : url("first.mkv"), second = live ? live.SECOND : url("second.mkv"), from = live ? 300 : 30;
  const tv = fakeTv({ origin: live ? live.LIVE_LOCAL || live.LIVE : `http://127.0.0.1:${relay.address().port}`, key: live?.TV_KEY, room, mediaUrl: first, title: "first", episodeId: live?.EPISODE, position: from, ...profile.tv });
  await tv.ready;
  const mark = `watch-vlc-bench-${process.pid}-${name}`;
  const launcher = path.join(dir, "watch-vlc-bench.cmd"), script = path.join(dir, "watch-vlc-bench-viewer.ps1");
  writeFileSync(launcher, Buffer.from(await (await fetch(`${live ? live.LIVE : `http://${host}:${hop.port}`}/vlc.cmd?room=${room}`, { headers: { cookie } })).arrayBuffer()));
  writeFileSync(script, VIEWER.replace(/\n/g, "\r\n"));
  if (ssh) for (const file of [launcher, script]) execFileSync("scp", ["-q", file, `${ssh}:${path.basename(file)}`]);
  const there = file => (ssh ? path.basename(file) : file);
  const viewer = (action, arg = "") => run(`set "WATCH_BENCH_MARK=${mark}" && powershell -NoProfile -ExecutionPolicy Bypass -File "${there(script)}" -Do ${action} -Arg "${arg}"`);
  await run(`mkdir "%TEMP%\\watch-party-vlc" 2>nul & del "%TEMP%\\watch-party-vlc\\bench.log" 2>nul`);
  await viewer("clock", `http://${host}:${media.port}/now`);
  const launched = Date.now();
  const follower = run(`set "WATCH_DEBUG=1" && set "WATCH_VLC_ARGS=--video-title=${mark} --intf=dummy --dummy-quiet --vout=dummy --aout=dummy" && "${there(launcher)}" < nul`, 400000);

  // The run. A step is timed from the end of its disturbance (the TV plays again, the viewer
  // has clicked) and given time to settle before the next begins: longer on a real CDN.
  const steps = [], patience = live ? 1600 : 1000;
  const step = async (label, act, wait, by = null) => { const began = Date.now(); await act(); steps.push({ label, began, at: Date.now(), by }); await sleep(wait * patience); };
  await sleep(28 * patience);                                   // joining, then playing undisturbed
  await step("TV pauses for 3 s", async () => { tv.setPaused(true); await sleep(3000); tv.setPaused(false); }, 8);
  await step("TV pauses for 0.3 s", async () => { tv.setPaused(true); await sleep(300); tv.setPaused(false); }, 7);
  await step("TV skips 90 s ahead", () => tv.skip(90, 300), 9);
  await step("TV skips 60 s back, loading 4 s", () => tv.skip(-60, 4000), 9);
  await step("TV skips 30 s with no loading", () => tv.skip(30, 0), 9);
  await step("TV is scrubbed: 4 skips in 3 s", async () => { for (let i = 0; i < 4; i++) { await tv.skip(30, 300); if (i < 3) await sleep(400); } }, 9);
  await step("TV pause button mashed 8 times", async () => { for (let i = 0; i < 7; i++) { tv.setPaused(i % 2 === 0); await sleep(250); } tv.setPaused(false); }, 8);
  await step("TV speeds up to 1.5x", () => tv.setRate(1.5), 7);
  await step("TV skips 30 s while at 1.5x", () => tv.skip(30, 0), 8);
  await step("TV goes back to 1x", () => tv.setRate(1), 7);
  await step("TV paused, viewer seeks, TV plays", async () => { tv.setPaused(true); await sleep(1500); await viewer("seek"); await sleep(4 * patience); tv.setPaused(false); }, 7);
  if (hop) await step("connection to the relay drops", () => hop.cut(), 8);
  await step("viewer pauses", () => viewer("pause"), 6, "pause");
  await step("viewer seeks 60 s ahead", () => viewer("seek"), 9, "seek");
  await step("viewer sets 1.5x", () => viewer("speed"), 7, "speed");
  await step("viewer presses Stop", () => viewer("stop"), 10, "stop");
  await step("viewer opens another file", () => viewer("other", url("other.mkv")), 10, "other");
  await step("next episode, loading 2 s", () => tv.open({ mediaUrl: second, title: "second", episodeId: live?.EPISODE }, from, 2000), 9);
  await viewer("clock", `http://${host}:${media.port}/now`);
  const finished = Date.now(); tv.idle(); await sleep(1500);

  const text = (await run(`type "%TEMP%\\watch-party-vlc\\follow.log" & type "%TEMP%\\watch-party-vlc\\bench.log"`)).toString();
  await run(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='vlc.exe'\\" | Where-Object { $_.CommandLine -match '${mark}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`);
  await follower; await run(`rmdir /s /q "%TEMP%\\watch-party-vlc" 2>nul & del "%TEMP%\\watch-party-vlc.ps1" ${ssh ? `${there(launcher)} ${there(script)} ` : ""}2>nul`);
  tv.close(); await relay?.close(); hop?.close();
  if (process.env.KEEP) writeFileSync(path.join(process.env.KEEP, `bench-${name}.log`), text);

  // Three clocks. The follower's log runs on a stopwatch started from the Windows clock;
  // the viewer script stamps with the Windows clock itself; the fake TV lives on this
  // machine's. The follower logs the Windows clock every two seconds ("wall"), and the
  // viewer script measured this machine's against it before and after the run ("clock"):
  // they drift apart by a few ms in three minutes, so each is a line through its readings.
  const rows = parse(text);
  const walls = rows.filter(r => r.text?.startsWith("wall ")).map(r => ({ at: r.at, v: Number(r.text.split(" ")[1]) - r.at }));      // Windows clock minus the follower's
  const clocks = rows.filter(r => r.text?.startsWith("clock ")).map(r => ({ at: r.at, v: Number(r.text.split(" ")[1]) }));           // this machine's minus the Windows clock
  const ahead = at => { const windows = at + along(walls, at); return windows - at + along(clocks, windows); };                      // this machine's minus the follower's
  const pc = ms => ms - ahead(ms - ahead(rows[0].at));                                                                                // a moment here, on the follower's clock
  for (const r of rows) if (/^(viewer|clock) /.test(r.text)) r.at -= along(walls, r.at);
  rows.sort((a, b) => a.at - b.at);
  for (const r of rows) if (r.t != null) r.gap = (r.t - tv.positionAt(r.read + ahead(r.read))) * 1000;   // positive: VLC is ahead of the TV
  const line = (label, from, until) => {
    const did = rows.filter(r => r.at >= from && r.at < until && r.text);
    const seeks = did.filter(r => /^(park|open at|wait at)/.test(r.text)).length, bursts = did.filter(r => / ms off: speed/.test(r.text)).length;
    log(`  ${label.padEnd(34)} in step after ${seconds(settles(rows, from, until, 50))}, within 20 ms after ${seconds(settles(rows, from, until, 20))}   ${seeks} seek${seeks === 1 ? " " : "s"} ${bursts} burst${bursts === 1 ? "" : "s"}`);
  };
  const opened = rows.find(r => r.text?.startsWith("open at")), quietUntil = pc(steps[0].began);
  log(`\n${name}: ${JSON.stringify(profile)}   (during the run the two machines' clocks drifted ${Math.abs(clocks[clocks.length - 1].v - clocks[0].v).toFixed(1)} ms apart, the follower's and Windows' own ${Math.abs(walls[walls.length - 1].v - walls[0].v).toFixed(1)} ms)`);
  log(`  the stream is opened ${((opened.at - pc(launched)) / 1000).toFixed(1)} s after the file is run`);
  line("joining a TV that is playing", opened.at, quietUntil);
  const quiet = rows.filter(r => r.gap != null && r.at > opened.at + 8000 && r.at < quietUntil).map(r => r.gap).sort((a, b) => a - b);
  log(`  ${"playing undisturbed".padEnd(34)} gap ${quiet[0]?.toFixed(0)} to ${quiet[quiet.length - 1]?.toFixed(0)} ms, middle ${quiet[quiet.length >> 1]?.toFixed(0)} ms, over ${quiet.length} readings`);
  const viewers = rows.filter(r => r.text?.startsWith("viewer "));
  for (const [i, s] of steps.entries()) {
    const from = s.by ? viewers.find(r => r.text === `viewer ${s.by}` && r.at >= pc(s.began))?.at : pc(s.at);
    if (from == null) log(`  ${s.label.padEnd(34)} (not done)`); else line(s.label, from, i + 1 < steps.length ? pc(steps[i + 1].began) : pc(finished));
  }
  const c = media.connections; media.close();
  if (!live) log(`  VLC opened ${c.total} connections to the stream, at most ${c.mostOpen} at once; more than one was open for ${c.overlapMs} ms in all, ${c.longestOverlapMs} ms at the longest`);
}

console.log = () => {};                                         // the relay logs every viewer report
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PROFILES).filter(name => !PROFILES[name].live);
try { for (const name of chosen) await bench(name); } finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(0);
