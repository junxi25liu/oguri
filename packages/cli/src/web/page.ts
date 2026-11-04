/**
 * The one page `oguri web` serves: inline CSS and JS, no CDN, no data.
 *
 * The page carries no network data in its HTML. It fetches JSON with the
 * bearer token it reads from the URL fragment, which the browser never sends
 * to the server or in a referrer. Everything it renders came from other
 * machines, so every value passes through `escapeHtml` before it reaches
 * `innerHTML` — and the function in the page is this exact function, inlined
 * with `toString()`, so the tested escaper is the one that runs.
 */

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/** Poll interval of the page, in milliseconds. */
export const POLL_MS = 5_000;

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1d2330;--muted:#6b7385;--card:#fff;--line:#e2e5ea;
--live:#1f9d55;--away:#9aa1ad;--stale:#c9a227;--warn:#c2410c;--bad:#b91c1c;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--fg:#e6e8ec;--muted:#8d95a5;--card:#1a1e26;
--line:#2a2f3a}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;
background:var(--bg);color:var(--fg)}header{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;
padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}h1{font-size:16px;margin:0}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:22px 0 8px}
main{padding:0 20px 40px;max-width:1400px}.muted{color:var(--muted)}.mono{font-family:ui-monospace,monospace;
font-size:12px}.banner{margin:12px 0;padding:10px 12px;border-radius:6px;background:#fde8e8;color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:0 0 8px}
.human .card{border-left:4px solid var(--warn)}.grid{display:grid;gap:10px;
grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}.cols{display:grid;gap:10px;
grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}.col h3{font-size:12px;margin:0 0 6px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:var(--away)}
.dot.live{background:var(--live)}.dot.stale{background:var(--stale)}.tag{display:inline-block;
padding:0 6px;border-radius:4px;border:1px solid var(--line);font-size:11px;margin-right:4px}
.tag.blocked,.tag.stuck{border-color:var(--warn);color:var(--warn)}.tag.completed{color:var(--live)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px}
td,th{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}details{margin:0 0 8px}summary{cursor:pointer}
.body{white-space:pre-wrap;word-break:break-word}.you .card{border-left:4px solid var(--accent)}
.src{background:var(--accent);color:#fff;border-color:var(--accent)}a{color:var(--accent)}
`;

/**
 * Client script. Plain ES2020, no framework. Builds markup as strings in
 * which every interpolated value is escaped, then assigns `innerHTML` once.
 */
function script(): string {
  return `
"use strict";
${escapeHtml.toString()}
const esc = escapeHtml;
const POLL_MS = ${String(POLL_MS)};
const STATES = ["open","claimed","in_progress","blocked","stuck","completed","cancelled"];

function token() {
  const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem("oguri-token", decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname);
  }
  return sessionStorage.getItem("oguri-token");
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function list(values) {
  return Array.isArray(values) && values.length > 0 ? values.map(esc).join(", ") : "";
}

function section(title, inner) {
  return "<h2>" + esc(title) + "</h2>" + inner;
}

const REASONS = { "needs-human": "needs your decision", attention: "asked a question",
  "pull-request": "pull request to review" };

function badge(source) {
  return source ? '<span class="tag src">' + esc(source) + "</span>" : "";
}

// Only http(s) links become anchors; anything else is shown as text.
function link(url) {
  if (typeof url !== "string" || !/^https?:[/][/]/.test(url)) return "";
  return ' · <a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + "</a>";
}

function renderNeedsYou(items) {
  if (!items || items.length === 0) return "";
  return '<div class="you">' + section("Needs you (" + items.length + ")",
    items.map((i) => '<div class="card"><div>' + badge(i.source) + "<b>" + esc(i.title) + "</b></div>" +
      '<div class="muted">' + esc(REASONS[i.reason] || i.reason) + " · #" + esc(i.room) +
      (i.requester ? " · from " + esc(i.requester) : "") + " · " + esc(ago(i.since)) + link(i.link) +
      '</div><div class="muted mono">' + esc(i.taskId) + "</div></div>").join("")) + "</div>";
}

function renderHuman(items) {
  if (!items || items.length === 0) return "";
  return '<div class="human">' + section("Needs a human (" + items.length + ")",
    items.map((i) => '<div class="card"><div><b>#' + esc(i.room) + "</b> · " + esc(i.from) +
      ' <span class="muted">' + esc(ago(i.ts)) + '</span></div><div class="body">' +
      esc(i.excerpt) + '</div><div class="muted mono">' + esc(i.id) + "</div></div>").join("")) +
    "</div>";
}

function renderMachines(machines) {
  if (!machines) return "";
  const cards = machines.map((m) => '<div class="card"><div><b>' + esc(m.label || m.id || "unknown machine") +
    "</b>" + (m.self ? ' <span class="tag">this machine</span>' : "") +
    ' <span class="muted">' + esc(m.live) + " live</span></div>" +
    (m.agents || []).map((a) => '<div><span class="dot ' + esc(a.status) + '"></span>' + esc(a.id) +
      ' <span class="muted">' + esc(a.status) + (a.focus ? " · " + esc(a.focus) : "") +
      "</span></div>").join("") + "</div>").join("");
  return section("Machines and agents", '<div class="grid">' + cards + "</div>");
}

function renderTask(t) {
  const rel = [];
  if (t.assignee) rel.push("assignee " + esc(t.assignee));
  if (t.assigneeMachine) rel.push("on " + esc(t.assigneeMachine));
  else if (t.target) rel.push("for " + esc(t.target));
  if (list(t.dependsOn)) rel.push("depends on " + list(t.dependsOn));
  if (t.parent) rel.push("parent " + esc(t.parent));
  if (list(t.children)) rel.push("children " + list(t.children));
  if (t.requester) rel.push("requested by " + esc(t.requester));
  return '<div class="card"><div>' + badge(t.source) + "<b>" + esc(t.title) + '</b></div><div class="muted">#' + esc(t.room) +
    " · " + esc(ago(t.updatedAt)) + (t.health !== "active" && t.health !== "done"
      ? ' <span class="tag ' + esc(t.health) + '">' + esc(t.health) + "</span>" : "") +
    "</div>" + (rel.length ? '<div class="muted">' + rel.join(" · ") + "</div>" : "") +
    '<div class="muted mono">' + esc(t.id) + "</div></div>";
}

function renderTasks(rooms) {
  const all = [];
  for (const r of rooms || []) for (const t of r.tasks || []) all.push(Object.assign({ room: r.room }, t));
  if (all.length === 0) return section("Tasks", '<p class="muted">No tasks in subscribed rooms.</p>');
  const cols = STATES.map((s) => {
    const items = all.filter((t) => t.state === s);
    if (items.length === 0) return "";
    return '<div class="col"><h3><span class="tag ' + esc(s) + '">' + esc(s.replace("_", " ")) +
      "</span> " + items.length + "</h3>" + items.map(renderTask).join("") + "</div>";
  }).join("");
  return section("Tasks", '<div class="cols">' + cols + "</div>");
}

function renderRuns(runs) {
  if (!runs || runs.length === 0) return section("Worker runs on this machine",
    '<p class="muted">No local runs recorded.</p>');
  const rows = runs.map((r) => "<tr><td>" + esc(r.outcome) + '</td><td class="mono">' + esc(r.taskId) +
    "</td><td>" + esc(r.title) + "</td><td>#" + esc(r.room) + "</td><td>" + esc(r.runner) + "</td><td>" +
    esc(r.exitCode === undefined || r.exitCode === null ? "" : r.exitCode) + "</td><td>" +
    esc(ago(r.startedAt)) + "</td></tr>").join("");
  return section("Worker runs on this machine", "<table><tr><th>outcome</th><th>task</th><th>title</th>" +
    "<th>room</th><th>runner</th><th>exit</th><th>started</th></tr>" + rows + "</table>");
}

function renderMessages(rooms) {
  const blocks = (rooms || []).map((r) => "<details><summary><b>#" + esc(r.room) + '</b> <span class="muted">' + esc((r.messages || []).length) +
    " recent" + (r.error ? " · " + esc(r.error) : "") + "</span></summary>" +
    (r.messages || []).map((m) => '<div class="card"><div>' + esc(m.from) +
      (m.external ? ' <span class="tag src">' + esc(m.external) + "</span>" : "") + ' <span class="muted">' +
      esc(m.kind) + (m.needs !== "none" ? " · needs " + esc(m.needs) : "") +
      (m.relay ? " · relay " + esc(m.relay) : "") + " · " + esc(ago(m.ts)) +
      '</span></div><div class="body">' + esc(m.excerpt) + "</div></div>").join("") + "</details>").join("");
  return section("Recent messages", blocks || '<p class="muted">No subscribed rooms.</p>');
}

async function refresh() {
  const headers = {};
  const t = token();
  if (t) headers["authorization"] = "Bearer " + t;
  const state = document.getElementById("state");
  try {
    const res = await fetch("/api/dashboard", { headers, cache: "no-store" });
    if (res.status === 401) throw new Error("unauthorised: open the URL with #token=… that oguri web printed");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    document.getElementById("who").textContent = (d.agent || "") + " · " + (d.network || "") + " · " + d.mode;
    const banner = (d.errors || []).length
      ? '<div class="banner">' + d.errors.map(esc).join("<br>") + "</div>" : "";
    document.getElementById("app").innerHTML = banner + renderNeedsYou(d.needsYou) + renderHuman(d.needsHuman) +
      renderMachines(d.machines) + renderTasks(d.rooms) + renderRuns(d.runs) + renderMessages(d.rooms);
    state.textContent = "updated " + new Date().toLocaleTimeString();
  } catch (e) {
    state.textContent = String(e && e.message ? e.message : e);
  }
}

refresh();
setInterval(refresh, POLL_MS);
`;
}

/** Render the page. `nonce` must match the CSP header the server sends with it. */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>oguri</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header><h1>oguri</h1><span id="who" class="muted"></span><span id="state" class="muted">loading…</span>
<span class="muted">read-only</span></header>
<main id="app"></main>
<script nonce="${nonce}">${script()}</script>
</body>
</html>
`;
}
