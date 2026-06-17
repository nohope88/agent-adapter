'use strict';
// Live dashboard for the Agent Adapter — dual source.
//   Local  → SSE /local/stream  (the hub on this machine; full react-back)
//   Cloud  → SSE /cloud/stream  (Commander API, polled; prompt-only; needs login)
// Cards render identically from the same AgentStatus shape, so you can flip the
// Local | Cloud toggle to see exactly where the integration diverges.

const PRIORITY = { waiting: 0, error: 1, busy: 2, working: 2, idle: 3, ended: 4 };
const KIND_BADGE = {
  'claude-code': 'CC', codex: 'CX', cursor: 'CU', gemini: 'GM', openclaw: 'OC', hermes: 'HM',
};
function kindBadge(kind) {
  return KIND_BADGE[kind] || (kind || '?').replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase() || '?';
}

// ACAP level + accepted intents per provider — fixed per kind (mirrors the
// adapter descriptors in src/adapters/<kind>/index.ts). The status payload
// doesn't carry these, so the UI keys interaction off this table; if a future
// payload includes `level`/`capabilities`, capsFor() prefers it automatically.
const KIND_CAPS = {
  'claude-code': { level: 'L3', capabilities: ['prompt', 'answer', 'interrupt'] },
  codex:         { level: 'L2', capabilities: ['prompt', 'answer', 'interrupt'] },
  cursor:        { level: 'L2', capabilities: ['prompt', 'answer'] },
  gemini:        { level: 'L0', capabilities: [] },
  openclaw:      { level: 'L0', capabilities: [] },
  hermes:        { level: 'L0', capabilities: [] },
};
function capsFor(s) {
  if (s && Array.isArray(s.capabilities)) return { level: s.level || '', capabilities: s.capabilities };
  return KIND_CAPS[s && s.kind] || { level: (s && s.level) || 'L0', capabilities: [] };
}
// Whether the dashboard may push `intent` to this session right now.
function can(s, intent) {
  if (s.status === 'ended') return false;                       // nothing to act on
  if (!capsFor(s).capabilities.includes(intent)) return false;  // capability gate (e.g. cursor has no interrupt)
  if (mode === 'cloud' && intent === 'interrupt') return false; // Commander bridge is prompt/answer only
  return true;
}

const sessions = new Map();   // agentId → AgentStatus
const cardEls = new Map();    // agentId → <article>

const board = document.getElementById('board');
const connEl = document.getElementById('conn');
const countsEl = document.getElementById('counts');
const emptyEl = document.getElementById('empty');
const toastEl = document.getElementById('toast');
const sourceEl = document.getElementById('source');
const whoamiEl = document.getElementById('whoami');
const logoutBtn = document.getElementById('logout');
const loginErr = document.getElementById('login-err');
const loginForm = document.getElementById('login-form');
const tokenForm = document.getElementById('token-form');
const statusChipsEl = document.getElementById('status-chips');
const providerSelEl = document.getElementById('provider-filter');
const DEFAULT_EMPTY = emptyEl.innerHTML;

// ── Filters (status + provider), persisted ────────────────────────
const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'busy', label: 'Busy' },
  { key: 'idle', label: 'Idle' },
  { key: 'error', label: 'Error' },
  { key: 'ended', label: 'Ended' },
];
let statusFilter = localStorage.getItem('aca-web-status') || 'all';
let providerFilter = localStorage.getItem('aca-web-provider') || 'all';

// ── Mode (local | cloud) ──────────────────────────────────────────
let mode = localStorage.getItem('aca-web-mode') === 'cloud' ? 'cloud' : 'local';
let config = { hub: '', commander: '' };

function applyModeChrome() {
  document.body.dataset.mode = mode;
  for (const b of document.querySelectorAll('.mode-btn')) {
    b.classList.toggle('mode-btn--on', b.dataset.mode === mode);
  }
  sourceEl.textContent = mode === 'cloud' ? `cloud · ${short(config.commander)}` : `local · ${config.hub}`;
}

async function switchMode(next) {
  if (next === mode) return;
  mode = next;
  localStorage.setItem('aca-web-mode', mode);
  applyModeChrome();
  disconnect();
  sessions.clear();
  render();
  await enterMode();
}

// Decide what to show for the current mode: local connects straight away;
// cloud first checks auth and shows the login gate if needed.
async function enterMode() {
  if (mode === 'local') { document.body.dataset.view = 'board'; connect(); return; }
  try {
    const a = await (await fetch('/cloud/auth')).json();
    if (a.authed) { whoamiEl.textContent = a.email || ''; document.body.dataset.view = 'board'; connect(); }
    else document.body.dataset.view = 'login';
  } catch { document.body.dataset.view = 'login'; }
}

// ── SSE connection ────────────────────────────────────────────────
let es = null;
function connect() {
  disconnect();
  es = new EventSource(`/${mode}/stream`);
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));
  es.addEventListener('unauth', () => {            // cloud only
    disconnect();
    document.body.dataset.view = 'login';
    toast('Please sign in to Commander', 'warn');
  });
  es.addEventListener('roster', (e) => {
    sessions.clear();
    for (const s of safeParse(e.data, [])) sessions.set(s.agentId, s);
    render();
  });
  es.addEventListener('status', (e) => {           // local hub pushes deltas
    const s = safeParse(e.data, null);
    if (s && s.agentId) { sessions.set(s.agentId, s); render(); }
  });
}
function disconnect() { if (es) { es.close(); es = null; } setConn(false); }

function setConn(ok) {
  connEl.textContent = ok ? 'live' : 'reconnecting…';
  connEl.className = 'conn ' + (ok ? 'conn--on' : 'conn--off');
}

// ── Render ────────────────────────────────────────────────────────
function render() {
  const all = [...sessions.values()];
  const counts = { all: all.length, waiting: 0, busy: 0, idle: 0, error: 0, ended: 0 };
  for (const s of all) counts[s.status] = (counts[s.status] || 0) + 1;

  const list = all
    .filter((s) => (statusFilter === 'all' || s.status === statusFilter)
                && (providerFilter === 'all' || s.kind === providerFilter))
    .sort((a, b) => (PRIORITY[a.status] - PRIORITY[b.status]) || ((b.updatedAt || 0) - (a.updatedAt || 0)));

  const visible = new Set(list.map((s) => s.agentId));
  for (const [id, el] of cardEls) {
    if (!visible.has(id)) { el.remove(); cardEls.delete(id); }
  }

  // Reordering moves DOM nodes, which blurs a focused input inside a card.
  // The Cloud roster polls every couple seconds, so remember the caret and only
  // relocate cards that are actually out of place — otherwise typing is impossible.
  const active = document.activeElement;
  const focused = active && active.classList && active.classList.contains('prompt-input')
    ? { el: active, start: active.selectionStart, end: active.selectionEnd }
    : null;

  let prev = null;
  for (const s of list) {
    let el = cardEls.get(s.agentId);
    if (!el) { el = buildCard(s.agentId); cardEls.set(s.agentId, el); }
    updateCard(el, s);
    const inPlace = prev ? el.previousElementSibling === prev : board.firstElementChild === el;
    if (!inPlace) { if (prev) prev.after(el); else board.prepend(el); }
    prev = el;
  }

  if (focused && document.activeElement !== focused.el && document.contains(focused.el)) {
    focused.el.focus();
    try { focused.el.setSelectionRange(focused.start, focused.end); } catch (_) { /* noop */ }
  }

  updateStatusChips(counts);
  refreshProviderOptions(all);

  const filtering = statusFilter !== 'all' || providerFilter !== 'all';
  countsEl.textContent = !all.length ? ''
    : filtering ? `${list.length} of ${all.length} shown`
    : `${all.length} session${all.length === 1 ? '' : 's'}`;
  emptyEl.innerHTML = (all.length && !list.length)
    ? 'No sessions match this filter.<br />Clear the status/provider filter to see all sessions.'
    : DEFAULT_EMPTY;
  emptyEl.style.display = list.length ? 'none' : 'block';
}

// ── Filter UI ─────────────────────────────────────────────────────
function buildStatusChips() {
  statusChipsEl.innerHTML = '';
  for (const f of STATUS_FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.status = f.key;
    b.innerHTML = `<span class="chip-label">${f.label}</span><span class="chip-n"></span>`;
    b.addEventListener('click', () => {
      statusFilter = f.key;
      localStorage.setItem('aca-web-status', statusFilter);
      render();
    });
    statusChipsEl.appendChild(b);
  }
}
function updateStatusChips(counts) {
  for (const b of statusChipsEl.querySelectorAll('.chip')) {
    const k = b.dataset.status;
    const n = counts[k] != null ? counts[k] : 0;
    b.querySelector('.chip-n').textContent = n;
    b.classList.toggle('chip--on', k === statusFilter);
    b.classList.toggle('chip--empty', k !== 'all' && n === 0);
  }
}
let providerSig = '';
function refreshProviderOptions(all) {
  const kinds = [...new Set(all.map((s) => s.kind).filter(Boolean))].sort();
  const sig = kinds.join(',');
  if (sig === providerSig) return;          // options unchanged → don't rebuild (keeps the dropdown open-able)
  providerSig = sig;
  if (providerFilter !== 'all' && !kinds.includes(providerFilter)) {
    providerFilter = 'all';                 // the filtered provider went away
    localStorage.setItem('aca-web-provider', 'all');
  }
  providerSelEl.innerHTML = '<option value="all">All providers</option>'
    + kinds.map((k) => `<option value="${k}">${k}</option>`).join('');
  providerSelEl.value = providerFilter;
}

function buildCard(agentId) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="c-head">
      <span class="head-left"><span class="kind"></span><span class="level" title="ACAP conformance level"></span></span>
      <span class="ts"></span>
    </div>
    <div class="c-body">
      <div class="title"></div>
      <div class="subtitle"></div>
    </div>
    <div class="c-meter">
      <div class="c-meter-row"><span class="m-label">Activity</span><span class="m-tool"></span></div>
      <div class="bar"><i></i></div>
    </div>
    <div class="waiting-region"></div>
    <div class="c-foot">
      <div class="who"><span class="avatar"></span><span class="who-id"></span></div>
      <span class="badge"></span>
    </div>
    <div class="actions">
      <input class="prompt-input" type="text" placeholder="send a prompt…" />
      <button class="btn icon send" title="Send prompt" aria-label="Send prompt">↑</button>
      <button class="btn icon interrupt" title="Interrupt the agent" aria-label="Interrupt">✕</button>
    </div>
    <div class="lvl-note hidden"></div>`;

  const input = el.querySelector('.prompt-input');
  const sendPrompt = () => {
    const text = input.value.trim();
    if (!text) return;
    postCommand(agentId, { intent: 'prompt', prompt: text });
    input.value = '';
  };
  el.querySelector('.send').addEventListener('click', sendPrompt);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendPrompt(); });
  el.querySelector('.interrupt').addEventListener('click',
    () => postCommand(agentId, { intent: 'interrupt' }));
  return el;
}

function updateCard(el, s) {
  el.dataset.status = s.status;
  el.querySelector('.kind').textContent = s.kind || '';
  el.querySelector('.ts').textContent = relTime(s.updatedAt);
  el.querySelector('.title').textContent = s.title || s.sessionId || s.agentId;
  el.querySelector('.subtitle').textContent = s.cwd || '';

  const caps = capsFor(s);
  const lvlEl = el.querySelector('.level');
  lvlEl.textContent = caps.level || '';
  lvlEl.dataset.level = caps.level || '';

  const allowPrompt = can(s, 'prompt');
  const allowAnswer = can(s, 'answer');
  const allowInterrupt = can(s, 'interrupt');

  let clue = '';
  const tool = s.activeTools && s.activeTools[0];
  if (s.status === 'waiting') clue = 'awaiting reply';
  else if (tool && tool.name) clue = tool.name;
  else if (s.lastReply) clue = '“' + s.lastReply.slice(0, 44) + '”';
  el.querySelector('.m-tool').textContent = clue;

  el.querySelector('.avatar').textContent = kindBadge(s.kind);
  el.querySelector('.who-id').textContent = (s.host ? s.host + ':' : '') + (s.sessionId || '');
  el.querySelector('.badge').textContent = s.status;

  const region = el.querySelector('.waiting-region');
  region.innerHTML = '';
  if (s.status === 'waiting' && s.waiting) {
    const banner = document.createElement('div');
    banner.className = 'waiting';
    const q = document.createElement('div');
    q.className = 'waiting-text';
    q.textContent = s.waiting.text || 'Waiting for input';
    banner.appendChild(q);

    const opts = Array.isArray(s.waiting.options) ? s.waiting.options : [];
    if (opts.length) {
      const row = document.createElement('div');
      row.className = 'options';
      for (const opt of opts) {
        const b = document.createElement('button');
        b.className = 'btn opt';
        b.textContent = opt;
        // Only wire the option when this provider accepts `answer`; otherwise show it disabled.
        if (allowAnswer) b.addEventListener('click', () => postCommand(s.agentId, { intent: 'answer', answer: opt }));
        else b.disabled = true;
        row.appendChild(b);
      }
      banner.appendChild(row);
    }
    region.appendChild(banner);
  }

  // Interaction follows the provider's ACAP level/capabilities.
  const input = el.querySelector('.prompt-input');
  const send = el.querySelector('.send');
  const intr = el.querySelector('.interrupt');
  input.classList.toggle('hidden', !allowPrompt);
  send.classList.toggle('hidden', !allowPrompt);
  intr.classList.toggle('hidden', !allowInterrupt);
  input.disabled = send.disabled = !allowPrompt;
  intr.disabled = !allowInterrupt;

  // No actionable intents (L0 observer, an ended session, or Cloud's prompt-only
  // gate leaving nothing) → hide the row and explain why.
  const actions = el.querySelector('.actions');
  const note = el.querySelector('.lvl-note');
  const interactive = allowPrompt || allowInterrupt;
  actions.classList.toggle('hidden', !interactive);
  note.classList.toggle('hidden', interactive);
  if (!interactive) {
    note.textContent = s.status === 'ended'
      ? 'Session ended — read-only'
      : `View-only · ${caps.level || 'L0'} (status only, no react-back)`;
  }
}

// ── React-back ────────────────────────────────────────────────────
async function postCommand(agentId, body) {
  try {
    const r = await fetch(`/${mode}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, ...body }),
    });
    const ack = await r.json().catch(() => ({}));
    if (ack && ack.status === 'delivered') {
      toast(`${body.intent} → delivered`, 'ok');
    } else if (ack && ack.error) {
      toast(`${body.intent} → ${ack.error}${ack.hint ? ' (' + ack.hint + ')' : ''}`, 'err');
    } else {
      toast(`${body.intent} → ${(ack && ack.status) || 'no response'}${ack && ack.detail ? ': ' + ack.detail : ''}`, 'warn');
    }
  } catch (e) {
    toast(`${body.intent} failed: ${e}`, 'err');
  }
}

// ── Auth (cloud) ──────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErr.textContent = '';
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;
  const btn = loginForm.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const r = await fetch('/cloud/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { loginForm.password.value = ''; afterAuth(j.email); }
    else loginErr.textContent = j.error || 'Login failed';
  } catch (e2) { loginErr.textContent = String(e2); }
  finally { btn.disabled = false; btn.textContent = 'Sign in'; }
});

tokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginErr.textContent = '';
  const access_token = tokenForm.access_token.value.trim();
  if (!access_token) return;
  const btn = tokenForm.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const r = await fetch('/cloud/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) { tokenForm.access_token.value = ''; afterAuth(j.email); }
    else loginErr.textContent = j.error || 'Token rejected';
  } catch (e2) { loginErr.textContent = String(e2); }
  finally { btn.disabled = false; }
});

logoutBtn.addEventListener('click', async () => {
  try { await fetch('/cloud/logout', { method: 'POST' }); } catch { /* ignore */ }
  disconnect();
  whoamiEl.textContent = '';
  document.body.dataset.view = 'login';
});

function afterAuth(email) {
  whoamiEl.textContent = email || '';
  document.body.dataset.view = 'board';
  connect();
}

for (const b of document.querySelectorAll('.mode-btn')) {
  b.addEventListener('click', () => switchMode(b.dataset.mode));
}

providerSelEl.addEventListener('change', () => {
  providerFilter = providerSelEl.value;
  localStorage.setItem('aca-web-provider', providerFilter);
  render();
});

// ── Helpers ───────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + (kind || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3800);
}

function relTime(ts) {
  if (!ts) return '';
  const then = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}
function short(url) { return String(url || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

setInterval(() => {
  for (const [id, el] of cardEls) {
    const s = sessions.get(id);
    if (s) el.querySelector('.ts').textContent = relTime(s.updatedAt);
  }
}, 15000);

// ── Boot ──────────────────────────────────────────────────────────
(async function boot() {
  buildStatusChips();
  try { config = await (await fetch('/config')).json(); } catch { /* defaults */ }
  applyModeChrome();
  await enterMode();
})();
