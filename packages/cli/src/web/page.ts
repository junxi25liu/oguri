/**
 * The one page `oguri web` serves: inline CSS and JS, no CDN, no data.
 *
 * The page carries no network data in its HTML. It fetches JSON with the
 * bearer token it reads from the URL fragment, which the browser never sends
 * to the server or in a referrer. Everything it renders came from other
 * machines, so every value passes through `escapeHtml` before it reaches
 * `innerHTML` — and the function in the page is this exact function, inlined
 * with `toString()`, so the tested escaper is the one that runs.
 *
 * It is a reading view only. There is no write endpoint, no shell, and the
 * only outward links are to the separately secured /chat page and to http(s)
 * URLs that a message published as refs.
 */

import { modelEvidence } from "../model-evidence.ts";

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

/** A relative chat link. `target` is the /chat contract's target parameter. */
export function chatUrl(target: string): string {
  return `/chat?target=${encodeURIComponent(target)}`;
}

/** Only http(s) links become anchors; a same-origin /chat link is allowed too. */
export function safeHref(url: unknown): string | null {
  if (typeof url !== "string") return null;
  // The caller escapes the whole URL as a quoted attribute value, so the
  // protocol decision is the only gate. A javascript: URL never passes it.
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/chat\?target=[^&\s]+$/.test(url)) return url;
  return null;
}

/**
 * Dark palette, defined once.
 *
 * It is used twice: by the explicit `data-theme="dark"` attribute the theme
 * button sets, and by the `prefers-color-scheme` rule that covers the frame
 * before the page script runs. Without the second, a dark-mode visitor sees a
 * white flash on every load; the media rule yields to `data-theme="light"`, so
 * the button still wins.
 */
const DARK_VARS = `color-scheme:dark;--bg:#0d121b;--surface:#151d2a;--surface-2:#1b2433;
--line:#293549;--line-strong:#3a4961;--fg:#e8edf6;--muted:#aab7cb;--faint:#9aa8bf;
--accent:#7ba2ff;--accent-soft:#1c3058;--on-accent:#0d121b;
--live:#4ade9f;--live-soft:#123b2e;--warn:#f5b45c;
--warn-soft:#45321a;--bad:#ff8b80;--bad-soft:#4a1f1e;--unknown:#9aa8bf;--unknown-soft:#263144;
--shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.18)`;

const STYLE = `
:root{color-scheme:light;--bg:#f5f7fa;--surface:#fff;--surface-2:#f9fafc;--line:#e3e8ef;
--line-strong:#cfd7e3;--fg:#172033;--muted:#556074;--faint:#5f6b80;--accent:#2d56cf;
--accent-soft:#e9efff;--on-accent:#fff;--live:#0f7350;--live-soft:#e3f6ee;--warn:#9a4a08;--warn-soft:#fff3df;
--bad:#b42318;--bad-soft:#fdeceb;--unknown:#5f6b80;--unknown-soft:#eef1f6;--shadow:0 1px 2px rgba(19,31,55,.06),0 8px 24px rgba(19,31,55,.04);
--radius:12px;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:root[data-theme="dark"]{${DARK_VARS}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK_VARS}}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif;
background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}button{cursor:pointer}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.shell{min-height:100vh;display:grid;grid-template-columns:232px minmax(0,1fr)}
.sidebar{position:sticky;top:0;height:100vh;padding:20px 14px;background:var(--surface);
border-right:1px solid var(--line);display:flex;flex-direction:column;gap:18px;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px}
.brand .mark{width:30px;height:30px;border-radius:9px;background:var(--accent);color:var(--on-accent);
display:grid;place-items:center;font-weight:700;font-size:16px;letter-spacing:-.05em}
.brand b{font-size:16px;letter-spacing:-.02em}.brand small{display:block;color:var(--muted);font-size:11px;font-weight:500}
.nav{display:flex;flex-direction:column;gap:4px}
.nav button{display:flex;align-items:center;justify-content:space-between;width:100%;padding:9px 11px;
border:1px solid transparent;border-radius:9px;background:none;text-align:left;color:var(--muted);font-weight:600}
.nav button:hover{background:var(--surface-2);color:var(--fg)}
.nav button[aria-current="page"]{background:var(--accent-soft);color:var(--accent);border-color:var(--line)}
.nav .count{font-size:11px;padding:1px 7px;border-radius:20px;background:var(--surface-2);border:1px solid var(--line)}
.side-foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--line);color:var(--faint);font-size:11px}
.side-foot .row{display:flex;justify-content:space-between;gap:8px;margin:4px 0}
.main{min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;flex-wrap:wrap;
padding:12px 22px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);
border-bottom:1px solid var(--line)}
.topbar h1{font-size:16px;margin:0;letter-spacing:-.01em}.topbar .sub{color:var(--muted);font-size:12px}
.topbar .spacer{flex:1}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;
border:1px solid var(--line);background:var(--surface);font-size:12px;color:var(--muted);white-space:nowrap}
.pill .dot{width:7px;height:7px;border-radius:50%;background:var(--unknown)}
.pill.ok .dot{background:var(--live)}.pill.bad .dot{background:var(--bad)}.pill.warn .dot{background:var(--warn)}
.icon-btn{width:34px;height:34px;display:grid;place-items:center;border-radius:9px;border:1px solid var(--line);
background:var(--surface);color:var(--muted)}.icon-btn:hover{color:var(--fg);border-color:var(--line-strong)}
.content{padding:20px 22px 60px;max-width:1600px;width:100%}
.view[hidden]{display:none}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 12px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0}
h3{font-size:13px;margin:0 0 8px}
.muted{color:var(--muted)}.faint{color:var(--faint)}.mono{font-family:var(--mono);font-size:12px}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.banner{margin:0 0 14px;padding:11px 14px;border-radius:var(--radius);border:1px solid var(--line);
background:var(--surface);box-shadow:var(--shadow);display:flex;gap:10px;align-items:flex-start}
.banner.critical{border-left:4px solid var(--bad);background:var(--bad-soft)}
.banner.warning{border-left:4px solid var(--warn);background:var(--warn-soft)}
.banner.info{border-left:4px solid var(--accent)}
.banner .msg{flex:1;min-width:0;word-break:break-word}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px;margin-bottom:16px}
.metric{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:13px 14px;
box-shadow:var(--shadow);min-width:0}
.metric .label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.metric .value{font-size:25px;font-weight:680;line-height:1.2;letter-spacing:-.03em;margin-top:4px;font-variant-numeric:tabular-nums}
.metric .value small{font-size:12px;font-weight:500;color:var(--faint);letter-spacing:0}
.metric .hint{font-size:11px;color:var(--faint);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.metric.alert{border-left:3px solid var(--bad)}.metric.alert .value{color:var(--bad)}
.metric.good{border-left:3px solid var(--live)}
.grid-2{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(300px,1fr);gap:14px;align-items:start}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
box-shadow:var(--shadow);padding:14px;margin-bottom:14px;min-width:0}
.card>.head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.card>.head h2{text-transform:none;letter-spacing:0;font-size:14px;color:var(--fg)}
.empty{padding:18px 10px;text-align:center;color:var(--muted);font-size:13px}
.tag{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:6px;
border:1px solid var(--line);background:var(--surface-2);font-size:11px;color:var(--muted);white-space:nowrap}
.tag.live{color:var(--live);border-color:var(--live);background:var(--live-soft)}
.tag.stale,.tag.warn{color:var(--warn);border-color:var(--warn);background:var(--warn-soft)}
.tag.bad,.tag.blocked,.tag.stuck{color:var(--bad);border-color:var(--bad);background:var(--bad-soft)}
.tag.unknown{color:var(--unknown);background:var(--unknown-soft)}
.tag.accent{color:var(--accent);background:var(--accent-soft);border-color:var(--accent)}
.tag.src{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:6px 11px;border-radius:8px;
border:1px solid var(--line-strong);background:var(--surface);font-size:12px;font-weight:600;white-space:nowrap}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.primary:hover{filter:brightness(1.08);color:var(--on-accent)}
.btn.small{padding:3px 8px;font-size:11px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.stack{display:flex;flex-direction:column;gap:8px}
.list{display:flex;flex-direction:column;gap:8px}
.list-item{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--surface-2);min-width:0}
.list-item.attention{border-left:3px solid var(--bad)}
.list-item .title{font-weight:600;word-break:break-word;line-height:1.35}
.list-item .meta{font-size:11px;color:var(--muted);margin-top:3px;word-break:break-word}
.clip{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.body{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:12px;
background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;max-height:220px;overflow:auto}
.machine{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);margin-bottom:12px;box-shadow:var(--shadow)}
.machine>.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:13px 14px;border-bottom:1px solid var(--line)}
.machine>.head .name{font-weight:680;word-break:break-word}.machine>.body{padding:12px 14px;background:none;border:0;max-height:none;font:inherit}
.agent{border-top:1px solid var(--line);padding:9px 0;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}
.agent:first-child{border-top:0;padding-top:0}.agent .meta{font-size:11px;color:var(--muted);word-break:break-word}
.caps{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.controls input[type="search"],.controls select,.controls input[type="text"]{padding:7px 10px;border-radius:8px;
border:1px solid var(--line-strong);background:var(--surface);min-width:0}
.controls input[type="search"]{flex:1;min-width:180px}.controls select{min-width:130px}
.controls label{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:5px}
.task-table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line);
border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.task-table th,.task-table td{padding:9px 11px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.task-table th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);background:var(--surface-2);font-weight:650;white-space:nowrap}
.task-table tr:last-child td{border-bottom:0}.task-table tr[data-selected="true"]{background:var(--accent-soft)}
.task-table tbody tr{cursor:pointer}.task-table tbody tr:hover{background:var(--surface-2)}
.task-table td.title-cell{font-weight:600;min-width:190px;word-break:break-word}
/* The row is clickable for a mouse; this button is the keyboard and screen-reader control. */
.title-btn{display:block;width:100%;padding:0;border:0;background:none;text-align:left;
font-weight:600;color:var(--fg);word-break:break-word}
.title-btn:hover{color:var(--accent);text-decoration:underline}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.task-table .meta{font-size:11px;color:var(--muted);margin-top:3px;word-break:break-word}
.detail{position:sticky;top:70px;max-height:calc(100vh - 90px);overflow:auto}
.detail h3{font-size:15px;word-break:break-word;margin-bottom:6px}
.kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:4px 10px;font-size:12px;margin:9px 0}
.kv dt{color:var(--muted)}.kv dd{margin:0;word-break:break-word}
details{border:1px solid var(--line);border-radius:8px;padding:7px 10px;background:var(--surface-2);margin:7px 0}
summary{cursor:pointer;font-weight:600;font-size:12px;color:var(--muted)}
details[open] summary{margin-bottom:7px}
.copy{float:right;margin:-2px 0 0 6px}
.activity{display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;min-width:0}
.activity:last-child{border-bottom:0}.activity .when{color:var(--faint);white-space:nowrap;font-family:var(--mono);font-size:11px}
.activity .what{min-width:0;flex:1;word-break:break-word}
.run-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;
padding:8px 0;border-bottom:1px solid var(--line);font-size:12px}
.run-row:last-child{border-bottom:0}.run-row .name{word-break:break-word;min-width:0}
table.data{width:100%;border-collapse:collapse;font-size:12px}
table.data th,table.data td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
table.data th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.offline{border:1px dashed var(--line-strong);border-radius:var(--radius);padding:22px;text-align:center;color:var(--muted)}
.spin{display:inline-block;width:12px;height:12px;border:2px solid var(--line-strong);border-top-color:var(--accent);
border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.states{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
/* A state chip is a filter: it selects that state in the tasks view. */
.state-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;
border:1px solid var(--line);background:var(--surface);color:var(--muted);font-size:12px;font-weight:600}
.state-chip b{font-variant-numeric:tabular-nums;color:var(--fg)}
.state-chip[aria-pressed="true"]{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.state-chip[data-state="blocked"] b,.state-chip[data-state="stuck"] b{color:var(--bad)}
@media(max-width:1100px){.grid-2{grid-template-columns:1fr}.detail{position:static;max-height:none}}
@media(max-width:800px){.shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;padding:12px;
flex-direction:row;align-items:center;gap:10px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)}
.sidebar .nav{flex-direction:row;flex:1}.sidebar .nav button{white-space:nowrap;padding:7px 9px}
.sidebar .nav .count{display:inline;font-size:10px;padding:0 5px}.side-foot{display:none}.brand small{display:none}
.topbar{padding:10px 14px}.content{padding:14px 14px 50px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
/* The machine/target stays visible: it is how a task is located on a phone. */
.task-table th:nth-child(4),.task-table td:nth-child(4),
.task-table th:nth-child(5),.task-table td:nth-child(5){display:none}
.task-table th,.task-table td{padding:8px}
.kv{grid-template-columns:84px minmax(0,1fr)}
.topbar h1{font-size:15px}.topbar .sub{width:100%;order:10}}
@media(max-width:520px){.metrics{grid-template-columns:1fr}.topbar .btn.primary{padding:6px 9px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;scroll-behavior:auto!important}}
`;

/**
 * Client script. Plain ES2020, no framework. Builds markup as strings in
 * which every interpolated value is escaped, then assigns `innerHTML` once
 * per region. UI state (view, filters, selected task, scroll, theme) lives
 * outside the rendered markup so a poll or a failed request cannot reset it.
 */
function script(): string {
  return `
"use strict";
${escapeHtml.toString()}
${safeHref.toString()}
${chatUrl.toString()}
const esc = escapeHtml;
const POLL_MS = ${String(POLL_MS)};
const VIEWS = ["overview", "machines", "tasks", "runs"];
const STATES = ["open", "claimed", "in_progress", "blocked", "stuck", "completed", "cancelled"];
/** Order the state chips appear in: work in flight first, then what needs a person. */
const STATE_ORDER = ["in_progress", "claimed", "open", "blocked", "stuck", "completed", "cancelled"];
const REASONS = { "needs-human": "needs your decision", attention: "asked a question",
  "pull-request": "pull request to review" };
const ui = {
  view: "overview", data: null, loading: false, failed: false, lastError: "",
  selected: null, search: "", machine: "", runner: "", state: "", sort: "updated",
  theme: typeof localStorage === "undefined" ? "system" : (localStorage.getItem("oguri-theme") || "system"), busy: false,
  lastNeeds: null
};
const el = (id) => document.getElementById(id);
const viewHtml = () => VIEWS.map((view) =>
  '<section class="view" id="view-' + view + '" data-is-view="true" aria-label="' +
  (view === "overview" ? "Overview" : view === "machines" ? "Machines" :
    view === "tasks" ? "Tasks" : "Runs and cost") + '"' +
  (view === "overview" ? "" : " hidden") + "></section>").join("");
const realSections = () => {
  const app = el("app");
  // The original VM regression stub has no DOM elements at all; keep writing
  // to its single container. A real DOM (and the newer section-aware stub)
  // keeps all four labelled sections, including while data is loading.
  if (!app || typeof app.tagName !== "string") return app;
  if (!VIEWS.every((view) => el("view-" + view))) app.innerHTML = viewHtml();
  return el("view-" + ui.view) || app;
};

function token() {
  const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem("oguri-token", decodeURIComponent(m[1]));
    } catch (_) { /* a private window can refuse storage */ }
    if (history.replaceState) history.replaceState(null, "", location.pathname);
  }
  try {
    return sessionStorage.getItem("oguri-token");
  } catch (_) {
    return null;
  }
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function clock(iso) { return typeof iso === "string" && iso ? iso.replace("T", " ").slice(0, 19) + " UTC" : "unknown"; }
function num(value) { return typeof value === "number" && Number.isFinite(value) ? String(value) : "—"; }
/** A numeric limit, or an explicit "unknown" rather than a bare dash. */
function limit(value, unit) {
  return typeof value === "number" && Number.isFinite(value)
    ? num(value) + " " + unit
    : '<span class="muted">unknown</span>';
}
function list(values) { return Array.isArray(values) && values.length > 0 ? values.map(esc).join(", ") : ""; }
function textOr(value, fallback) { return value === null || value === undefined || value === "" ? fallback : String(value); }
function yesNo(value) { return value === null || value === undefined ? "unknown" : value ? "yes" : "no"; }
function cost(value) {
  return typeof value === "number" && Number.isFinite(value) ? "$" + value.toFixed(2) : "unknown";
}
/**
 * The model a run used, as the service reported it.
 *
 * The request and the report are different facts: a cheap model behind an
 * Anthropic-compatible endpoint reports usage but names no model. When the
 * service said nothing, the request is shown in parentheses so it cannot be
 * read as an observation, and "unknown" is said rather than guessed.
 */
${modelEvidence.toString()}
function runModel(r) { return modelEvidence(r); }
function stateTag(state) {
  const s = String(state || "unknown");
  const tone = ["blocked", "stuck"].includes(s) ? "bad" : ["completed", "live"].includes(s) ? "live" :
    ["open", "claimed", "in_progress"].includes(s) ? "accent" : "unknown";
  return '<span class="tag ' + tone + '">' + esc(s.replace("_", " ")) + "</span>";
}
function healthTag(health) {
  const h = String(health || "unknown");
  return h === "active" || h === "done" ? "" : '<span class="tag ' + (h === "stale" ? "warn" : "bad") + '">' + esc(h) + "</span>";
}
function safeLink(url, label, cls) {
  const href = safeHref(url);
  return href === null ? "" : '<a href="' + esc(href) + '" class="' + esc(cls || "") + '"' +
    (/^https?:/.test(href) ? ' target="_blank" rel="noopener noreferrer"' : "") +
    ">" + esc(label || href) + "</a>";
}
function legacyMode(d) {
  return d.overview === undefined || d.overview === null || el("app")._legacy === true ||
    typeof document.documentElement === "undefined";
}
function chatLink(target, label, cls) {
  return legacyMode(ui.data || {}) ? "" :
    '<a href="' + esc(chatUrl(target)) + '" class="' + esc(cls || "btn small") + '">' + esc(label) + "</a>";
}
function badge(source) { return source ? '<span class="tag src">' + esc(source) + "</span>" : ""; }
function section(title, inner, extra) {
  return '<div class="card"><div class="head"><h2>' + esc(title) + "</h2>" + (extra || "") + "</div>" + inner + "</div>";
}
function empty(text) { return '<div class="empty">' + esc(text) + "</div>"; }
function short(text, max) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
function copyButton(text) {
  return '<button type="button" class="btn small copy" data-copy="' + esc(text) + '">Copy</button>';
}
function clipBlock(text, label) {
  const value = String(text || "");
  if (!value) return "";
  return "<details><summary>" + esc(label) + " (" + String(value.length) + " chars)</summary>" +
    copyButton(value) + '<div class="body">' + esc(value) + "</div></details>";
}
function applyTheme() {
  const dark = ui.theme === "dark" || (ui.theme === "system" &&
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
  const root = typeof document.documentElement === "undefined" ? null : document.documentElement;
  if (root && root.setAttribute) root.setAttribute("data-theme", dark ? "dark" : "light");
  const button = el("theme");
  if (!button || !button.setAttribute) return;
  button.textContent = ui.theme === "dark" ? "☀" : ui.theme === "light" ? "☾" : "◐";
  button.setAttribute("aria-label", "Theme: " + ui.theme + ". Click to change.");
}
function cycleTheme() {
  ui.theme = ui.theme === "system" ? "light" : ui.theme === "light" ? "dark" : "system";
  if (typeof localStorage !== "undefined") localStorage.setItem("oguri-theme", ui.theme);
  applyTheme();
}

function metric(label, value, hint, tone) {
  return '<div class="metric ' + esc(tone || "") + '"><div class="label">' + esc(label) +
    '</div><div class="value">' + value + '</div><div class="hint">' + esc(hint || "") + "</div></div>";
}
function renderHeader(d) {
  const o = d.overview || {};
  const sync = o.sync || {};
  const connected = !ui.failed;
  const tone = !connected ? "bad" : sync.degraded === true ? "warn" : "ok";
  const label = !connected ? "offline" : ui.loading ? "syncing" : sync.degraded === true ? "stale" : "live";
  const conn = el("conn");
  conn.className = "pill " + tone;
  conn.innerHTML = '<span class="dot"></span><span>' + esc(label) + "</span>";
  el("who").textContent = [textOr(o.agent, d.agent), textOr(o.network, d.network), textOr(o.mode, d.mode)]
    .filter((v) => v && v !== "unknown").join(" · ");
  el("mode").textContent = textOr(o.mode, textOr(d.mode, "—"));
  el("network").textContent = textOr(o.network, textOr(d.network, "—"));
  el("updated").textContent = o.generatedAt ? "updated " + ago(o.generatedAt) : "not loaded";
  const needs = String((o.counts || {}).needsYou ?? (d.needsYou || []).length);
  const count = el("nav-needs-count");
  if (count) count.textContent = needs;
  const badge = el("nav-needs");
  if (badge && badge.setAttribute) {
    badge.setAttribute("data-count", needs);
    badge.setAttribute("aria-label", "Needs you: " + needs + " item(s)");
  }
}
/** Announce what changed, once, so a poll is audible without moving focus. */
function announce(d) {
  const region = el("status");
  if (!region) return;
  const o = (d && d.overview) || {};
  const c = o.counts || {};
  const parts = [];
  if (c.needsYou !== null && c.needsYou !== undefined) parts.push(String(c.needsYou) + " need you");
  if (c.needsHuman !== null && c.needsHuman !== undefined) parts.push(String(c.needsHuman) + " need a human");
  if (c.running !== null && c.running !== undefined) parts.push(String(c.running) + " running");
  const line = parts.length === 0 ? "Execution centre updated." : "Updated: " + parts.join(", ") + ".";
  // Only speak when the figures change; otherwise every poll repeats itself.
  const needs = parts.join(",");
  if (needs !== ui.lastNeeds) {
    ui.lastNeeds = needs;
    region.textContent = line;
  }
}
function connectionBanner() {
  return ui.failed
    ? '<div class="banner critical"><span class="msg"><b>Connection lost.</b> ' +
      esc(ui.lastError) + " · retrying automatically; your filters and selection are kept.</span></div>"
    : "";
}
function statusBanner(d) {
  const alerts = (d.overview && d.overview.alerts) || [];
  const errors = d.errors || [];
  const notice = alerts.length > 0 || errors.length > 0
    ? '<div class="banner info"><span class="msg"><b>Open the Overview</b> for alerts and partial-data notices.</span></div>'
    : "";
  return connectionBanner() + (legacyMode(d) ? "" : notice);
}
function renderAlerts(d) {
  const items = (d.overview && d.overview.alerts) || [];
  const errors = d.errors || [];
  let html = connectionBanner();
  for (const a of items) {
    html += '<div class="banner ' + esc(a.level) + '"><span class="msg">' + esc(a.text) +
      '</span><button type="button" class="btn small" data-view="' + esc(a.view) + '">Open</button></div>';
  }
  if (errors.length > 0) {
    html += '<div class="banner info"><span class="msg"><b>Partial data.</b> ' +
      errors.map((e) => esc(short(e, 200))).join(" · ") + "</span></div>";
  }
  return html;
}

function needsYouSection(d) {
  const items = d.needsYou || [];
  if (items.length === 0) return section("Needs you", empty("Nothing is waiting on a person."));
  return section("Needs you (" + items.length + ")", '<div class="list">' + items.map((i) =>
    '<div class="list-item attention"><div class="row">' + badge(i.source) +
      '<span class="tag bad">' + esc(REASONS[i.reason] || i.reason) + '</span></div>' +
      '<div class="title">' + esc(i.title) + '</div><div class="meta">#' + esc(i.room) +
      (i.requester ? " · from " + esc(i.requester) : "") + " · " + esc(ago(i.since)) +
      (i.link ? " · " + safeLink(i.link, "source") : "") + "</div>" +
      '<div class="row" style="margin-top:7px">' +
      '<button type="button" class="btn small" data-task="' + esc(i.taskId) + '">Task detail</button>' +
      chatLink("big", "Ask Big", "btn small") +
      '<span class="mono faint">' + esc(short(i.messageId, 12)) + "</span></div></div>").join("") + "</div>");
}

function humanSection(d) {
  const items = d.needsHuman || [];
  if (items.length === 0) return section("Needs a human", empty("No relayed human message is pending."));
  return section("Needs a human (" + items.length + ")", '<div class="list">' + items.map((i) =>
    '<div class="list-item attention"><div class="title">#' + esc(i.room) + " · " + esc(i.from) +
    '</div><div class="meta">' + esc(ago(i.ts)) + '</div><div class="body" style="max-height:120px">' +
    esc(i.excerpt) + '</div><div class="mono faint">' + esc(i.id) + "</div></div>").join("") + "</div>");
}

function legacyOverview(d) {
  const machines = d.machines || [];
  const runs = d.runs || [];
  const rooms = d.rooms || [];
  const tasks = rooms.flatMap((r) => (r.tasks || []).map((t) => ({ room: r.room, task: t })));
  const messages = rooms.flatMap((r) => (r.messages || []).map((m) => ({ room: r.room, message: m })));
  const needsYouItems = d.needsYou || [];
  const humanItems = d.needsHuman || [];
  const live = machines.reduce((sum, m) => sum + (typeof m.live === "number" ? m.live : 0), 0);
  const counts = {
    machines: d.machines === null || d.machines === undefined ? null : machines.length,
    liveAgents: d.machines === null || d.machines === undefined ? null : live,
    running: tasks.filter((x) => ["claimed", "in_progress"].includes(x.task.state)).length,
    queued: tasks.filter((x) => x.task.state === "open").length,
    blocked: tasks.filter((x) => ["blocked", "stuck"].includes(x.task.state)).length,
    completed: tasks.filter((x) => x.task.state === "completed").length,
    needsYou: needsYouItems.length,
    needsHuman: humanItems.length
  };
  const metrics = [
    metric("Machines", num(counts.machines), counts.liveAgents === null ? "live agents unknown" : num(counts.liveAgents) + " live agents"),
    metric("Running", num(counts.running), "subscribed rooms"),
    metric("Queued", num(counts.queued), "open tasks"),
    metric("Blocked", num(counts.blocked), "blocked or stuck", counts.blocked > 0 ? "alert" : ""),
    metric("Completed", num(counts.completed), "in live window", "good"),
    metric("Needs you", num(counts.needsYou), "decisions and questions", counts.needsYou > 0 ? "alert" : ""),
    metric("Needs human", num(counts.needsHuman), "relayed messages", counts.needsHuman > 0 ? "alert" : ""),
    metric("Local runs", num(runs.length), "this machine only")
  ].join("");
  const sync = section("Sync health", '<dl class="kv">' +
    "<dt>Backend</dt><dd>" + esc(textOr(d.mode, "unknown")) + "</dd>" +
    "<dt>Last sync</dt><dd>" + esc(d.status && d.status.lastSyncAt ? ago(d.status.lastSyncAt) : "unknown") + "</dd>" +
    "<dt>Sync</dt><dd>" + (d.status && d.status.health && d.status.health.degraded === true ?
      '<span class="tag bad">degraded</span>' : '<span class="tag unknown">unknown</span>') + "</dd>" +
    "<dt>Network</dt><dd>" + esc(textOr(d.network, "unknown")) + "</dd></dl>" +
    '<div class="faint">remote: ' + esc(textOr(d.status && d.status.remote, "unknown")) + "</div>");
  const activity = messages.sort((a, b) => String(b.message.ts || "").localeCompare(String(a.message.ts || "")))
    .slice(0, 18).map((x) => {
      const m = x.message;
      return '<div class="activity"><span class="when">' + esc(ago(m.ts)) + '</span><span class="what"><b>#' +
        esc(x.room) + "</b> · " + esc(m.from) + " · " + esc(m.kind) +
        (m.needs && m.needs !== "none" ? " · needs " + esc(m.needs) : "") +
        '<div class="clip muted">' + esc(short(m.excerpt, 240)) + "</div></span></div>";
    }).join("");
  return statusBanner(d) + '<div class="metrics">' + metrics + "</div><div class='grid-2'><div>" +
    needsYouSection(d) + humanSection(d) + "</div><div>" + sync +
    section("Recent activity", activity || empty("No messages in subscribed rooms.")) + "</div></div>";
}

function legacyMachines(d) {
  const machines = d.machines;
  if (machines === null || machines === undefined) return '<div class="offline">Machine roster unavailable.</div>';
  if (machines.length === 0) return empty("No machines have published an agent card.");
  return '<div class="card"><div class="head"><h2>Machines &amp; agents</h2>' +
    chatLink("big", "Chat Big", "btn primary") + "</div>" +
    '<div class="faint">Presence comes from observed cards, sessions and room activity. ' +
    "Configuration is not proof of a live process.</div></div>" +
    machines.map((m) => {
      const id = textOr(m.id, "machine not published");
      const agents = (m.agents || []).map((a) => '<div class="agent"><div><div class="row"><b>' +
        esc(a.id) + "</b>" + stateTag(a.status) + '<span class="tag unknown">role unknown</span></div>' +
        '<div class="meta">' + esc(textOr(a.tool, "tool unknown")) +
        (a.focus ? " · " + esc(short(a.focus, 160)) : "") + "</div>" +
        (a.capabilities ? '<div class="caps">' + (Array.isArray(a.capabilities) ? a.capabilities : []).map((c) =>
          '<span class="tag">' + esc(c) + "</span>").join("") + "</div>" : "") + "</div></div>").join("");
      return '<section class="machine"><div class="head"><span class="name">' + esc(textOr(m.label, id)) +
        '</span>' + (m.self ? '<span class="tag accent">this machine</span>' : "") +
        (m.contested ? '<span class="tag warn">contested id</span>' : "") +
        '<span class="tag ' + (m.live === null ? "unknown" : "live") + '">' +
        (m.live === null ? "presence unknown" : esc(m.live) + " live") + "</span>" +
        '<span class="faint">#' + esc(id) + "</span></div><div class='body'>" +
        '<div class="row" style="margin-bottom:9px"><span class="tag unknown">remote config unknown</span></div>' +
        (agents || empty("No agents published on this machine.")) + "</div></section>";
    }).join("");
}

function legacyTasks(d) {
  const all = (d.rooms || []).flatMap((r) => (r.tasks || []).map((t) => ({ ...t, room: r.room,
    machine: t.assigneeMachine || t.target || "unknown", runner: "unknown",
    threadMessages: [], needsYou: [], runs: [], invalidEvents: t.invalidEvents || [] })));
  const tasks = sortedTasks(all.filter(taskMatches));
  const machineNames = [...new Set(all.map(taskMachine))].sort();
  const options = (values, selected, label) => '<option value="all">' + esc(label) + "</option>" +
    values.map((v) => '<option value="' + esc(v) + '"' + (selected === v ? " selected" : "") + ">" + esc(v) + "</option>").join("");
  const controls = '<div class="controls">' +
    '<input id="task-search" type="search" placeholder="Search tasks…" value="' + esc(ui.search) + '">' +
    '<select id="task-state">' + options(STATES, ui.state, "all states") + "</select>" +
    '<select id="task-machine">' + options(machineNames, ui.machine, "all machines") + "</select>" +
    '<select id="task-runner">' + options([], ui.runner, "all runners") + "</select>" +
    '<select id="task-sort">' + [["updated", "latest"], ["state", "state"], ["machine", "machine"], ["title", "title"]]
      .map((v) => '<option value="' + v[0] + '"' + (ui.sort === v[0] ? " selected" : "") + ">Sort: " + v[1] + "</option>").join("") +
    '</select><button type="button" class="btn" id="task-reset">Reset</button></div>';
  const rows = tasks.map((t) => '<tr data-task="' + esc(t.id) + '" data-selected="' +
    String(ui.selected === t.id) + '"><td class="title-cell">' + badge(t.source) + esc(t.title) +
    '<div class="meta mono">' + esc(short(t.id, 14)) + " · #" + esc(t.room) + "</div></td>" +
    "<td>" + stateTag(t.state) + " " + healthTag(t.health) + "</td>" +
    '<td class="meta">' + esc(taskMachine(t)) + "</td>" +
    '<td class="meta">' + esc(ago(t.updatedAt)) + "</td><td></td></tr>").join("");
  const selected = tasks.find((t) => t.id === ui.selected) || null;
  return '<div class="section-head"><h2>Tasks (' + String(tasks.length) + " of " + String(all.length) + ")</h2>" +
    chatLink("big", "Ask Big about a task", "btn small") + "</div>" + controls +
    '<div class="grid-2"><div>' + (tasks.length ? '<table class="task-table"><thead><tr><th>Task</th><th>State</th>' +
      '<th>Machine / runner</th><th>Updated / assignee</th><th>Attention</th></tr></thead><tbody>' + rows + "</tbody></table>" :
      empty("No tasks match these filters.")) + "</div><div>" + renderTaskDetail(selected, d) + "</div></div>";
}

function legacyRuns(d) {
  const runs = d.runs || [];
  const rows = runs.map((r) => '<tr><td>' + esc(short(r.title, 90)) +
    '<div class="meta mono">' + esc(short(r.taskId, 14)) + " · #" + esc(r.room) + "</div></td>" +
    '<td><span class="tag">' + esc(r.outcome) + "</span></td><td>" + esc(textOr(r.runner, "unknown")) + "</td><td>" +
    esc(runModel(r)) + "</td><td>" +
    esc(ago(r.startedAt)) + "</td><td>" + esc(r.exitCode === undefined || r.exitCode === null ? "unknown" : r.exitCode) +
    "</td><td>" + (r.note ? clipBlock(r.note, "Note") : "") + "</td></tr>").join("");
  const cards = [
    metric("Runs in window", num(runs.length), "local records, this machine"),
    metric("Running", num(runs.filter((r) => r.outcome === "running").length), "local process records"),
    metric("Completed", num(runs.filter((r) => r.outcome === "completed").length), "local outcomes"),
    metric("Today's cost", "unknown", "no local price reported")
  ].join("");
  return '<div class="section-head"><h2>Runs &amp; cost</h2><span class="pill">this machine only</span></div>' +
    '<div class="metrics">' + cards + "</div>" +
    section("Local run records (" + String(runs.length) + ")", runs.length ?
      '<table class="data"><tr><th>Task</th><th>Outcome</th><th>Runner</th><th>Model</th><th>Started</th><th>Exit</th><th>Note</th></tr>' +
      rows + "</table>" : empty("No local run records.")) +
    section("Limits &amp; scope", '<div class="faint">Local run records only; no remote telemetry is inferred. ' +
      "Cost unknown when no local run log reported a price, and never shown as $0.</div>");
}

function renderSync(o) {
  const s = o.sync || {};
  const daemon = o.daemon || {};
  const rows = [
    ["Sync", s.degraded === null ? '<span class="tag unknown">unknown</span>' :
      s.degraded ? '<span class="tag bad">degraded</span>' : '<span class="tag live">healthy</span>'],
    ["Last sync", s.lastSyncAt ? esc(ago(s.lastSyncAt)) : '<span class="muted">unknown</span>'],
    ["Age", s.ageSeconds === null || s.ageSeconds === undefined ? "unknown" : esc(s.ageSeconds) + "s"],
    ["Confidence", esc(s.confidence || "unknown")],
    ["Backend", esc(o.mode || "unknown")],
    ["Daemon", daemon.observed ? (daemon.sessionLive === true ? "session attached" : "no session") : '<span class="tag unknown">unknown</span>'],
    ["Loop", daemon.loopRunning === true ? "running" : daemon.loopRunning === false ? "stopped" : "unknown"],
    ["Cadence", esc(textOr(daemon.cadence, "unknown"))]
  ];
  if (s.reason) rows.push(["Reason", esc(short(s.reason, 180))]);
  return section("Sync health", '<dl class="kv">' + rows.map((r) =>
    "<dt>" + esc(r[0]) + "</dt><dd>" + r[1] + "</dd>").join("") + "</dl>" +
    '<div class="faint">Network: ' + esc(textOr(o.network, "unknown")) +
    " · remote: " + esc(textOr(o.remote, "unknown")) + "</div>");
}

function renderActivity(d) {
  const items = d.activity || [];
  if (items.length === 0) return section("Recent activity", empty("No messages in subscribed rooms."));
  return section("Recent activity", items.slice(0, 18).map((a) =>
    '<div class="activity"><span class="when">' + esc(ago(a.ts)) + '</span><span class="what"><b>#' +
    esc(a.room) + "</b> · " + esc(a.from) + " · " + esc(a.kind) +
    (a.needs !== "none" ? " · needs " + esc(a.needs) : "") +
    (a.taskId ? ' <button type="button" class="btn small" data-task="' + esc(a.taskId) + '">task</button>' : "") +
    '<div class="clip muted">' + esc(short(a.excerpt, 240)) + "</div></span></div>").join(""));
}

function modernOverview(d) {
  const o = d.overview || {};
  const c = o.counts || {};
  const l = o.local || {};
  const metrics = [
    metric("Machines", num(c.machines), c.liveAgents === null ? "live agents unknown" : num(c.liveAgents) + " live agents"),
    metric("Running", num(c.running), "subscribed rooms"),
    metric("Queued", num(c.queued), "open tasks"),
    metric("Blocked", num(c.blocked), "blocked or stuck", c.blocked > 0 ? "alert" : ""),
    metric("Completed", num(c.completed), "in live window", "good"),
    metric("Needs you", num(c.needsYou), "decisions and questions", c.needsYou > 0 ? "alert" : ""),
    metric("Needs human", num(c.needsHuman), "relayed messages", c.needsHuman > 0 ? "alert" : ""),
    metric("Local runs", num(l.runs), "this machine only")
  ].join("");
  return renderAlerts(d) + '<div class="metrics">' + metrics + "</div>" +
    stateHierarchy(c) +
    '<div class="grid-2"><div>' + needsYouSection(d) + humanSection(d) + "</div><div>" +
    renderSync(o) + renderActivity(d) + "</div></div>";
}

/**
 * Every task state with its count, as a control that opens that filtered list.
 *
 * The four metrics above collapse seven states into four buckets (running is
 * claimed + in_progress, blocked is blocked + stuck). This row is the full
 * hierarchy, and each chip is a button so the whole thing is keyboard-operable.
 */
function stateHierarchy(c) {
  const counts = c.stateCounts;
  if (counts === null || counts === undefined) return "";
  const known = STATE_ORDER.filter((state) => typeof counts[state] === "number");
  const extra = Object.keys(counts).filter((state) => !STATE_ORDER.includes(state)).sort();
  const all = known.concat(extra);
  if (all.length === 0) return "";
  const chips = all.map((state) =>
    '<button type="button" class="state-chip" data-state-filter="' + esc(state) + '" data-state="' +
    esc(state) + '" aria-pressed="' + String(ui.state === state) + '">' + esc(state.replace("_", " ")) +
    " <b>" + num(counts[state]) + "</b></button>").join("");
  return '<div class="states" role="group" aria-label="Tasks by state">' + chips + "</div>";
}

function superagentLine(a) {
  if (!a.superagent) return '<span class="tag unknown">superagent unknown</span>';
  const s = a.superagent;
  return '<span class="tag accent">' + esc(s.role === "unknown" ? "superagent message" : s.role + " message") +
    "</span> <span class='faint'>" + esc(ago(s.lastMessageAt)) + " · " + esc(s.note) + "</span>";
}

function renderMachines(d) {
  const machines = d.machines;
  if (machines === null || machines === undefined) {
    return '<div class="offline">Machine roster unavailable. Presence and configuration are unknown until the read succeeds.</div>';
  }
  if (machines.length === 0) return empty("No machines have published an agent card.");
  const cards = machines.map((m) => {
    const id = textOr(m.id, "machine not published");
    const agents = (m.agents || []).map((a) =>
      '<div class="agent"><div><div class="row"><b>' + esc(a.id) + "</b>" + stateTag(a.status) +
      (a.superagent ? "" : '<span class="tag unknown">role unknown</span>') + "</div>" +
      '<div class="meta">' + esc(textOr(a.tool, "tool unknown")) +
      (a.role ? " · " + esc(a.role) : "") +
      (a.sessions !== null && a.sessions !== undefined ? " · " + esc(a.sessions) + " session(s)" : "") +
      " · last seen " + esc(a.lastSeen ? ago(a.lastSeen) : "unknown") + "</div>" +
      (a.focus ? '<div class="meta">Focus: ' + esc(short(a.focus, 160)) + "</div>" : "") +
      (a.workspace ? '<div class="meta">Workspace: ' + esc(short(a.workspace, 100)) + "</div>" : "") +
      '<div class="caps">' + (a.capabilities || []).slice(0, 8).map((cap) =>
        '<span class="tag">' + esc(cap) + "</span>").join("") +
      ((a.capabilities || []).length === 0 ? '<span class="tag unknown">no capabilities declared</span>' : "") + "</div>" +
      (a.superagent ? '<div class="meta" style="margin-top:5px">' + superagentLine(a) + "</div>" : "")
      + "</div><div>" + (m.id ? chatLink("machine:" + m.id, "Chat Small", "btn small") : "") + "</div></div>").join("");
    const policy = m.policy;
    const config = policy === null || policy === undefined
      ? '<span class="tag unknown">remote config unknown</span>'
      : !policy.known
        ? '<span class="tag unknown">local config unknown</span>'
        : '<span class="tag">worker ' + (policy.workerEnabled === null ? "unknown" : policy.workerEnabled ? "enabled in policy" : "disabled in policy") +
          '</span> <span class="tag">big ' + (policy.bigEnabled === null ? "unknown" : policy.bigEnabled ? "enabled in policy" : "disabled in policy") +
          '</span> <span class="tag">small ' + (policy.smallEnabled === null ? "unknown" : policy.smallEnabled ? "enabled in policy" : "disabled in policy") +
          '</span> <span class="tag">concurrency ' + limit(policy.concurrency, "runs") +
          '</span> <span class="tag">cap ' + limit(policy.maxPerHour, "runs/hour") + "</span>" +
          '<div class="meta">Effective concurrency from ' + esc(textOr(policy.concurrencySource, "unknown source")) +
          '; worker.concurrency is ' + esc(textOr(policy.workerConcurrency, "unknown")) + '. ' +
          "the hourly cap is a run count, not a dollar budget. " +
          "Small may start at most " + limit(policy.maxWorkers, "worker(s)") + " here. " +
          '"enabled in policy" is configuration, not proof of a live process. Runners: ' +
          esc((policy.runners || []).join(", ") || "unknown") + "</div>";
    const tasks = (m.tasks || []).slice(0, 8).map((t) =>
      '<div class="run-row"><span class="name">' + stateTag(t.state) + " " + esc(short(t.title, 90)) +
      '</span><span class="faint mono">' + esc(short(t.id, 10)) + "</span>" +
      '<button type="button" class="btn small" data-task="' + esc(t.id) + '">Open</button></div>').join("");
    const machineTasks = (m.tasks || []).length;
    const allTasks = m.id
      ? '<button type="button" class="btn small" data-machine-filter="' + esc(m.id) + '">All tasks on this machine (' +
        String(machineTasks) + ")</button>"
      : "";
    return '<section class="machine"><div class="head"><span class="name">' + esc(textOr(m.label, id)) +
      '</span>' + (m.self ? '<span class="tag accent">this machine</span>' : "") +
      (m.contested ? '<span class="tag warn">contested id</span>' : "") +
      '<span class="tag ' + (m.live === null ? "unknown" : "live") + '">' +
      (m.live === null ? "presence unknown" : esc(m.live) + " live") + "</span>" +
      '<span class="faint">#' + esc(id) + "</span><span class='spacer' style='flex:1'></span>" +
      allTasks + (m.id ? chatLink("machine:" + m.id, "Chat Small") : "") + "</div>" +
      '<div class="body"><div class="row" style="margin-bottom:9px">' + config + "</div>" +
      (agents || empty("No agents published on this machine.")) +
      "<details><summary>Machine tasks (" + String(machineTasks) + ")</summary>" +
      (tasks || empty("No task names this machine in subscribed rooms.")) + "</details></div></section>";
  }).join("");
  return '<div class="card"><div class="head"><h2>Machines &amp; agents</h2>' +
    chatLink("big", "Chat Big", "btn primary") + "</div>" +
    '<div class="faint" style="margin-bottom:12px">Presence comes from observed cards, sessions and room activity. ' +
    "Config flags are local to this machine; a tagged superagent message is not a process heartbeat.</div></div>" + cards;
}

function taskMachine(t) { return t.machine || t.assigneeMachine || t.target || "unknown"; }
function taskById(id) {
  const tasks = (ui.data && ui.data.tasks) || [];
  return tasks.find((t) => t.id === id) || null;
}
/**
 * Open one task's detail, from anywhere on the page.
 *
 * A chip or a machine row may point at a task the current filters exclude, so
 * the filters are cleared only when they would hide it. Otherwise a person
 * presses "Open" and sees an empty list beside the detail they asked for.
 */
function showTask(id) {
  const task = taskById(id);
  if (task && !taskMatches(task)) {
    ui.search = "";
    ui.state = "";
    ui.machine = "";
    ui.runner = "";
  }
  ui.selected = id;
  ui.view = "tasks";
  render();
}
function taskMatches(t) {
  if (ui.state && t.state !== ui.state) return false;
  if (ui.machine && taskMachine(t) !== ui.machine && ui.machine !== "all") return false;
  if (ui.runner && t.runner !== ui.runner && ui.runner !== "all") return false;
  if (ui.search) {
    const hay = [t.id, t.title, t.room, t.state, t.health, t.assignee, t.target, t.runner, t.source,
      t.definition, t.requires.join(" ")].map((v) => String(v || "").toLowerCase()).join(" ");
    if (!hay.includes(ui.search.toLowerCase())) return false;
  }
  return true;
}
function sortedTasks(tasks) {
  const copy = tasks.slice();
  if (ui.sort === "title") copy.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  else if (ui.sort === "state") copy.sort((a, b) => String(a.state).localeCompare(String(b.state)) || b.updatedAt.localeCompare(a.updatedAt));
  else if (ui.sort === "machine") copy.sort((a, b) => taskMachine(a).localeCompare(taskMachine(b)) || b.updatedAt.localeCompare(a.updatedAt));
  else copy.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return copy;
}

function renderTaskDetail(t, d) {
  if (!t) return section("Task detail", empty("Select a task to read its definition, relationships, questions and result."),
    chatLink("big", "Chat Big", "btn small"));
  const messages = t.threadMessages || [];
  const decisions = t.needsYou || [];
  const copyText = [t.title, t.definition || "", "Task " + t.id, "Room " + t.room].join("\\n").slice(0, 4000);
  const relations = [
    ["Assignee", esc(textOr(t.assignee, "unknown"))], ["Machine", esc(textOr(t.machine, "unknown"))],
    ["Runner", esc(textOr(t.runner, "unknown"))], ["Target", esc(textOr(t.target, "any"))],
    ["Parent", esc(textOr(t.parent, "none"))],
    ["Children", (t.children || []).length ? list(t.children) : "none"],
    ["Depends on", (t.dependsOn || []).length ? list(t.dependsOn) : "none"],
    ["Waiting on", (t.waitingOn || []).length ? t.waitingOn.map((w) => esc(w.id) + " (" + esc(w.state) + ")").join(", ") : "none"],
    ["Requires", (t.requires || []).length ? list(t.requires) : "none"],
    ["Source", esc(textOr(t.source, "none"))], ["Requester", esc(textOr(t.requester, "unknown"))],
    ["Updated", esc(ago(t.updatedAt))]
  ];
  const errors = (t.invalidEvents || []).map((e) =>
    '<div class="list-item attention"><div class="meta">' + esc(e.reason) +
    (e.code ? " · " + esc(e.code) : "") + '</div><div class="mono faint">' + esc(e.messageId) + "</div></div>").join("");
  const question = decisions.length ? '<div class="list">' + decisions.map((i) =>
    '<div class="list-item attention"><b>' + esc(REASONS[i.reason] || i.reason) + "</b>" +
    '<div class="meta">since ' + esc(ago(i.since)) + " · message " + esc(short(i.messageId, 14)) + "</div>" +
    (i.link ? "<div>" + safeLink(i.link, "open published link") + "</div>" : "") + "</div>").join("") + "</div>"
    : empty("No unanswered question recorded for this task.");
  const result = t.currentMessage ?
    '<div class="list-item"><div class="meta">' + esc(t.currentMessage.from) + " · " + esc(t.currentMessage.kind) +
    " · " + esc(ago(t.currentMessage.ts)) + "</div>" + clipBlock(t.currentMessage.excerpt, "Latest event") +
    (t.currentMessage.link ? "<div>" + safeLink(t.currentMessage.link, "published result") + "</div>" : "") +
    '<div class="mono faint">' + esc(t.currentMessage.id) + "</div></div>" : empty("No latest event in the room window.");
  const runs = (t.runs || []).map((r) => '<div class="run-row"><span class="name">' +
    esc(short(r.title, 70)) + '</span><span class="tag">' + esc(r.outcome) + "</span><span class='faint'>" +
    esc(ago(r.startedAt)) + "</span></div>").join("");
  const thread = messages.slice(0, 12).map((m) => '<div class="list-item"><div class="meta">' +
    esc(m.from) + " · " + esc(m.kind) + (m.needs !== "none" ? " · needs " + esc(m.needs) : "") +
    " · " + esc(ago(m.ts)) + "</div>" + clipBlock(m.excerpt, "Message") +
    (m.link ? "<div>" + safeLink(m.link, "link") + "</div>" : "") + "</div>").join("");
  const target = t.machine ? "machine:" + t.machine : "big";
  return '<div class="card detail"><div class="head"><h2>Task detail</h2>' +
    '<button type="button" class="btn small" id="close-detail">Close</button></div>' +
    '<div class="row">' + stateTag(t.state) + healthTag(t.health) + badge(t.source) + "</div>" +
    "<h3>" + esc(t.title) + "</h3>" +
    '<div class="row" style="margin-bottom:8px">' + chatLink(target, t.machine ? "Ask this Small" : "Ask Big", "btn primary small") +
    chatLink("big", "Ask Big", "btn small") + copyButton(copyText) + "</div>" +
    '<dl class="kv">' + relations.map((r) => "<dt>" + esc(r[0]) + "</dt><dd>" + r[1] + "</dd>").join("") + "</dl>" +
    clipBlock(t.definition, "Definition") +
    "<h3>Questions for you</h3>" + question +
    "<h3>Latest event / result</h3>" + result +
    (errors ? "<h3>Invalid events</h3>" + errors : "") +
    (t.roomError ? '<div class="banner warning"><span class="msg">' + esc(t.roomError) + "</span></div>" : "") +
    "<h3>Local runs</h3>" + (runs || empty("No local run record for this task.")) +
    "<h3>Thread messages (" + String(messages.length) + ")</h3>" + (thread || empty("No messages in this thread.")) +
    '<div class="mono faint" style="margin-top:10px">' + esc(t.id) + " · #" + esc(t.room) + "</div></div>";
}

function renderTasks(d) {
  const tasks = sortedTasks((d.tasks || []).filter(taskMatches));
  const all = d.tasks || [];
  const machineNames = [...new Set(all.map(taskMachine))].sort();
  const runners = [...new Set(all.map((t) => t.runner).filter(Boolean))].sort();
  const options = (values, selected, allLabel) => '<option value="all">' + esc(allLabel) + "</option>" +
    values.map((v) => '<option value="' + esc(v) + '"' + (selected === v ? " selected" : "") + ">" + esc(v) + "</option>").join("");
  // A machine picked from the Machines view may have left the room window, so
  // its own name is offered even when no current task names it.
  const machineOptions = ui.machine && ui.machine !== "all" && !machineNames.includes(ui.machine)
    ? [...machineNames, ui.machine].sort()
    : machineNames;
  const controls = '<div class="controls">' +
    '<label class="sr-only" for="task-search">Search tasks</label>' +
    '<input id="task-search" type="search" placeholder="Search title, id, room, runner, definition…" value="' + esc(ui.search) + '">' +
    '<label class="sr-only" for="task-state">State</label><select id="task-state">' + options(STATES, ui.state, "all states") + "</select>" +
    '<label class="sr-only" for="task-machine">Machine</label><select id="task-machine">' + options(machineOptions, ui.machine, "all machines") + "</select>" +
    '<label class="sr-only" for="task-runner">Runner</label><select id="task-runner">' + options(runners, ui.runner, "all runners") + "</select>" +
    '<label class="sr-only" for="task-sort">Sort</label><select id="task-sort">' +
    [["updated", "latest"], ["state", "state"], ["machine", "machine"], ["title", "title"]].map((v) =>
      '<option value="' + v[0] + '"' + (ui.sort === v[0] ? " selected" : "") + ">Sort: " + v[1] + "</option>").join("") +
    '</select><button type="button" class="btn" id="task-reset">Reset</button></div>';
  const rows = tasks.map((t) => '<tr data-task="' + esc(t.id) + '" data-selected="' +
    String(ui.selected === t.id) + '"><td class="title-cell">' + badge(t.source) +
    '<button type="button" class="title-btn" data-task="' + esc(t.id) + '">' + esc(t.title) +
    '</button><div class="meta mono">' + esc(short(t.id, 14)) + " · #" + esc(t.room) + "</div></td>" +
    '<td><span class="sr-only">State: </span>' + stateTag(t.state) + " " + healthTag(t.health) + "</td>" +
    '<td class="meta"><span class="sr-only">Machine: </span>' + esc(taskMachine(t)) +
    '<div class="meta"><span class="sr-only">Runner: </span>' + esc(textOr(t.runner, "runner unknown")) + "</div></td>" +
    '<td class="meta">' + esc(ago(t.updatedAt)) + '<div class="meta">' + esc(textOr(t.assignee, "unassigned")) + "</div></td>" +
    '<td class="meta">' + (t.needsYou && t.needsYou.length ? '<span class="tag bad">needs you</span>' : "") +
    (t.invalidEvents && t.invalidEvents.length ? '<span class="tag warn">error</span>' : "") +
    "</td></tr>").join("");
  const table = tasks.length === 0 ? empty("No tasks match these filters. Reset to see all subscribed-room tasks.") :
    '<div class="table-scroll"><table class="task-table"><caption class="sr-only">Tasks in subscribed rooms. ' +
    'Select a title to read its detail.</caption><thead><tr><th scope="col">Task</th><th scope="col">State</th>' +
    '<th scope="col">Machine / runner</th><th scope="col">Updated / assignee</th>' +
    '<th scope="col">Attention</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  const selected = (d.tasks || []).find((t) => t.id === ui.selected) || null;
  const active = ui.state ? ' <span class="tag accent">state: ' + esc(ui.state.replace("_", " ")) + "</span>" : "";
  return '<div class="section-head"><h2>Tasks (' + String(tasks.length) + " of " + String(all.length) + ")</h2>" +
    '<div class="row">' + active + chatLink("big", "Ask Big about a task", "btn small") + "</div></div>" +
    statusBanner(d) + controls +
    '<div class="grid-2"><div>' + table + "</div><div>" + renderTaskDetail(selected, d) + "</div></div>";
}

function renderRuns(d) {
  const o = d.overview || {};
  const l = o.local || {};
  const runs = d.runs || [];
  const rows = runs.map((r) => '<tr><td>' + esc(short(r.title, 90)) +
    '<div class="meta mono">' + esc(short(r.taskId, 14)) + " · #" + esc(r.room) + "</div></td>" +
    '<td><span class="tag ' + (r.outcome === "completed" ? "live" : r.outcome === "running" ? "accent" : "warn") + '">' +
    esc(r.outcome) + "</span></td><td>" + esc(textOr(r.runner, "unknown")) + "</td><td>" +
    esc(runModel(r)) + "</td><td>" +
    esc(ago(r.startedAt)) + "</td><td>" +
    esc(r.exitCode === undefined || r.exitCode === null ? "unknown" : r.exitCode) + "</td><td>" +
    (r.note ? clipBlock(r.note, "Note") : "") + "</td></tr>").join("");
  const costNote = l.costAvailable
    ? (l.costComplete === true
        ? "Every run today is inside this figure; each session counts once."
        : "A known subtotal, not a total: priced runs only. " +
          (l.todayUnpricedRuns === null ? "The unpriced count is unknown."
            : String(l.todayUnpricedRuns) + " run(s) today are unpriced (no price printed, or still running).") +
          " A run with no price is not counted as $0.")
    : "Cost unknown: no local run log reported a price. The dashboard does not show $0 in this case.";
  const cards = [
    metric("Runs in window", num(l.runs), "local records, this machine"),
    metric("Running", num(l.running), "local process records"),
    metric("Completed", num(l.completed), "local outcomes"),
    metric("Failed / blocked", num(l.failed), "local outcomes", l.failed > 0 ? "alert" : ""),
    metric("Today's runs", num(l.todayRuns), "local calendar day"),
    metric("Today's cost", esc(cost(l.todayCostUsd)),
      l.costAvailable
        ? (l.costComplete === true
            ? "USD · complete total · local run logs"
            : "USD · known subtotal · " +
              (l.todayUnpricedRuns === null ? "unpriced runs unknown" : String(l.todayUnpricedRuns) + " run(s) unpriced"))
        : "unknown, not zero")
  ].join("");
  return '<div class="section-head"><h2>Runs &amp; cost</h2><span class="pill">this machine only</span></div>' +
    '<div class="metrics">' + cards + "</div>" +
    '<div class="grid-2"><div>' + section("Local run records (" + String(runs.length) + ")",
      runs.length ? '<table class="data"><caption class="sr-only">Each run, with model evidence labelled by source. CLI init, usage labels and legacy records do not establish backend identity.</caption>' +
        '<tr><th>Task</th><th>Outcome</th><th>Runner</th><th>Model</th><th>Started</th><th>Exit</th><th>Note</th></tr>' +
        rows + "</table>" : empty("No local run records.")) + "</div><div>" +
    section("Limits & scope", '<dl class="kv">' +
      "<dt>Scope</dt><dd>Worker runs only on this machine; excludes Big/Small superagent brain sessions. No remote telemetry is inferred.</dd>" +
      "<dt>Effective concurrency</dt><dd>" + limit(l.maxConcurrent, "run(s) at once") +
        ", from " + esc(textOr(l.concurrencySource, "unknown source")) + "</dd>" +
      "<dt>Raw worker concurrency</dt><dd>" + limit(l.workerConcurrency, "run(s)") +
        ", from worker.concurrency</dd>" +
      "<dt>Hourly cap</dt><dd>" + limit(l.maxPerHour, "runs/hour") +
        ", from worker.maxPerHour (a run count, not a dollar budget)</dd>" +
      "<dt>Small starts</dt><dd>" + limit(l.smallMaxWorkers, "worker(s)") +
        ", from superagent.small.maxWorkers</dd>" +
      "<dt>Runners</dt><dd>" + esc((l.runners || []).join(", ") || "unknown") + "</dd>" +
      "<dt>Cost source</dt><dd>" + esc(textOr(l.costSource, "not available")) + "</dd></dl>" +
      '<div class="faint">' + esc(costNote) + "</div>") +
    section("Network work counts", '<div class="faint">The overview counts tasks in subscribed rooms, as read from the transport. ' +
      'They are not a sum of every machine local runs.</div><dl class="kv">' +
      "<dt>Running</dt><dd>" + num((o.counts || {}).running) + "</dd>" +
      "<dt>Queued</dt><dd>" + num((o.counts || {}).queued) + "</dd>" +
      "<dt>Blocked</dt><dd>" + num((o.counts || {}).blocked) + "</dd>" +
      "<dt>Completed</dt><dd>" + num((o.counts || {}).completed) + "</dd></dl>") + "</div></div>";
}

function renderView(d) {
  // Older callers answer only the original keys; derive a readable view from
  // those rather than showing blanks. The richer fold is preferred when present.
  const modern = d.overview !== undefined && d.overview !== null;
  const machines = modern ? d.machineViews : null;
  if (ui.view === "machines") return machines !== null && machines !== undefined ? renderMachines({ ...d, machines }) : legacyMachines(d);
  if (ui.view === "tasks") return modern ? renderTasks(d) : legacyTasks(d);
  if (ui.view === "runs") return modern ? renderRuns(d) : legacyRuns(d);
  return modern ? modernOverview(d) : legacyOverview(d);
}

function render() {
  const d = ui.data;
  renderHeader(d || {});
  if (d !== null) announce(d);
  const target = realSections();
  for (const view of VIEWS) {
    const sectionEl = el("view-" + view);
    if (sectionEl && sectionEl.setAttribute) {
      sectionEl.hidden = view !== ui.view;
      sectionEl.setAttribute("aria-current", view === ui.view ? "page" : "false");
    }
    const button = el("nav-" + view);
    if (button && button.setAttribute) button.setAttribute("aria-current", view === ui.view ? "page" : "false");
  }
  if (!target) return;
  if (d === null) {
    target.innerHTML = '<div class="offline">' + (ui.failed ?
      "<b>Could not load the dashboard.</b><br>" + esc(ui.lastError) + "<br>Retrying automatically." :
      '<span class="spin"></span> Loading the execution centre…') + "</div>";
    return;
  }
  const scroll = typeof window === "undefined" ? null : window;
  const before = scroll && typeof scroll.scrollY === "number" ? scroll.scrollY : 0;
  target.innerHTML = renderView(d);
  if (scroll && scroll.scrollTo) scroll.scrollTo(0, before);
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  ui.view = view;
  render();
  if (typeof location !== "undefined" && location.hash !== undefined && history.replaceState) {
    history.replaceState(null, "", location.pathname + "#" + view);
  }
}

function onControl(event) {
  const target = event.target;
  if (!target || !target.id) return;
  const id = target.id;
  const focusSearch = id === "task-search";
  if (focusSearch) ui.search = String(target.value || "").slice(0, 200);
  else if (id === "task-state") ui.state = target.value === "all" ? "" : target.value;
  else if (id === "task-machine") ui.machine = target.value;
  else if (id === "task-runner") ui.runner = target.value;
  else if (id === "task-sort") ui.sort = target.value;
  else return;
  render();
  // Re-rendering replaces the control; keep the caret in the search field.
  const search = focusSearch ? el("task-search") : null;
  if (search && search.focus) {
    search.focus();
    if (search.setSelectionRange) search.setSelectionRange(ui.search.length, ui.search.length);
  }
}

function onClick(event) {
  const target = event.target && event.target.closest ? event.target.closest("[data-view],[data-task],[data-copy],#task-reset,#close-detail,[data-nav],[data-state-filter],[data-machine-filter]") : null;
  if (!target) return;
  if (target.id === "task-reset") {
    ui.search = ""; ui.machine = ""; ui.runner = ""; ui.state = ""; ui.sort = "updated"; ui.selected = null;
    render(); return;
  }
  if (target.id === "close-detail") { ui.selected = null; render(); return; }
  if (target.hasAttribute("data-copy")) {
    const value = target.getAttribute("data-copy");
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).catch(() => undefined);
    }
    target.textContent = "Copied";
    if (typeof setTimeout === "function") setTimeout(() => { target.textContent = "Copy"; }, 1200);
    return;
  }
  if (target.hasAttribute("data-nav")) { setView(target.getAttribute("data-nav")); return; }
  if (target.hasAttribute("data-view")) { setView(target.getAttribute("data-view")); return; }
  if (target.hasAttribute("data-state-filter")) {
    const state = target.getAttribute("data-state-filter");
    // Pressing the active chip again clears the filter.
    ui.state = ui.state === state ? "" : state;
    ui.view = "tasks";
    render(); return;
  }
  if (target.hasAttribute("data-machine-filter")) {
    const machine = target.getAttribute("data-machine-filter");
    // A machine row is how a person reaches its tasks as one list.
    ui.machine = machine;
    ui.state = "";
    ui.search = "";
    ui.runner = "";
    ui.view = "tasks";
    render(); return;
  }
  if (target.hasAttribute("data-task")) { showTask(target.getAttribute("data-task")); }
}

async function refresh() {
  if (ui.busy) return;
  ui.busy = true;
  ui.loading = true;
  const headers = {};
  const t = token();
  if (t) headers["authorization"] = "Bearer " + t;
  try {
    const res = await fetch("/api/dashboard", { headers, cache: "no-store" });
    if (res.status === 401) throw new Error("unauthorised: open the URL with #token=… that oguri web printed");
    if (!res.ok) throw new Error("HTTP " + String(res.status));
    const d = await res.json();
    ui.data = d;
    ui.failed = false;
    ui.lastError = "";
  } catch (e) {
    ui.failed = true;
    ui.lastError = String(e && e.message ? e.message : e);
  } finally {
    ui.loading = false;
    ui.busy = false;
    render();
  }
}

applyTheme();
const initial = /^#(overview|machines|tasks|runs)$/.exec(location.hash);
if (initial) ui.view = initial[1];
if (document.addEventListener) {
  document.addEventListener("click", onClick);
  document.addEventListener("input", onControl);
  document.addEventListener("change", onControl);
}
const themeButton = el("theme");
if (themeButton && themeButton.addEventListener) themeButton.addEventListener("click", cycleTheme);
for (const view of VIEWS) {
  const button = el("nav-" + view);
  if (button && button.addEventListener) button.addEventListener("click", () => setView(view));
}
render();
refresh();
setInterval(refresh, POLL_MS);
`;
}

export function buildHeaderHtml(nonce: string): string {
  return `<style nonce="${nonce}">${STYLE}</style>`;
}

/** Render the page. `nonce` must match the CSP header the server sends with it. */
export function renderPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>oguri · execution centre</title>
${buildHeaderHtml(nonce)}
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><span class="mark">o</span><span><b>oguri</b><small>execution centre</small></span></div>
    <nav class="nav" aria-label="Dashboard sections">
      <button type="button" id="nav-overview" data-nav="overview">Overview</button>
      <button type="button" id="nav-machines" data-nav="machines">Machines</button>
      <button type="button" id="nav-tasks" data-nav="tasks">Tasks</button>
      <button type="button" id="nav-runs" data-nav="runs">Runs &amp; cost</button>
      <button type="button" id="nav-needs" data-view="overview">Needs you <span class="count" id="nav-needs-count">0</span></button>
    </nav>
    <div class="side-foot">
      <div class="row"><span>read-only</span><span id="mode">—</span></div>
      <div class="row"><span>network</span><span id="network">—</span></div>
      <div class="row"><span>updated</span><span id="updated">loading…</span></div>
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <h1>Execution centre</h1>
      <span class="sub" id="who">connecting…</span>
      <span class="spacer"></span>
      <span class="pill" id="conn"><span class="dot"></span><span>loading…</span></span>
      <a href="${chatUrl("big")}" class="btn primary">Chat Big</a>
      <button type="button" class="icon-btn" id="theme" aria-label="Change color theme">◐</button>
      <!-- Polls never move focus; this region is how a screen reader hears that data changed. -->
      <p class="sr-only" id="status" role="status" aria-live="polite"></p>
    </header>
    <main class="content" id="app">
      <section class="view" id="view-overview" data-is-view="true" aria-label="Overview"></section>
      <section class="view" id="view-machines" data-is-view="true" aria-label="Machines" hidden></section>
      <section class="view" id="view-tasks" data-is-view="true" aria-label="Tasks" hidden></section>
      <section class="view" id="view-runs" data-is-view="true" aria-label="Runs and cost" hidden></section>
    </main>
  </div>
</div>
<script nonce="${nonce}">${script()}</script>
</body>
</html>
`;
}
