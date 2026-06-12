'use strict';
// Live dashboard for the Agent Adapter. Connects to the hub's SSE stream
// (via the local proxy at /api/stream), renders one card per session, and
// posts react-back commands (answer / prompt / interrupt) to /api/command.
//
// Cards are reconciled in place by agentId so a live update never clears the
// prompt field you're typing in.

const PRIORITY = { waiting: 0, error: 1, busy: 2, idle: 3, ended: 4 };
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

// ── SSE connection ────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('open', () => setConn(true));
  es.addEventListener('error', () => setConn(false));
  es.addEventListener('roster', (e) => {
    sessions.clear();
    for (const s of safeParse(e.data, [])) sessions.set(s.agentId, s);
    render();
  });
  es.addEventListener('status', (e) => {
    const s = safeParse(e.data, null);
    if (s && s.agentId) { sessions.set(s.agentId, s); render(); }
  });
}

function setConn(ok) {
  connEl.textContent = ok ? 'live' : 'reconnecting…';
  connEl.className = 'conn ' + (ok ? 'conn--on' : 'conn--off');
}

// ── Render ────────────────────────────────────────────────────────
function render() {
  const list = [...sessions.values()].sort(
    (a, b) => (PRIORITY[a.status] - PRIORITY[b.status]) || ((b.updatedAt || 0) - (a.updatedAt || 0)),
  );

  // Remove cards for sessions no longer present.
  for (const [id, el] of cardEls) {
    if (!sessions.has(id)) { el.remove(); cardEls.delete(id); }
  }

  // Upsert + order.
  let prev = null;
  for (const s of list) {
    let el = cardEls.get(s.agentId);
    if (!el) { el = buildCard(s.agentId); cardEls.set(s.agentId, el); }
    updateCard(el, s);
    if (prev) prev.after(el); else board.prepend(el);
    prev = el;
  }

  // Counts + empty state.
  const counts = {};
  for (const s of list) counts[s.status] = (counts[s.status] || 0) + 1;
  countsEl.textContent = list.length
    ? Object.keys(PRIORITY).filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join('  ·  ')
    : '';
  emptyEl.style.display = list.length ? 'none' : 'block';
}

// Build the static skeleton once. The prompt input persists across updates.
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

// Fill a card from a snapshot. Status drives the corner glow, bar, avatar and
// badge colors (all via [data-status] in CSS). Only the waiting region is
// rebuilt; the prompt input is left untouched.
function updateCard(el, s) {
  el.dataset.status = s.status;
  el.querySelector('.kind').textContent = s.kind || '';
  el.querySelector('.ts').textContent = relTime(s.updatedAt);
  el.querySelector('.title').textContent = s.title || s.sessionId || s.agentId;
  el.querySelector('.subtitle').textContent = s.cwd || '';

  // Meter clue (right of "Activity"): the live tool, or a short last reply.
  let clue = '';
  const tool = s.activeTools && s.activeTools[0];
  if (s.status === 'waiting') clue = 'awaiting reply';
  else if (tool && tool.name) clue = tool.name;
  else if (s.lastReply) clue = '“' + s.lastReply.slice(0, 44) + '”';
  el.querySelector('.m-tool').textContent = clue;

  // Footer: agent avatar + short id + status badge.
  el.querySelector('.avatar').textContent = kindBadge(s.kind);
  el.querySelector('.who-id').textContent = (s.host ? s.host + ':' : '') + (s.sessionId || '');
  el.querySelector('.badge').textContent = s.status;

  // Waiting banner + option pills.
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

  // Ended sessions can't be acted on.
  const ended = s.status === 'ended';
  for (const b of el.querySelectorAll('.actions .btn, .actions input')) b.disabled = ended;
}

// ── React-back ────────────────────────────────────────────────────
async function postCommand(agentId, body) {
  try {
    const r = await fetch('/api/command', {
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

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// Refresh relative timestamps periodically without a server round-trip.
setInterval(() => {
  for (const [id, el] of cardEls) {
    const s = sessions.get(id);
    if (s) el.querySelector('.ts').textContent = relTime(s.updatedAt);
  }
}, 15000);

connect();
