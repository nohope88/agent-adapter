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
  const list = [...sessions.values()].sort(
    (a, b) => (PRIORITY[a.status] - PRIORITY[b.status]) || ((b.updatedAt || 0) - (a.updatedAt || 0)),
  );

  for (const [id, el] of cardEls) {
    if (!sessions.has(id)) { el.remove(); cardEls.delete(id); }
  }

  let prev = null;
  for (const s of list) {
    let el = cardEls.get(s.agentId);
    if (!el) { el = buildCard(s.agentId); cardEls.set(s.agentId, el); }
    updateCard(el, s);
    if (prev) prev.after(el); else board.prepend(el);
    prev = el;
  }

  const counts = {};
  for (const s of list) counts[s.status] = (counts[s.status] || 0) + 1;
  countsEl.textContent = list.length
    ? Object.keys(PRIORITY).filter((k, i, a) => a.indexOf(k) === i && counts[k]).map((k) => `${counts[k]} ${k}`).join('  ·  ')
    : '';
  emptyEl.style.display = list.length ? 'none' : 'block';
}

function buildCard(agentId) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="c-head">
      <span class="kind"></span>
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
    </div>`;

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
        b.addEventListener('click', () => postCommand(s.agentId, { intent: 'answer', answer: opt }));
        row.appendChild(b);
      }
      banner.appendChild(row);
    }
    region.appendChild(banner);
  }

  // Ended sessions can't be acted on; Cloud is prompt-only so interrupt is off.
  const ended = s.status === 'ended';
  for (const b of el.querySelectorAll('.actions .btn, .actions input')) b.disabled = ended;
  const intr = el.querySelector('.interrupt');
  if (intr) {
    intr.disabled = ended || mode === 'cloud';
    intr.title = mode === 'cloud' ? 'Interrupt unavailable in Cloud (prompt-only)' : 'Interrupt the agent';
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
  try { config = await (await fetch('/config')).json(); } catch { /* defaults */ }
  applyModeChrome();
  await enterMode();
})();
