import { buildUi } from "./ui.js";
import { connectRelay } from "./relay.js";
import { Pipeline } from "./player/pipeline.js";
import { SubtitleDemux, AssRenderer } from "./subtitles/ass.js";
import { BitmapDemux } from "./subtitles/bitmap-demux.js";
import { BitmapRenderer } from "./subtitles/bitmap.js";
import { TextSubtitles } from "./subtitles/text.js";
import { estimateTvPosition, syncAction } from "./sync.js";

const room = new URLSearchParams(location.search).get("room") || "home";
const ui = buildUi(document.getElementById("app"));
const video = ui.el.video;
video.muted = true;

let tvState = null;              // last TV sample, in the viewer clock
let pendingCorrection = null;
const syncStats = { seeks: 0, remuxes: 0, waits: 0, rateChanges: 0 };
let session = null;              // { id, cdnUrl, pipeline, demux, ass, text, subTracks, selectedSub }
let audioUnlocked = false;
let seeking = false;
let lastRemuxAt = 0;
const REMUX_COOLDOWN_MS = 5000;   // min gap between cold re-muxes while catching up
const FEED_WAIT_S = 20;           // if the running mux is within this much media of the target, wait for it instead of restarting

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

// Every session transition goes through ONE queue. Two teardowns used to race on a
// stream switch: onState fired endSession() without awaiting it, onMedia saw
// `session` already null and started the new stream, and the old teardown's last
// step (dropping video.src) then detached the NEW MediaSource -> "SourceBuffer has
// been removed from the parent media source" on a perfectly good stream.
let transition = Promise.resolve();
function queued(fn) { const run = () => fn().catch(e => console.error(e)); transition = transition.then(run, run); return transition; }
let requestedStart = null;
const queueEnd = () => { requestedStart = null; return queued(endSession); };
const queueStart = (id, cdnUrl, size) => {
  if (requestedStart === id || session?.id === id) return transition;
  requestedStart = id;
  return queued(() => requestedStart === id ? startSession(id, cdnUrl, size) : Promise.resolve());
};

async function endSession() {
  const s = session; session = null;
  ui.showSoundPrompt(false);
  if (!s) return;
  await s.ass.hide(); s.text.hide(); s.bitmap.hide(); s.demux.dispose();
  await s.pipeline.close();
}

async function startSession(sessionId, cdnUrl, size) {
  await endSession();
  if (session) return;                       // a later transition already took over
  ui.setStage("open");
  ui.overlay(true, tvState?.title || "Opening the stream", "Preparing it for your browser.");
  const s = { id: sessionId, cdnUrl, size, starting: true, subTracks: [], textTracks: [], bitmapTracks: [], selectedSub: null, fonts: 0 };
  s.ass = new AssRenderer(video, ui.el.assLayer);
  s.text = new TextSubtitles(video);
  s.bitmap = new BitmapRenderer(video, ui.el.assLayer);
  const gotTracks = () => { s.subTracks = [...s.textTracks, ...s.bitmapTracks]; renderSubsMenu(); autoSelectSub(); };
  s.bdemux = new BitmapDemux({
    onTracks: tracks => { s.bitmapTracks = tracks; s.bitmap.setTracks(tracks); gotTracks(); },
    onBlock: (t, b) => s.bitmap.addBlock(t, b),
  });
  s.demux = new SubtitleDemux({
    onTracks: tracks => { s.textTracks = tracks; s.ass.setTracks(tracks); s.text.setTracks(tracks); gotTracks(); },
    onFont: f => { s.fonts++; s.ass.addFont(f); },
    onCue: (n, cue) => { s.ass.addCue(n, cue); s.text.addCue(n, cue); },
    tap: s.bdemux.tap,
  });
  s.pipeline = new Pipeline(video, {
    onTracks: t => { renderAudioMenu(); ui.setStats(`${t.video.height}p${t.video.hdr ? " HDR" : ""}`); },
    onStatus: status => { if (session === s && status.phase === "playback-blocked") ui.showSoundPrompt(true, true); },
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
    await s.pipeline.present(() => {
      video.currentTime = estimateTvPosition(tvState) ?? startAt;
      if (tvState && !tvState.paused && !tvState.buffering) return video.play();
    });
    s.starting = false;
    if (session === s) void follow();
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
  const tag = t => t.type === "ass" || t.type === "ssa" ? "styled" : t.type === "pgs" || t.type === "vobsub" ? "bitmap" : "text";
  const items = s.subTracks.map(t => ({ id: t.number, ...trackParts(t.language || "eng", t.name), tag: tag(t) }));
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
  if (number == null) { await s.ass.hide(); s.text.hide(); s.bitmap.hide(); }
  else if (t?.type === "ass" || t?.type === "ssa") { s.text.hide(); s.bitmap.hide(); await s.ass.show(number); }
  else if (t?.type === "pgs" || t?.type === "vobsub") { s.text.hide(); await s.ass.hide(); await s.bitmap.show(number); }
  else { await s.ass.hide(); s.bitmap.hide(); s.text.show(number); }
  renderSubsMenu();
}

// ---- follow the TV ----
function setPlaybackRate(rate) { if (video.playbackRate !== rate) video.playbackRate = rate; }
async function follow() {
  const s = session; if (!s || s.starting || !tvState || s.id !== tvState.sessionId || seeking) return;
  if (!s.pipeline.sourceBuffer) return;
  let target = estimateTvPosition(tvState);
  const correction = pendingCorrection;
  const playbackRate = tvState.playbackRate || 1;
  const hold = tvState.paused || tvState.buffering;          // TV sits on a frame: paused, or "playing" but not advancing
  // Let Safari decode its first frame before enforcing the TV's paused state.
  // Pausing during startup can put it back into metadata-only loading.
  if (video.readyState >= 2) s.pipeline.priming = false;
  if (hold) { if (!video.paused && !s.pipeline.priming) video.pause(); }
  else if (video.paused && video.readyState >= 2) {
    seeking = true;
    try { await s.pipeline.present(() => video.play()); } catch { return; } finally { seeking = false; }
    if (session !== s || !tvState || tvState.sessionId !== s.id || tvState.paused || tvState.buffering) return;
    target = estimateTvPosition(tvState);
  }
  if (video.readyState < 2) return;

  const act = syncAction(video.currentTime, target, { paused: hold, snap: Boolean(correction), playbackRate,
    rateCorrection: s.pipeline.MediaSource !== globalThis.ManagedMediaSource });
  if (act.type === "seek") {
    // If the target is already buffered, jump instantly. Otherwise a hard seek means
    // re-muxing from there, which clears the buffer; don't do that again until the
    // mux has had a few seconds to build toward the last target, or the browser will
    // restart forever while the TV keeps moving ahead of a cold buffer.
    const run = s.pipeline.run;
    const feedIsClose = run && !run.cancelled && run.fedTs != null && target >= run.startAt && target - run.fedTs < FEED_WAIT_S;
    if (s.pipeline.isBuffered(target)) {
      seeking = true;
      syncStats.seeks++;
      try {
        const landing = () => estimateTvPosition(tvState, Date.now() + s.pipeline.seekLatencyMs);
        await s.pipeline.seekTo(landing());
        // At most one completion correction per event. Never turn this into a
        // steady-playback seek loop. An intervening TV event supersedes this one.
        if (session === s && pendingCorrection === correction && tvState?.sessionId === s.id &&
            !tvState.paused && !tvState.buffering &&
            Math.abs(video.currentTime - estimateTvPosition(tvState)) > 0.12 && s.pipeline.isBuffered(landing())) {
          syncStats.seeks++;
          await s.pipeline.seekTo(landing());
        }
        if (pendingCorrection === correction) pendingCorrection = null;
      } finally { seeking = false; }
      setPlaybackRate(playbackRate);
    } else if (feedIsClose) {
      setPlaybackRate(playbackRate);                          // the running mux reaches the target in a moment; restarting would only add a cold start
    } else if (Date.now() - lastRemuxAt > REMUX_COOLDOWN_MS) {
      lastRemuxAt = Date.now();
      seeking = true;
      try {
        syncStats.remuxes++;
        await s.pipeline.start(Math.max(0, target - 2));
        if (session === s && tvState?.sessionId === s.id) {
          await s.pipeline.present(() => { video.currentTime = estimateTvPosition(tvState); });
          if (!pendingCorrection) pendingCorrection = { sessionId: s.id, sequence: tvState.sequence };
        }
      } finally { seeking = false; }
      setPlaybackRate(playbackRate);
    } else {
      // waiting for the in-flight re-mux to reach the target; nudge toward it
      setPlaybackRate(playbackRate);
    }
  } else { setPlaybackRate(act.playbackRate); if (pendingCorrection === correction) pendingCorrection = null; }

  if (video.readyState >= (hold ? 2 : 3) && !ui.el.overlay.hidden && Math.abs(video.currentTime - target) < 2) { ui.setStage("done"); ui.overlay(false); }
  else if (video.readyState < 3 && s.pipeline.isBuffered(target) === false && ui.el.overlay.hidden) { /* stalled; leave player visible */ }
}
setInterval(follow, 250);

// Every 10s, tell the relay what this browser has been asking the CDN for (see server netlog).
let netlogSent = 0;
setInterval(() => {
  const src = session?.pipeline?.source; if (!src) return;
  const recent = src.log.filter(e => e.t > netlogSent); netlogSent = Date.now();
  const p = session.pipeline, a = p.tracks?.audios.find(x => x.id === p.selectedAudioId);
  relay.send({ type: "netlog", data: { host: (() => { try { return new URL(src.url).host; } catch { return "?"; } })(), requests: src.requests, retries: src.retries, MB: +(src.bytesFetched / 1048576).toFixed(0),
    sync: { ...syncStats, seekLatencyMs: p.seekLatencyMs, sampleAgeMs: tvState ? Math.round(Date.now() - tvState.sampledAtMs) : null, event: tvState?.event, clock: relay.clock() },
    cachedChunks: src.order.length, cacheLimitMB: src.maxCachedChunks * src.chunkSize / 1048576,
    t: video.currentTime.toFixed(1), tv: tvState && +estimateTvPosition(tvState).toFixed(1), paused: video.paused, rs: video.readyState, buffered: p.buffered().map(r => r.map(x => +x.toFixed(0))),
    video: p.tracks && `${p.tracks.video.codec} ${p.tracks.video.width}x${p.tracks.video.height}`, audio: a && `${a.codec} ${a.channels}ch ${a.transcode ? "transcode" : "direct"}`, audios: p.tracks?.audios.map(x => `${x.codec}:${x.playable ? "ok" : "no"}`),
    feed: p.run && { stage: p.run.stage, nv: p.run.nv, na: p.run.na, startAt: +p.run.startAt.toFixed(1) }, starts: p.startCount || 0, opens: session.opens || 0, stage: ui.el.overlay.hidden ? null : ui.el.ovTitle.textContent,
    source: { type: p.mediaSource?.constructor.name, state: p.mediaSource?.readyState, priming: p.priming, gesture: p.needsPlaybackGesture },
    subs: { sel: session.selectedSub, ass: session.ass.activeTrack, assPushed: session.ass.pushed, assDupes: session.ass.dupes || 0, textDupes: session.text.dupes, textCues: session.text.active != null ? (session.text.tracks.get(session.text.active)?.cues?.length ?? null) : null, streams: session.demux.stats.streamsOpened, cues: session.demux.stats.cues },
    recent: recent.map(e => [new Date(e.t).toISOString().slice(11, 23), e.k, e.s, e.st, e.ms]) } });
}, 10000);

// Repaint ASS on the current frame when paused (no rVFC fires then).
for (const ev of ["seeked", "pause", "timeupdate"]) video.addEventListener(ev, () => { if (video.paused) session?.ass.renderNow(); });
// Status chip: "Buffering" only if a stall outlasts a seek's blip, so landings don't flash it.
let waitingTimer = null;
video.addEventListener("waiting", () => { syncStats.waits++; });
video.addEventListener("ratechange", () => { syncStats.rateChanges++; });
const tvChip = () => tvState?.paused ? ["Paused on the TV", "warn"] : tvState?.buffering ? ["TV is loading", "warn"] : ["In sync", "ok"];
video.addEventListener("waiting", () => { clearTimeout(waitingTimer); waitingTimer = setTimeout(() => { if (video.readyState < 3 && !video.paused) ui.setTv("Buffering", ""); }, 600); });
video.addEventListener("playing", () => { clearTimeout(waitingTimer); ui.setTv(...tvChip()); });
// A decoder failure (e.g. a browser whose HEVC hardware path is broken) never reaches the
// pipeline: the element just drops its buffered ranges and sits at HAVE_METADATA. Say so.
const MEDIA_ERR = { 1: "aborted", 2: "network error", 3: "decoding failed", 4: "format not supported" };
video.addEventListener("error", () => { const e = video.error; if (!e) return; console.error("video error", e.code, e.message); ui.overlay(true, "Playback problem", `This browser could not decode the stream (${MEDIA_ERR[e.code] || e.code}${e.message ? `: ${e.message}` : ""}).`); });

ui.onSound(() => {
  if (session?.pipeline.needsPlaybackGesture) {
    ui.showSoundPrompt(false);
    session.pipeline.requestPlayback();
    return;
  }
  audioUnlocked = true; video.muted = false; ui.showSoundPrompt(false);
  if (tvState && !tvState.paused) video.play().catch(() => { video.muted = true; ui.showSoundPrompt(true); });
});
video.addEventListener("playing", () => { if (!audioUnlocked && video.muted) ui.showSoundPrompt(true); }, { once: true });

const relay = connectRelay({
  room,
  build: new URL(import.meta.url).pathname,   // "/assets/index-<hash>.js": changes with every build
  onConnection: st => ui.setConnection(st),
  onState: (state, resolveError, resolveHost) => {
    const now = Date.now();
    const sampledAtMs = relay.toLocalMs(state.sampledAtMs);
    if (sampledAtMs == null) return;
    // Discrete timeline changes get one correction. Heartbeats only nudge rate;
    // a noisy clock sample must not trigger a multi-second sequence of seeks.
    if (!tvState || tvState.sessionId !== state.sessionId ||
        ["play", "seeked", "ratechange"].includes(state.event)) pendingCorrection = { sessionId: state.sessionId, sequence: state.sequence };
    const buffering = state.buffering;
    tvState = { ...state, sampledAtMs, arrivedAtMs: now };
    if ((state.paused || buffering) && session && !session.pipeline.priming) video.pause();
    if (session?.id === state.sessionId) void follow();
    ui.setTitle(titleFor(state));
    ui.setTv(state.paused ? "Paused on the TV" : buffering ? "TV is loading" : "In sync", state.paused || buffering ? "warn" : "ok");
    if (!session) {
      ui.setStage("resolve");
      ui.overlay(true, titleFor(state), resolveError ? unreachableText(resolveHost) : "The TV just started something.");
    }
    if (session && session.id !== state.sessionId) { void queueEnd(); ui.overlay(true, "Switching stream", "The TV changed what it's playing."); }
  },
  onMedia: (cdnUrl, sessionId, { size, resolveError } = {}) => {
    if (resolveError) console.warn("resolve failed, using original url:", resolveError);
    if (!session || session.id !== sessionId) void queueStart(sessionId, cdnUrl, size);
  },
  onIdle: () => { video.pause(); void queueEnd(); tvState = null; pendingCorrection = null; showIdle(); },
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
    sync: { ...syncStats, seekLatencyMs: session?.pipeline.seekLatencyMs, event: tvState?.event, sampledAtMs: tvState?.sampledAtMs, clock: relay.clock() },
    tv: tvState && { pos: tvState.positionSeconds, paused: tvState.paused, est: estimateTvPosition(tvState) },
    clock: relay.clock(),
    video: { t: video.currentTime, paused: video.paused, rs: video.readyState, rate: video.playbackRate, muted: video.muted, w: video.videoWidth, h: video.videoHeight, error: video.error && `${video.error.code} ${video.error.message}` },
    buffered: p?.buffered() || [],
    tracks: p?.tracks && { video: { codec: p.tracks.video.codec, codecString: p.tracks.video.codecString, hdr: p.tracks.video.hdr }, audios: p.tracks.audios.map(a => ({ id: a.id, lang: a.language, codec: a.codec, ch: a.channels, playable: a.playable })), duration: p.tracks.duration },
    selectedAudio: p?.selectedAudioId ?? null,
    subs: s && { tracks: s.subTracks.map(t => ({ n: t.number, lang: t.language, type: t.type, name: t.name })), selected: s.selectedSub, fonts: s.fonts, assEvents: Object.fromEntries([...s.ass.events].map(([k, v]) => [k, v.length])), activeAss: s.ass.activeTrack, jassub: Boolean(s.ass.jassub), jassubReady: s.ass.ready, pushed: s.ass.pushed, showCalls: s.ass.showCalls, assError: s.ass.lastError, demux: { ...s.demux.stats, firstCluster: s.demux.firstCluster, headerCursor: s.demux.headerCursor, cursor: s.demux.cursor, pending: s.demux.pending.size }, bitmap: { ...s.bitmap.stats, active: s.bitmap.active, drawn: s.bitmap.drawn, demux: s.bdemux.stats } },
    net: p?.source && { requests: p.source.requests, retries: p.source.retries || 0, fetchedMB: +(p.source.bytesFetched / 1048576).toFixed(1), size: p.source.size },
    feed: p?.run && { stage: p.run.stage, nv: p.run.nv, na: p.run.na, transcode: p.run.transcode },
  };
};
window.__watchSelectSub = n => selectSub(n, true);
window.__session = () => session;
window.__watchSelectAudio = id => session?.pipeline.selectAudio(id).then(renderAudioMenu);
