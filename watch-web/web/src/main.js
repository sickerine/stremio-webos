import { buildUi } from "./ui.js";
import { connectRelay } from "./relay.js";
import { Pipeline } from "./player/pipeline.js";
import { SubtitleDemux, AssRenderer } from "./subtitles/ass.js";
import { TextSubtitles } from "./subtitles/text.js";
import { estimateTvPosition, syncAction } from "./sync.js";

const room = new URLSearchParams(location.search).get("room") || "home";
const ui = buildUi(document.getElementById("app"));
const video = ui.el.video;
video.muted = true;

let tvState = null;              // last TV sample (+receivedAtMs)
let session = null;              // { id, cdnUrl, pipeline, demux, ass, text, subTracks, selectedSub }
let audioUnlocked = false;
let seeking = false;

const prefs = { audio: localStorage.getItem("watch.audio") || "", subs: localStorage.getItem("watch.subs") || "eng" };

function fmtLang(code) { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch { return code || "und"; } }

function showIdle() { ui.overlay(true, "Waiting for the TV", "Playback appears here automatically when the TV plays something."); ui.setTv(""); ui.setTitle(""); ui.setStats(""); }

async function endSession() {
  const s = session; session = null;
  if (!s) return;
  await s.ass.hide(); s.text.hide(); s.demux.dispose();
  await s.pipeline.close();
}

async function startSession(sessionId, cdnUrl, size) {
  await endSession();
  ui.overlay(true, "Opening the stream", "Reading the file's tracks.");
  const s = { id: sessionId, cdnUrl, size, subTracks: [], selectedSub: null, fonts: 0 };
  s.ass = new AssRenderer(video);
  s.text = new TextSubtitles(video);
  s.demux = new SubtitleDemux({
    onTracks: tracks => { s.subTracks = tracks; s.ass.setTracks(tracks); s.text.setTracks(tracks); renderSubsMenu(); autoSelectSub(); },
    onFont: f => { s.fonts++; s.ass.addFont(f); },
    onCue: (n, cue) => { s.ass.addCue(n, cue); s.text.addCue(n, cue); },
  });
  s.pipeline = new Pipeline(video, {
    onTracks: t => { renderAudioMenu(); ui.setStats(`${t.video.width}x${t.video.height} ${t.video.codec}${t.video.hdr ? " HDR" : ""}`); },
    onError: e => { console.error(e); if (session === s) ui.overlay(true, "Playback problem", e.message); },
  });
  session = s;
  try {
    await s.pipeline.open(cdnUrl, { tee: s.demux, size });
    if (session !== s) return;
    // walk the header for subtitle tracks + fonts (tracks usually arrive within the first MB)
    void s.pipeline.source.prefetch(0, 16 * 1024 * 1024).catch(() => {});
    const startAt = estimateTvPosition(tvState) ?? 0;
    const preferred = prefs.audio && s.pipeline.tracks.audios.find(a => a.language === prefs.audio && a.playable)?.id;
    await s.pipeline.start(startAt, preferred ?? undefined);
    if (session !== s) return;
    video.currentTime = startAt;
    ui.overlay(true, "Loading video", "Catching up to the TV.");
  } catch (e) {
    console.error(e);
    if (session === s) ui.overlay(true, "Can't play this stream", e.message);
  }
}

function renderAudioMenu() {
  const s = session; if (!s?.pipeline.tracks) return;
  const items = s.pipeline.tracks.audios.map(a => ({ id: a.id, label: fmtLang(a.language) + (a.name ? ` · ${a.name}` : ""), sub: `${String(a.codec).toUpperCase()} ${a.channels}ch${a.playable ? "" : " · unsupported"}` }));
  ui.audioMenu(items, s.pipeline.selectedAudioId, async id => {
    const a = s.pipeline.tracks.audios.find(x => x.id === id); if (!a?.playable) return;
    localStorage.setItem("watch.audio", a.language || ""); prefs.audio = a.language || "";
    await s.pipeline.selectAudio(id); renderAudioMenu();
  });
}
function renderSubsMenu() {
  const s = session; if (!s) return;
  const items = s.subTracks.map(t => ({ id: t.number, label: fmtLang(t.language || "eng") + (t.name ? ` · ${t.name}` : ""), sub: (t.type || "").toUpperCase() }));
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

  const act = syncAction(video.currentTime, target);
  if (act.type === "seek") {
    seeking = true;
    try { await s.pipeline.seekTo(target); } finally { seeking = false; }
    video.playbackRate = 1;
  } else video.playbackRate = act.playbackRate;

  if (video.readyState >= 3 && !ui.el.overlay.hidden && Math.abs(video.currentTime - target) < 2) ui.overlay(false);
  else if (video.readyState < 3 && s.pipeline.isBuffered(target) === false && ui.el.overlay.hidden) { /* stalled; leave player visible */ }
}
setInterval(follow, 250);

video.addEventListener("waiting", () => ui.setTv(tvState?.paused ? "TV paused" : "Buffering"));
video.addEventListener("playing", () => ui.setTv(tvState?.paused ? "TV paused" : ""));

ui.onSound(() => { audioUnlocked = true; video.muted = false; ui.showSoundPrompt(false); if (tvState && !tvState.paused) video.play().catch(() => { video.muted = true; ui.showSoundPrompt(true); }); });
video.addEventListener("playing", () => { if (!audioUnlocked && video.muted) ui.showSoundPrompt(true); }, { once: true });

connectRelay({
  room,
  onConnection: st => ui.setConnection(st),
  onState: state => {
    tvState = { ...state, receivedAtMs: Date.now() };
    ui.setTitle(state.title || state.episodeId || "");
    ui.setTv(state.paused ? "TV paused" : "");
    if (session && session.id !== state.sessionId) { void endSession(); ui.overlay(true, "Switching stream", "The TV changed what it's playing."); }
  },
  onMedia: (cdnUrl, sessionId, { size, resolveError } = {}) => {
    if (resolveError) console.warn("resolve failed, using original url:", resolveError);
    if (!session || session.id !== sessionId) void startSession(sessionId, cdnUrl, size);
  },
  onIdle: () => { void endSession(); tvState = null; showIdle(); },
});
showIdle();
