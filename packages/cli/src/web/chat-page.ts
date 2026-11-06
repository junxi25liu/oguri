/**
 * `/chat` — a separate, self-contained page for talking to the superagents.
 *
 * The dashboard stays read-only and untouched. This page has its own nonce,
 * its own CSP, and its own inline script. Everything that came from another
 * machine is data: it is escaped before it can become markup. A small Markdown
 * renderer allows fenced code, inline code, **bold**, *italic*, and http(s)
 * links only; every other byte is text. No CDN, no framework, no streaming.
 */

/** Escape text for HTML element content and quoted attribute values. */
export function escapeChatHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/** How often an open chat tab looks for a late reply. It never sends by itself. */
export const CHAT_POLL_MS = 5_000;

const STYLE = `
:root{color-scheme:light dark;--bg:#f5f7fa;--fg:#1f2430;--muted:#697386;--card:#fff;
--line:#dfe3ea;--accent:#2563eb;--them:#e8eefc;--you:#dbeafe;--bad:#b91c1c;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#11141a;--fg:#e7eaf0;--muted:#939cad;--card:#1b2029;
--line:#2d3440;--them:#243149;--you:#1f3557;--bad:#f87171;--warn:#fbbf24}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}button,select,textarea,input{font:inherit}
.wrap{max-width:900px;height:100dvh;margin:auto;display:flex;flex-direction:column;padding:0 14px}
header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 0 10px;border-bottom:1px solid var(--line)}
h1{font-size:17px;margin:0 8px 0 0}a.brand{color:inherit;text-decoration:none}
select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:6px 9px;max-width:45vw}
.state{font-size:12px;color:var(--muted);margin-left:auto;text-align:right}
.banner{padding:8px 10px;border-radius:7px;color:var(--bad);background:#fde8e8;font-size:13px}
main{flex:1;min-height:0;overflow-y:auto;padding:16px 2px;scroll-behavior:smooth}
.empty{color:var(--muted);text-align:center;margin:15vh 0;line-height:1.8}
.row{display:flex;gap:8px;margin:0 0 14px;align-items:flex-start}.row.you{flex-direction:row-reverse}
.avatar{flex:0 0 auto;width:30px;height:30px;border-radius:50%;background:var(--line);color:var(--muted);
display:flex;align-items:center;justify-content:center;font-size:12px}
.bubble{max-width:min(82%,680px);padding:9px 12px;border-radius:12px;background:var(--card);
border:1px solid var(--line)}.row.you .bubble{background:var(--you)}.row.them .bubble{background:var(--them)}
.meta{font-size:11px;color:var(--muted);margin-bottom:3px}.body{white-space:pre-wrap;overflow-wrap:anywhere}
.body p{margin:0 0 8px}.body p:last-child{margin:0}.body pre{margin:8px 0;padding:10px;overflow-x:auto;
border-radius:7px;background:#10151f;color:#e8edf7;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace}
.body code{font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;background:rgba(127,127,127,.16);
padding:1px 4px;border-radius:4px}.body pre code{background:none;padding:0}.body a{color:var(--accent)}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--muted);margin-right:5px}
.dot.live{background:#1f9d55}.dot.away{background:#c2410c}.dot.stale{background:#c9a227}
footer{border-top:1px solid var(--line);padding:10px 0 14px}.composer{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;min-height:46px;max-height:35vh;resize:vertical;padding:9px 11px;border-radius:9px;
border:1px solid var(--line);background:var(--card);color:var(--fg);outline:2px solid transparent}
textarea:focus{outline-color:var(--accent)}button{border:0;border-radius:9px;padding:9px 16px;background:var(--accent);
color:#fff;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.hint{font-size:11px;color:var(--muted);
margin-top:5px}.warn{color:var(--warn)}
@media (max-width:600px){.wrap{padding:0 10px}.bubble{max-width:88%}.state{width:100%;margin-left:0;text-align:left}}
`;

function script(): string {
  return `
"use strict";
${escapeChatHtml.toString()}
const esc = escapeChatHtml;
const POLL_MS = ${String(CHAT_POLL_MS)};

function token() {
  const m = /(?:^|[#&])token=([^&]+)/.exec(location.hash);
  if (m) {
    sessionStorage.setItem("oguri-token", decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }
  return sessionStorage.getItem("oguri-token");
}

function headers(json) {
  const h = { "x-oguri-chat": "1" };
  const t = token();
  if (t) h.authorization = "Bearer " + t;
  if (json) h["content-type"] = "application/json";
  return h;
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" :
    s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
}

// Every interpolation is escaped. Only http(s) URLs become links.
function inline(text) {
  const TICK = String.fromCharCode(96);
  const QUOTE = String.fromCharCode(34);
  const NL = String.fromCharCode(10);
  const B = String.fromCharCode(92);
  const STAR = B + "*";
  const DSTAR = STAR + STAR;
  // Build the pattern at runtime: a backslash inside this template literal
  // would be consumed by the outer parser before RegExp ever sees it.
  const pattern = new RegExp(
    "(" +
      TICK +
      "[^" +
      TICK +
      NL +
      "]+" +
      TICK +
      "|" +
      DSTAR +
      "[^*" +
      NL +
      "]+" +
      DSTAR +
      "|" +
      STAR +
      "[^*" +
      NL +
      "]+" +
      STAR +
      "|https?:[/][/][^" +
      B +
      "s<>" +
      QUOTE +
      TICK +
      "]+)",
    "g",
  );
  const out = [];
  let last = 0, m;
  while ((m = pattern.exec(text)) !== null) {
    out.push(esc(text.slice(last, m.index)));
    const v = m[0];
    if (v[0] === TICK) out.push("<code>" + esc(v.slice(1, -1)) + "</code>");
    else if (v.slice(0, 2) === "**") out.push("<b>" + esc(v.slice(2, -2)) + "</b>");
    else if (v[0] === "*") out.push("<i>" + esc(v.slice(1, -1)) + "</i>");
    else out.push('<a href="' + esc(v) + '" target="_blank" rel="noopener noreferrer">' + esc(v) + "</a>");
    last = m.index + v.length;
  }
  out.push(esc(text.slice(last)));
  return out.join("");
}

function markdown(text) {
  const TICK = String.fromCharCode(96);
  const B = String.fromCharCode(92);
  const NL = String.fromCharCode(10);
  const fence = new RegExp(TICK + "{3}[^" + NL + "]*" + NL + "?", "g");
  const tail = new RegExp(NL + "?" + TICK + "{3}[" + B + "s" + B + "S]*$");
  const parts = String(text || "").split(fence);
  return parts.map((part, i) => i % 2 === 1
    ? "<pre><code>" + esc(part.replace(tail, "")) + "</code></pre>"
    : part.split(new RegExp(NL + "{2,}")).filter((p) => p.length > 0)
        .map((p) => "<p>" + inline(p).split(NL).join("<br>") + "</p>").join("")).join("");
}

function messageView(m) {
  const mine = m.role === "you";
  return '<div class="row ' + (mine ? "you" : "them") + '" data-id="' + esc(m.id) + '">' +
    '<div class="avatar">' + esc((m.from || "?").slice(0, 2).toUpperCase()) + '</div>' +
    '<div class="bubble"><div class="meta">' + esc(m.from) + " · " + esc(ago(m.ts)) +
    (m.state === "failed" ? ' · <span class="warn">failed</span>' : "") +
    (m.state === "waiting" ? " · waiting" : "") + '</div><div class="body">' +
    markdown(m.body) + "</div></div></div>";
}

const state = { target: "big", thread: null, seen: {}, waiting: false, timedOut: false,
  sending: false, errors: [], presence: "unknown", targets: [] };

function qs() { return new URLSearchParams(location.search); }
function target() { return qs().get("target") || "big"; }

function link(value) {
  const u = new URL(location.href);
  u.searchParams.set("target", value);
  u.searchParams.delete("thread");
  return u.pathname + u.search;
}

function setTargetOptions(targets) {
  state.targets = targets || [];
  const select = document.getElementById("target");
  const selected = state.target;
  select.innerHTML = state.targets.map((t) =>
    '<option value="' + esc(t.value) + '"' + (t.value === selected ? " selected" : "") + ">" +
    esc(t.label) + "</option>").join("");
  if (!state.targets.some((t) => t.value === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = selected;
    select.appendChild(opt);
    select.value = selected;
  }
}

function render() {
  const app = document.getElementById("app");
  const banner = state.errors.length ? '<div class="banner">' + state.errors.map(esc).join("<br>") + "</div>" : "";
  const rows = Object.keys(state.seen).sort().map((k) => messageView(state.seen[k]));
  app.innerHTML = banner + (rows.length ? rows.join("") :
    '<div class="empty">No messages with this target yet.<br>Write one below to start a conversation.</div>');
  app.scrollTop = app.scrollHeight;
  const dot = document.getElementById("presence");
  dot.className = "dot " + (["live", "away", "stale"].indexOf(state.presence) >= 0 ? state.presence : "");
  const label = state.presence === "unknown" ? "presence unknown" : state.presence;
  document.getElementById("state").textContent = state.waiting ? "waiting for a reply · " + label :
    state.timedOut ? "no reply yet · is superagent start running? · " + label : label;
  document.getElementById("send").disabled = state.sending;
}

function accept(data, atBottom) {
  if (!data || typeof data !== "object") return;
  state.errors = Array.isArray(data.errors) ? data.errors.map(String) : [];
  state.presence = data.presence || "unknown";
  state.waiting = !!data.waiting;
  state.timedOut = !!data.timedOut;
  if (data.thread) state.thread = data.thread;
  const messages = Array.isArray(data.messages) ? data.messages : [];
  for (const m of messages) if (m && typeof m.id === "string") state.seen[m.id] = m;
  const app = document.getElementById("app");
  atBottom = atBottom === undefined ? app.scrollHeight - app.scrollTop - app.clientHeight < 80 : atBottom;
  render();
  if (atBottom) app.scrollTop = app.scrollHeight;
}

async function request(path, init) {
  const res = await fetch(path, init);
  if (res.status === 401) throw new Error("open the URL with #token=… printed by oguri web");
  if (res.status === 421) throw new Error("this page answers only on loopback Host names");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

async function loadTargets() {
  try {
    const d = await request("/chat/api/targets", { headers: headers(false), cache: "no-store" });
    setTargetOptions(d.targets);
  } catch (e) { state.errors.push(String(e.message || e)); render(); }
}

async function refresh() {
  const q = new URLSearchParams({ target: state.target });
  if (state.thread) q.set("thread", state.thread);
  try {
    const d = await request("/chat/api/history?" + q.toString(), { headers: headers(false), cache: "no-store" });
    accept(d);
  } catch (e) { state.errors.push(String(e.message || e)); render(); }
}

function bodyForSend(body) {
  const value = { target: state.target, body: body };
  if (state.thread) value.thread = state.thread;
  return value;
}

async function send() {
  const box = document.getElementById("box");
  const body = box.value.trim();
  if (!body || state.sending) return;
  state.sending = true;
  render();
  const q = new URLSearchParams({ target: state.target });
  if (state.thread) q.set("thread", state.thread);
  try {
    const d = await request("/chat/api/send?" + q.toString(), {
      method: "POST", headers: headers(true),
      body: JSON.stringify(bodyForSend(body))
    });
    box.value = "";
    state.errors = [];
    accept(d, true);
  } catch (e) {
    state.errors.push("not sent: " + String(e.message || e) + " (the text is still in the box)");
    render();
  } finally {
    state.sending = false;
    render();
    box.focus();
  }
}

document.getElementById("send").addEventListener("click", send);
document.getElementById("target").addEventListener("change", (e) => {
  const value = e.target.value;
  if (!value || value === state.target) return;
  location.assign(link(value));
});
document.getElementById("box").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
document.getElementById("retry").addEventListener("click", () => { state.errors = []; refresh(); });

function start() {
  state.target = target();
  const t = qs().get("thread");
  if (t && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(t)) state.thread = t;
  loadTargets().then(refresh);
  setInterval(refresh, POLL_MS);
  document.getElementById("box").focus();
}
start();
`;
}

/** Render `/chat`. The nonce must match the CSP header the server sends with it. */
export function renderChatPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>oguri chat</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div class="wrap">
<header><a class="brand" href="/"><h1>oguri chat</h1></a>
<select id="target" aria-label="Conversation target"></select>
<span class="state"><span id="presence" class="dot"></span><span id="state">loading…</span></span>
<button id="retry" type="button" title="Re-read this conversation">↻</button></header>
<main id="app" aria-live="polite"></main>
<footer><div class="composer"><textarea id="box" rows="2" aria-label="Message"
placeholder="Write a message…"></textarea><button id="send" type="button">Send</button></div>
<div class="hint">Enter sends · Shift+Enter adds a line · replies can arrive late; this page only re-reads</div></footer>
</div>
<script nonce="${nonce}">${script()}</script>
</body>
</html>
`;
}
