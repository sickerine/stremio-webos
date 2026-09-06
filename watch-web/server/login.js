// Password gate page. One field, no username; a correct password sets a permanent cookie.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function loginPage({ next = "/", error = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch together</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; --ink: oklch(0.97 0.006 85); --ink-subtle: color-mix(in oklab, var(--ink) 62%, transparent); --surface: oklch(0.12 0.01 260);
    --control: color-mix(in oklab, var(--ink) 10%, transparent); --action: oklch(0.58 0.115 166); --danger: oklch(0.7 0.16 28); --ring: color-mix(in oklab, var(--action) 30%, transparent); }
  * { box-sizing: border-box } html, body { height: 100% } body { margin: 0; display: grid; place-items: center; padding: 1.5rem; background: var(--surface); color: var(--ink); font: 400 1rem/1.45 "Instrument Sans", system-ui, sans-serif; }
  form { width: min(22rem, 100%); display: grid; gap: .75rem }
  h1 { margin: 0 0 .25rem; font-size: 1.75rem; line-height: 1.1; letter-spacing: -.02em; font-weight: 600 }
  p { margin: 0 0 .75rem; color: var(--ink-subtle) }
  input { height: 2.75rem; padding: 0 1rem; border: 1px solid transparent; border-radius: 999px; background: var(--control); color: inherit; font: inherit; outline: none; transition: box-shadow 180ms, border-color 180ms }
  input:focus { border-color: var(--action); box-shadow: 0 0 0 4px var(--ring) }
  button { height: 2.75rem; padding: 0 1.25rem; border: 0; border-radius: 999px; background: var(--action); color: white; font: inherit; font-weight: 600; cursor: pointer; transition: transform 180ms cubic-bezier(.2,.8,.2,1), filter 180ms }
  button:hover { filter: brightness(1.08) } button:active { transform: scale(.97) }
  .error { color: var(--danger); margin: 0 }
</style></head>
<body><form method="post" action="/login?next=${esc(encodeURIComponent(next))}">
  <h1>Watch together</h1><p>Enter the password to join.</p>
  <input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password" placeholder="Password">
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  <button type="submit">Enter</button>
</form></body></html>`;
}
