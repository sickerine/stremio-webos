// Player chrome: media-chrome for the standard controls (volume, fullscreen, PiP,
// time display, keyboard), plus our own audio/subtitle menus since track lists come
// from our demuxer, not from the <video>. Play/pause/seek belong to the TV: the play
// button is omitted and the time range is display-only.
import "media-chrome";

const ICONS = {
  audio: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  subs: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>',
};

export function buildUi(root) {
  root.innerHTML = `
    <media-controller autohide="2" nohotkeys="false" keyboardforwardseekoffset="0" keyboardbackwardseekoffset="0">
      <video slot="media" playsinline crossorigin="anonymous"></video>
      <div class="hud" slot="top-chrome">
        <span class="pill warn" data-conn>Connecting</span>
        <span class="pill" data-tv hidden></span>
        <span class="title" data-title></span>
        <span class="pill" data-stats hidden></span>
      </div>
      <div class="overlay" slot="centered-chrome" data-overlay>
        <div><div class="spinner"></div><h1 data-ov-title>Waiting for the TV</h1><p data-ov-body>Playback appears here automatically when the TV plays something.</p></div>
      </div>
      <button class="sound" data-sound hidden>Tap for sound</button>
      <media-control-bar>
        <media-time-display showduration></media-time-display>
        <media-time-range class="locked"></media-time-range>
        <media-mute-button></media-mute-button>
        <media-volume-range></media-volume-range>
        <span class="menu-btn"><media-chrome-button data-audio-btn title="Audio">${ICONS.audio}</media-chrome-button><div class="menu" data-audio-menu hidden></div></span>
        <span class="menu-btn"><media-chrome-button data-subs-btn title="Subtitles">${ICONS.subs}</media-chrome-button><div class="menu" data-subs-menu hidden></div></span>
        <media-pip-button></media-pip-button>
        <media-fullscreen-button></media-fullscreen-button>
      </media-control-bar>
    </media-controller>`;

  const q = s => root.querySelector(s);
  const el = {
    controller: q("media-controller"), video: q("video"), conn: q("[data-conn]"), tv: q("[data-tv]"), title: q("[data-title]"), stats: q("[data-stats]"),
    overlay: q("[data-overlay]"), ovTitle: q("[data-ov-title]"), ovBody: q("[data-ov-body]"), sound: q("[data-sound]"),
    audioBtn: q("[data-audio-btn]"), audioMenu: q("[data-audio-menu]"), subsBtn: q("[data-subs-btn]"), subsMenu: q("[data-subs-menu]"),
  };

  // The TV is the only thing allowed to play/pause/seek. Swallow the surfaces that would.
  const block = e => { e.stopImmediatePropagation(); e.preventDefault(); };
  el.video.addEventListener("click", block, true);
  el.video.addEventListener("dblclick", block, true);
  el.controller.addEventListener("keydown", e => { if ([" ", "k", "K", "ArrowLeft", "ArrowRight", "j", "l", "J", "L", "Home", "End", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(e.key)) block(e); }, true);

  function toggleMenu(menu, other) { other.hidden = true; menu.hidden = !menu.hidden; }
  el.audioBtn.addEventListener("click", () => toggleMenu(el.audioMenu, el.subsMenu));
  el.subsBtn.addEventListener("click", () => toggleMenu(el.subsMenu, el.audioMenu));
  document.addEventListener("click", e => { if (!e.target.closest(".menu-btn")) { el.audioMenu.hidden = true; el.subsMenu.hidden = true; } });

  function renderMenu(menu, heading, items, selectedId, onPick, { allowOff = false } = {}) {
    menu.innerHTML = `<h4>${heading}</h4>`;
    if (allowOff) items = [{ id: null, label: "Off" }, ...items];
    if (!items.length) { menu.insertAdjacentHTML("beforeend", `<div class="empty">None in this file</div>`); return; }
    for (const it of items) {
      const b = document.createElement("button");
      b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(it.id === selectedId));
      b.innerHTML = `<span>${it.label}</span>${it.sub ? `<span class="sub">${it.sub}</span>` : ""}`;
      b.addEventListener("click", () => { onPick(it.id); menu.hidden = true; });
      menu.appendChild(b);
    }
  }

  return {
    el,
    setConnection(status) {
      const map = { connecting: ["Connecting", "warn"], connected: ["Linked to TV", "ok"], reconnecting: ["Reconnecting", "bad"] };
      const [label, cls] = map[status] || [status, "warn"]; el.conn.textContent = label; el.conn.className = `pill ${cls}`;
    },
    setTv(text) { el.tv.hidden = !text; el.tv.textContent = text || ""; },
    setTitle(text) { el.title.textContent = text || ""; },
    setStats(text) { el.stats.hidden = !text; el.stats.textContent = text || ""; },
    overlay(visible, title, body) { el.overlay.hidden = !visible; if (title != null) el.ovTitle.textContent = title; if (body != null) el.ovBody.textContent = body; },
    showSoundPrompt(show) { el.sound.hidden = !show; },
    onSound(fn) { el.sound.addEventListener("click", fn); },
    audioMenu(items, selectedId, onPick) { renderMenu(el.audioMenu, "Audio", items, selectedId, onPick); el.audioBtn.toggleAttribute("disabled", items.length < 2); },
    subsMenu(items, selectedId, onPick) { renderMenu(el.subsMenu, "Subtitles", items, selectedId, onPick, { allowOff: true }); },
  };
}
