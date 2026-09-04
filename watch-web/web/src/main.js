import { buildUi } from "./ui.js";
import { connectRelay } from "./relay.js";
import { Pipeline } from "./player/pipeline.js";
import { SubtitleDemux, AssRenderer } from "./subtitles/ass.js";
import { TextSubtitles } from "./subtitles/text.js";
import { estimateTvPosition, syncAction, tvJumped, SNAP_WINDOW_MS } from "./sync.js";

const room = new URLSearchParams(location.search).get("room") || "home";
const ui = buildUi(document.getElementById("app"));
const video = ui.el.video;
video.muted = true;

let tvState = null;              // last TV sample (+receivedAtMs)
let session = null;              // { id, cdnUrl, pipeline, demux, ass, text, subTracks, selectedSub }
let audioUnlocked = false;
let seeking = false;
let lastRemuxAt = 0;
const REMUX_COOLDOWN_MS = 5000;   // min gap between cold re-muxes while catching up

const prefs = { audio: localStorage.getItem("watch.audio") || "", subs: localStorage.getItem("watch.subs") || "eng" };

// label = language; detail = the track name only when it adds information ("Forced", "CC")
function trackParts(lang, name) {
  const l = fmtLang(lang);
  const n = (name || "").trim();
  return { label: l, detail: n && n.toLowerCase() !== l.toLowerCase() ? n : "" };
}
const CODEC_NAMES = { aac: "AAC", ac3: "Dolby", eac3: "Dolby", dts: "DTS", flac: "FLAC", opus: "Opus", mp3: "MP3" };
function codecName(c) { return CODEC_NAMES[c] || String(c || "").toUpperCase(); }
function fmtLang(code) { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch { return code || "und"; } }

// The TV bridge sends document.title ("Stremio") when the item has no series id (movies).
// Derive a readable title from the release filename instead.
function titleFor(state) {
  const raw = (state.title || "").trim();
  if (raw && !/^stremio$/i.test(raw)) return raw;
  try {
    const seg = decodeURIComponent(new URL(state.mediaUrl).pathname.split("/").filter(Boolean).pop() || "");
    const stem = seg.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
    const m = stem.match(/^(.*?)(?:\s|\(|\[)?(19|20)\d{2}\b/);
    let name = (m ? m[1] : stem.split(/\s(?=\d{3,4}p\b|2160p|1080p|720p|blu-?ray|web-?dl|webrip|hdtv|uhd|remux|x26[45]|h\.?26[45]|hevc|hdr|dv\b)/i)[0]).trim();
    const year = m ? stem.slice(m.index + m[1].length).match(/(19|20)\d{2}/)?.[0] : null;
    name = name.replace(/^\[[^\]]*\]\s*/, "").replace(/\b\w/g, c => c.toUpperCase());
    return name ? (year ? `${name} (${year})` : name) : raw || "Now playing";
  } catch { return raw || "Now playing"; }
}

// Name the hop that failed so a TorBox node outage reads as what it is.
function unreachableText(host, attempt) {
  const who = /tb-cdn|torbox/i.test(host || "") ? "TorBox's server for this file" : host ? host : "the stream host";
  return `Can't reach ${who} right now. Retrying${attempt > 1 ? ` (${attempt})` : ""}.`;
}

function showIdle() {
  ui.setStage(null);
  ui.overlay(true, "Waiting for the TV", "When the TV plays something, it appears here and stays in sync.");
  ui.setTv(""); ui.setTitle(""); ui.setStats(""); ui.setFacts([]);
}

async function endSession() {
  const s = session; session = null;
  if (!s) return;
  await s.ass.hide(); s.text.hide(); s.demux.dispose();
  await s.pipeline.close();
}

async function startSession(sessionId, cdnUrl, size) {
  await endSession();
  ui.setStage("open");
  ui.overlay(true, tvState?.title || "Opening the stream", "Preparing it for your browser.");
  const s = { id: sessionId, cdnUrl, size, subTracks: [], selectedSub: null, fonts: 0 };
  s.ass = new AssRenderer(video, ui.el.assLayer);
  s.text = new TextSubtitles(video);
  s.demux = new SubtitleDemux({
    onTracks: tracks => { s.subTracks = tracks; s.ass.setTracks(tracks); s.text.setTracks(tracks); renderSubsMenu(); autoSelectSub(); },
    onFont: f => { s.fonts++; s.ass.addFont(f); },
    onCue: (n, cue) => { s.ass.addCue(n, cue); s.text.addCue(n, cue); },
  });
  s.pipeline = new Pipeline(video, {
    onTracks: t => { renderAudioMenu(); ui.setStats(`${t.video.height}p${t.video.hdr ? " HDR" : ""}`); },
    onError: e => { console.error(e); if (session === s) ui.overlay(true, "Playback problem", e.message); },
  });
  session = s;
  try {
    await s.pipeline.open(cdnUrl, { tee: s.demux, size });
    if (session !== s) return;
    ui.setStage("load");
    const t = s.pipeline.tracks;
    ui.setFacts([{ icon: "film", text: `${t.video.width}×${t.video.height}${t.video.hdr ? " HDR" : ""}` }, { icon: "audio", text: `${t.audios.length} audio` }, { text: `${(t.size / 1073741824).toFixed(1)} GB` }]);
    // walk the header for subtitle tracks + fonts (tracks usually arrive within the first MB)
    void s.pipeline.source.prefetch(0, 16 * 1024 * 1024).catch(() => {});
    const startAt = estimateTvPosition(tvState) ?? 0;
    const preferred = prefs.audio ? s.pipeline.tracks.audios.find(a => a.language === prefs.audio && a.playable)?.id : undefined;
    lastRemuxAt = Date.now();
    await s.pipeline.start(startAt, preferred ?? undefined);
    if (session !== s) return;
    renderAudioMenu();               // now that the default audio track is chosen
    video.currentTime = startAt;
  } catch (e) {
    console.error(e);
    if (session === s) { ui.setStage(null); ui.overlay(true, "Can't play this stream", e.message); }
  }
}

function renderAudioMenu() {
  const s = session; if (!s?.pipeline.tracks) return;
  const items = s.pipeline.tracks.audios.map(a => ({ id: a.id, ...trackParts(a.language, a.name), tag: a.playable ? `${codecName(a.codec)} ${a.channels > 2 ? "surround" : a.channels === 1 ? "mono" : "stereo"}` : "unsupported" }));
  ui.audioMenu(items, s.pipeline.selectedAudioId, async id => {
    const a = s.pipeline.tracks.audios.find(x => x.id === id); if (!a?.playable) return;
    localStorage.setItem("watch.audio", a.language || ""); prefs.audio = a.language || "";
    await s.pipeline.selectAudio(id); renderAudioMenu();
  });
}
function renderSubsMenu() {
  const s = session; if (!s) return;
  const items = s.subTracks.map(t => ({ id: t.number, ...trackParts(t.language || "eng", t.name), tag: t.type === "ass" || t.type === "ssa" ? "styled" : "text" }));
  ui.subsMenu(items, s.selectedSub, id => selectSub(id, true));
}
function autoSelectSub() {
  const s = session; if (!s || s.selectedSub != null) return;
  if (prefs.subs === "off") return;
  const byLang = s.subTracks.filter(t => (t.language || "eng").startsWith(prefs.subs || "eng"));
  const pick = byLang.find(t => !/forced|signs|songs/i.test(t.name || "")) || byLang[0] || s.subTracks[0];
  if (pick) selectSub(pick.number, false);
}
async function selectSub(number, user) {
  const s = session; if (!s) return;
  s.selectedSub = number;
  const t = s.subTracks.find(x => x.number === number);
  if (user) { prefs.subs = number == null ? "off" : (t?.language || "eng"); localStorage.setItem("watch.subs", prefs.subs); }
  if (number == null) { await s.ass.hide(); s.text.hide(); }
  else if (t?.type === "ass" || t?.type === "ssa") { s.text.hide(); await s.ass.show(number); }
  else { await s.ass.hide(); s.text.show(number); }
  renderSubsMenu();
}

// ---- follow the TV ----
async function follow() {
  const s = session; if (!s || !tvState || seeking) return;
  if (!s.pipeline.sourceBuffer) return;
  const target = estimateTvPosition(tvState);
  if (tvState.paused) { if (!video.paused) video.pause(); }
  else if (video.paused && video.readyState >= 2) { video.play().catch(() => {}); }

  const act = syncAction(video.currentTime, target, { paused: tvState.paused, snap: Date.now() < tvState.snapUntil });
  if (act.type === "seek") {
    // If the target is already buffered, jump instantly. Otherwise a hard seek means
    // re-muxing from there, which clears the buffer; don't do that again until the
    // mux has had a few seconds to build toward the last target, or the browser will
    // restart forever while the TV keeps moving ahead of a cold buffer.
    if (s.pipeline.isBuffered(target)) {
      seeking = true;
      try { await s.pipeline.seekTo(target); } finally { seeking = false; }
      video.playbackRate = 1;
    } else if (Date.now() - lastRemuxAt > REMUX_COOLDOWN_MS) {
      lastRemuxAt = Date.now();
      seeking = true;
      try { await s.pipeline.start(Math.max(0, target - 2)); video.currentTime = target; } finally { seeking = false; }
      video.playbackRate = 1;
    } else {
      // waiting for the in-flight re-mux to reach the target; nudge toward it
      video.playbackRate = 1;
    }
  } else video.playbackRate = act.playbackRate;

  if (video.readyState >= 3 && !ui.el.overlay.hidden && Math.abs(video.currentTime - target) < 2) { ui.setStage("done"); ui.overlay(false); }
  else if (video.readyState < 3 && s.pipeline.isBuffered(target) === false && ui.el.overlay.hidden) { /* stalled; leave player visible */ }
}
setInterval(follow, 250);

// Every 10s, tell the relay what this browser has been asking the CDN for (see server netlog).
let netlogSent = 0;
setInterval(() => {
  const src = session?.pipeline?.source; if (!src) return;
  const recent = src.log.filter(e => e.t > netlogSent); netlogSent = Date.now();
  if (!recent.length && !src.retries) return;
  relay.send({ type: "netlog", data: { host: (() => { try { return new URL(src.url).host; } catch { return "?"; } })(), requests: src.requests, retries: src.retries, MB: +(src.bytesFetched / 1048576).toFixed(0), t: video.currentTime.toFixed(1), buffered: session.pipeline.buffered().map(r => r.map(x => +x.toFixed(0))), recent: recent.map(e => [new Date(e.t).toISOString().slice(11, 23), e.k, e.s, e.st, e.ms]) } });
}, 10000);

// Repaint ASS on the current frame when paused (no rVFC fires then).
for (const ev of ["seeked", "pause", "timeupdate"]) video.addEventListener(ev, () => { if (video.paused) session?.ass.renderNow(); });
video.addEventListener("waiting", () => ui.setTv(tvState?.paused ? "Paused on the TV" : "Buffering", tvState?.paused ? "warn" : ""));
video.addEventListener("playing", () => ui.setTv(tvState?.paused ? "Paused on the TV" : "In sync", tvState?.paused ? "warn" : "ok"));

ui.onSound(() => { audioUnlocked = true; video.muted = false; ui.showSoundPrompt(false); if (tvState && !tvState.paused) video.play().catch(() => { video.muted = true; ui.showSoundPrompt(true); }); });
video.addEventListener("playing", () => { if (!audioUnlocked && video.muted) ui.showSoundPrompt(true); }, { once: true });

const relay = connectRelay({
  room,
  build: new URL(import.meta.url).pathname,   // "/assets/index-<hash>.js": changes with every build
  onConnection: st => ui.setConnection(st),
  onState: (state, resolveError, resolveHost) => {
    const now = Date.now();
    // The relay stamps each sample on arrival (sentAtMs, relay clock). With the clock
    // synced, read that in local time so transit latency drops out of the estimate.
    const sampledAt = relay.toLocalMs(state.sentAtMs) ?? now;
    const snapUntil = tvJumped(tvState, state, now) ? now + SNAP_WINDOW_MS : (tvState?.snapUntil || 0);
    tvState = { ...state, receivedAtMs: sampledAt, snapUntil };
    ui.setTitle(titleFor(state));
    ui.setTv(state.paused ? "Paused on the TV" : "In sync", state.paused ? "warn" : "ok");
    if (!session) {
      ui.setStage("resolve");
      ui.overlay(true, titleFor(state), resolveError ? unreachableText(resolveHost) : "The TV just started something.");
    }
    if (session && session.id !== state.sessionId) { void endSession(); ui.overlay(true, "Switching stream", "The TV changed what it's playing."); }
  },
  onMedia: (cdnUrl, sessionId, { size, resolveError } = {}) => {
    if (resolveError) console.warn("resolve failed, using original url:", resolveError);
    if (!session || session.id !== sessionId) void startSession(sessionId, cdnUrl, size);
  },
  onIdle: () => { void endSession(); tvState = null; showIdle(); },
  onResolveError: (message, attempt, host) => {
    if (session) return;
    ui.setStage("resolve");
    ui.overlay(true, tvState ? titleFor(tvState) : "Locating the stream", unreachableText(host, attempt));
  },
});
ui.setRoom(room === "home" ? "" : `Room ${room}`);
showIdle();

// Debug/inspection handle (also drives the automated browser tests).
window.__watch = () => {
  const s = session; const p = s?.pipeline;
  return {
    tv: tvState && { pos: tvState.positionSeconds, paused: tvState.paused, est: estimateTvPosition(tvState) },
    clock: relay.clock(),
    video: { t: video.currentTime, paused: video.paused, rs: video.readyState, rate: video.playbackRate, muted: video.muted, w: video.videoWidth, h: video.videoHeight },
    buffered: p?.buffered() || [],
    tracks: p?.tracks && { video: { codec: p.tracks.video.codec, codecString: p.tracks.video.codecString, hdr: p.tracks.video.hdr }, audios: p.tracks.audios.map(a => ({ id: a.id, lang: a.language, codec: a.codec, ch: a.channels, playable: a.playable })), duration: p.tracks.duration },
    selectedAudio: p?.selectedAudioId ?? null,
    subs: s && { tracks: s.subTracks.map(t => ({ n: t.number, lang: t.language, type: t.type, name: t.name })), selected: s.selectedSub, fonts: s.fonts, assEvents: Object.fromEntries([...s.ass.events].map(([k, v]) => [k, v.length])), activeAss: s.ass.activeTrack, jassub: Boolean(s.ass.jassub), jassubReady: s.ass.ready, pushed: s.ass.pushed, showCalls: s.ass.showCalls, assError: s.ass.lastError, demux: { ...s.demux.stats, firstCluster: s.demux.firstCluster, headerCursor: s.demux.headerCursor, cursor: s.demux.cursor, pending: s.demux.pending.size } },
    net: p?.source && { requests: p.source.requests, retries: p.source.retries || 0, fetchedMB: +(p.source.bytesFetched / 1048576).toFixed(1), size: p.source.size },
    feed: p?.run && { stage: p.run.stage, nv: p.run.nv, na: p.run.na, transcode: p.run.transcode },
  };
};
window.__watchSelectSub = n => selectSub(n, true);
window.__session = () => session;
window.__watchSelectAudio = id => session?.pipeline.selectAudio(id).then(renderAudioMenu);
