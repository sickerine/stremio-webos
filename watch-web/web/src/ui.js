// Player chrome: media-chrome for the standard controls (volume, fullscreen, PiP,
// time display, keyboard), plus our own audio/subtitle menus since track lists come
// from our demuxer, not from the <video>. Play/pause/seek belong to the TV: the play
// button is omitted and the time range is display-only.
import "media-chrome";

const ICONS = {
  audio: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  subs: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/></svg>',
};

export function buildUi(root) {
  root.innerHTML = `
    <div class="stage">
    <media-controller autohide="2" nohotkeys="false" keyboardforwardseekoffset="0" keyboardbackwardseekoffset="0">
      <video slot="media" playsinline crossorigin="anonymous"></video>
      <div class="hud" slot="top-chrome">
        <div class="now">
          <div class="kicker" data-kicker>Live with the TV</div>
          <div class="title" data-title></div>
          <div class="meta"><span class="pill warn" data-conn>Connecting</span><span class="pill quiet" data-stats hidden></span><span class="pill" data-tv hidden></span></div>
        </div>
      </div>
      <div class="overlay" slot="centered-chrome" data-overlay>
        <div class="brand"><i></i>Stremio Watch</div>
        <div class="center">
          <div class="eyebrow"><span class="beat"></span><span data-eyebrow>Standing by</span></div>
          <h1 data-ov-title>Waiting for the TV</h1>
          <p class="lead" data-ov-body>The moment something plays on the TV, it appears here and stays in sync. Nothing to click.</p>
          <div class="steps" data-steps hidden>
            <div class="step" data-step="resolve"><span class="dot">✓</span><span>Locating the stream</span></div>
            <div class="step" data-step="open"><span class="dot">✓</span><span>Reading tracks, subtitles and fonts</span></div>
            <div class="step" data-step="load"><span class="dot">✓</span><span>Loading video at the TV's position</span></div>
          </div>
        </div>
        <div class="foot">
          <div class="pills"><span class="pill warn" data-conn2>Connecting</span><span class="pill quiet" data-room></span></div>
          <span class="hint" data-hint></span>
        </div>
      </div>
      <button class="sound" data-sound hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>Tap for sound</button>
      <media-control-bar>
        <media-time-display showduration></media-time-display>
        <media-time-range class="locked"></media-time-range>
        <media-mute-button></media-mute-button>
        <media-volume-range></media-volume-range>
        <span class="sep"></span>
        <media-chrome-button data-audio-btn title="Audio">${ICONS.audio}</media-chrome-button>
        <media-chrome-button data-subs-btn title="Subtitles">${ICONS.subs}</media-chrome-button>
        <media-pip-button></media-pip-button>
        <media-fullscreen-button></media-fullscreen-button>
      </media-control-bar>
    </media-controller>
    <!-- libass overlay: a plain sibling of media-controller, so it is never subject
         to the player's shadow-DOM slot layout (which sized jassub's canvas to 0). -->
    <div class="ass-layer" data-ass-layer></div>
    <div class="menu" data-audio-menu role="menu" hidden></div>
    <div class="menu" data-subs-menu role="menu" hidden></div>
    </div>`;

  const q = s => root.querySelector(s);
  const el = {
    controller: q("media-controller"), video: q("video"), assLayer: q("[data-ass-layer]"), conn: q("[data-conn]"), tv: q("[data-tv]"), title: q("[data-title]"), stats: q("[data-stats]"),
    overlay: q("[data-overlay]"), ovTitle: q("[data-ov-title]"), ovBody: q("[data-ov-body]"), eyebrow: q("[data-eyebrow]"), steps: q("[data-steps]"), conn2: q("[data-conn2]"), room: q("[data-room]"), hint: q("[data-hint]"), kicker: q("[data-kicker]"), sound: q("[data-sound]"),
    audioBtn: q("[data-audio-btn]"), audioMenu: q("[data-audio-menu]"), subsBtn: q("[data-subs-btn]"), subsMenu: q("[data-subs-menu]"),
  };

  // The TV is the only thing allowed to play/pause/seek. Swallow the surfaces that would.
  const block = e => { e.stopImmediatePropagation(); e.preventDefault(); };
  el.video.addEventListener("click", block, true);
  el.video.addEventListener("dblclick", block, true);
  el.controller.addEventListener("keydown", e => { if ([" ", "k", "K", "ArrowLeft", "ArrowRight", "j", "l", "J", "L", "Home", "End", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].includes(e.key)) block(e); }, true);

  const stage = root.querySelector(".stage");
  // While a menu is open, hold the control bar visible (autohide off); restore after.
  function closeMenus() { el.audioMenu.hidden = true; el.subsMenu.hidden = true; el.controller.setAttribute("autohide", "2"); }
  function toggleMenu(menu, other, button) {
    other.hidden = true;
    if (!menu.hidden) { closeMenus(); return; }
    // anchor above the button, right-aligned to it
    const s = stage.getBoundingClientRect(), b = button.getBoundingClientRect();
    menu.style.right = `${Math.max(8, s.right - b.right)}px`;
    menu.style.bottom = `${Math.max(8, s.bottom - b.top + 8)}px`;
    menu.hidden = false;
    el.controller.setAttribute("autohide", "-1");
  }
  el.audioBtn.addEventListener("click", e => { e.stopPropagation(); toggleMenu(el.audioMenu, el.subsMenu, el.audioBtn); });
  el.subsBtn.addEventListener("click", e => { e.stopPropagation(); toggleMenu(el.subsMenu, el.audioMenu, el.subsBtn); });
  document.addEventListener("click", e => { if (!e.target.closest(".menu")) closeMenus(); });
  // the bar auto-hides on inactivity; a floating menu must not outlive it
  new MutationObserver(() => { if (el.controller.hasAttribute("userinactive")) closeMenus(); })
    .observe(el.controller, { attributes: true, attributeFilter: ["userinactive"] });

  function renderMenu(menu, heading, items, selectedId, onPick, { allowOff = false } = {}) {
    menu.innerHTML = `<h4>${heading}</h4>`;
    if (allowOff) items = [{ id: null, label: "Off" }, ...items];
    if (!items.length) { menu.insertAdjacentHTML("beforeend", `<div class="empty">None in this file</div>`); return; }
    for (const it of items) {
      const b = document.createElement("button");
      b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(it.id === selectedId));
      b.innerHTML = `<span class="check">${it.id === selectedId ? "✓" : ""}</span><span class="label">${it.label}</span>${it.sub ? `<span class="sub">${it.sub}</span>` : ""}`;
      b.addEventListener("click", () => { onPick(it.id); closeMenus(); });
      menu.appendChild(b);
    }
  }

  return {
    el,
    setConnection(status) {
      const map = { connecting: ["Connecting", "warn"], connected: ["Connected", "ok"], reconnecting: ["Reconnecting", "bad"] };
      const [label, cls] = map[status] || [status, "warn"];
      for (const p of [el.conn, el.conn2]) { p.textContent = label; p.className = `pill ${cls}`; }
    },
    setKicker(text) { el.kicker.textContent = text; },
    setEyebrow(text) { el.eyebrow.textContent = text; },
    setRoom(text) { el.room.textContent = text; el.room.hidden = !text; },
    setHint(text) { el.hint.textContent = text || ""; },
    // stage: null (idle, steps hidden) | "resolve" | "open" | "load" | "done"
    setStage(stage) {
      const order = ["resolve", "open", "load"];
      el.steps.hidden = !stage;
      const idx = stage === "done" ? order.length : order.indexOf(stage);
      el.steps.querySelectorAll(".step").forEach((node, i) => { node.classList.toggle("done", i < idx); node.classList.toggle("active", i === idx); });
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
