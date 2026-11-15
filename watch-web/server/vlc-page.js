// Instructions for watching in VLC on Windows, with the download for this viewer's room.
import { esc, shell } from "./login.js";
export function vlcPage({ room = "home", windows = true } = {}) {
  const watch = `/?room=${esc(encodeURIComponent(room))}`;
  const body = windows ? `<main>
  <h1>Watch in VLC</h1><p>VLC plays the stream itself and stays in step with the TV.</p>
  <ol>
    <li><span>Download the file.</span><a class="button" href="/vlc.cmd?room=${esc(encodeURIComponent(room))}" download>Download</a></li>
    <li><span>Open it. When Windows asks whether to run it, choose Run.</span></li>
    <li><span>VLC opens and follows the TV. A small window shows how it is doing. Closing VLC ends it.</span></li>
  </ol>
  <p class="note">If VLC is not installed, the file installs it first.</p>
  <a class="quiet" href="${watch}">Watch in the browser instead</a>
</main>` : `<main>
  <h1>Watch in VLC</h1><p>This needs a Windows PC. On this device, watch in the browser.</p>
  <a class="button" href="${watch}">Watch in the browser</a>
</main>`;
  return shell({ title: "Watch in VLC", style: `  main { width: min(30rem, 100%); display: grid; gap: .75rem; justify-items: start }
  .button { display: inline-grid; place-items: center; text-decoration: none; white-space: nowrap }
  ol { list-style: none; counter-reset: step; margin: .5rem 0; padding: 0; display: grid; gap: 1rem; width: 100% }
  li { counter-increment: step; display: grid; grid-template-columns: 1.25rem 1fr auto; align-items: center; gap: .75rem }
  li::before { content: counter(step); color: var(--ink-subtle); font-weight: 600; font-variant-numeric: tabular-nums }
  .note { margin: 0 }
  .quiet { color: var(--ink-subtle); text-underline-offset: .2em } .quiet:hover { color: var(--ink) }
`, body });
}
