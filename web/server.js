#!/usr/bin/env node
'use strict';
// Agent Adapter — Web UI server (dual-source: LOCAL hub + CLOUD Commander).
//
//   /local/*  → reverse-proxy to the local adapter control API (no auth,
//               full react-back: prompt / answer / interrupt). Same behaviour
//               the dashboard always had.
//   /cloud/*  → bridge to the Commander API (UserAuth): login or pasted access
//               token, poll GET /api/agents into an SSE roster, prompt-only
//               react-back via POST /api/agents/{id}/prompt.
//
// Keeping both side-by-side lets you debug the integration: if an agent shows
// in Local but not in Cloud, the uplink (register/status-push) is the culprit.
//
// The browser only ever talks to THIS origin — the cloud token stays server-side,
// no CORS, and the core adapter is never modified.
//
//   node web/server.js
//   WEB_PORT=9000 AGENT_ADAPTER_CONTROL_PORT=7788 \
//   AGENT_ADAPTER_COMMANDER=https://commander-api.autonomous.ai node web/server.js
//
// Zero dependencies (Node http/fs + global fetch). Requires Node >= 18.
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_HOST = process.env.WEB_HOST || '127.0.0.1';
const WEB_PORT = parseInt(process.env.WEB_PORT || '8787', 10);
const HUB_HOST = process.env.AGENT_ADAPTER_CONTROL_HOST || '127.0.0.1';
const HUB_PORT = parseInt(process.env.AGENT_ADAPTER_CONTROL_PORT || '7788', 10);
const COMMANDER = (process.env.AGENT_ADAPTER_COMMANDER || 'https://commander-api.autonomous.ai').replace(/\/+$/, '');
const POLL_MS = parseInt(process.env.WEB_POLL_MS || '2000', 10);
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// ── cloud auth state (held server-side; never sent to the browser) ──
const auth = { accessToken: null, refreshToken: null, email: null, mode: null };
const cloudAuthed = () => Boolean(auth.accessToken);
const clearAuth = () => { auth.accessToken = auth.refreshToken = auth.email = auth.mode = null; };
const idIndex = new Map(); // agent_id (frontend) → Commander record id (for /prompt routing)

const server = http.createServer(async (req, res) => {
  const p = (req.url || '/').split('?')[0];
  try {
    if (p.startsWith('/local/')) return proxyToHub(req, res, p.slice('/local'.length) || '/');
    if (p.startsWith('/cloud/')) return await cloudRoute(req, res, p.slice('/cloud'.length));
    if (p === '/config') return json(res, 200, { hub: `${HUB_HOST}:${HUB_PORT}`, commander: COMMANDER });
    return serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: 'server error', detail: String((e && e.message) || e) });
  }
});

// ── LOCAL: reverse-proxy /local/* → hub /* ─────────────────────────
// The hub closes connections and rejects chunked bodies, so we buffer the
// (tiny) request and send it with Content-Length on a fresh, non-pooled
// connection. The RESPONSE is streamed (pipe), so SSE /local/stream stays live.
function proxyToHub(req, res, upstreamPath) {
  const headers = {};
  if (req.headers['accept']) headers['accept'] = req.headers['accept'];
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const up = http.request(
      { host: HUB_HOST, port: HUB_PORT, path: upstreamPath, method: req.method, headers, agent: false },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        upRes.pipe(res);
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'hub unreachable',
        detail: String((e && e.message) || e),
        hint: `is the adapter running? (control API expected on http://${HUB_HOST}:${HUB_PORT})`,
      }));
    });
    res.on('close', () => up.destroy());
    up.end(body.length ? body : undefined);
  });
}

// ── CLOUD: bridge /cloud/* → Commander API ─────────────────────────
async function cloudRoute(req, res, sub) {
  if (sub === '/auth' && req.method === 'GET') {
    return json(res, 200, { authed: cloudAuthed(), email: auth.email, mode: auth.mode });
  }
  if (sub === '/raw' && req.method === 'GET') {            // DEBUG: raw GET /api/agents
    if (!cloudAuthed()) return json(res, 401, { error: 'not authenticated' });
    const r = await cFetch('/api/agents?limit=200');
    const body = await r.text();
    let parsed = null; try { parsed = JSON.parse(body); } catch { /* keep raw */ }
    return json(res, 200, { upstreamStatus: r.status, pickArrayLen: pickArray(parsed || {}).length, raw: body.slice(0, 6000) });
  }
  if (sub === '/me' && req.method === 'GET') {             // DEBUG: who am I to the Commander
    if (!cloudAuthed()) return json(res, 401, { error: 'not authenticated' });
    const r = await cFetch('/api/auth/me');
    return json(res, r.status, await r.json().catch(() => ({})));
  }
  if (sub === '/login' && req.method === 'POST') return cloudLogin(req, res);
  if (sub === '/token' && req.method === 'POST') return cloudToken(req, res);
  if (sub === '/logout' && req.method === 'POST') { clearAuth(); return json(res, 200, { ok: true }); }
  if (sub === '/stream' && req.method === 'GET') return cloudStream(req, res);
  if (sub === '/command' && req.method === 'POST') return cloudCommand(req, res);
  return json(res, 404, { error: 'not found' });
}

// Authenticated Commander fetch, with one transparent refresh on 401.
async function cFetch(p, { method = 'GET', body, _retried } = {}) {
  const res = await fetch(COMMANDER + p, {
    method,
    headers: {
      ...(auth.accessToken ? { authorization: 'Bearer ' + auth.accessToken } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && auth.refreshToken && !_retried) {
    if (await refreshAccess()) return cFetch(p, { method, body, _retried: true });
  }
  return res;
}

async function refreshAccess() {
  try {
    const r = await fetch(COMMANDER + '/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: auth.refreshToken }),
    });
    if (!r.ok) { clearAuth(); return false; }
    const d = unwrap(await r.json().catch(() => ({})));
    if (!d.access_token && !d.accessToken) { clearAuth(); return false; }
    auth.accessToken = d.access_token || d.accessToken;
    if (d.refresh_token || d.refreshToken) auth.refreshToken = d.refresh_token || d.refreshToken;
    return true;
  } catch { clearAuth(); return false; }
}

async function cloudLogin(req, res) {
  const { email, password } = await readBody(req);
  if (!email || !password) return json(res, 400, { error: 'email and password required' });
  let r;
  try {
    r = await fetch(COMMANDER + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) { return json(res, 502, { error: 'commander unreachable', detail: String((e && e.message) || e) }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return json(res, r.status, { error: errOf(j) || 'login failed' });
  const d = unwrap(j);
  if (!d.access_token && !d.accessToken) return json(res, 502, { error: 'login response missing access_token' });
  auth.accessToken = d.access_token || d.accessToken;
  auth.refreshToken = d.refresh_token || d.refreshToken || null;
  auth.email = email;
  auth.mode = 'login';
  return json(res, 200, { ok: true, email, mode: 'login' });
}

async function cloudToken(req, res) {
  const { access_token } = await readBody(req);
  const tok = String(access_token || '').trim();
  if (!tok) return json(res, 400, { error: 'access_token required' });
  auth.accessToken = tok;
  auth.refreshToken = null;
  auth.mode = 'token';
  // Validate + identify via /api/auth/me.
  const r = await cFetch('/api/auth/me');
  if (!r.ok) { clearAuth(); return json(res, 401, { error: 'token rejected by Commander' }); }
  const d = unwrap(await r.json().catch(() => ({})));
  auth.email = d.email || d.userEmail || 'token';
  return json(res, 200, { ok: true, email: auth.email, mode: 'token' });
}

function cloudStream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  let alive = true; let t = null;
  const hb = setInterval(() => { if (alive) res.write(': hb\n\n'); }, 25000);
  const stop = () => { alive = false; if (t) clearTimeout(t); clearInterval(hb); };
  res.on('close', stop);
  const tick = async () => {
    if (!alive) return;
    if (!cloudAuthed()) { sse(res, 'unauth', {}); t = setTimeout(tick, POLL_MS); return; }
    try {
      const r = await cFetch('/api/agents?limit=200');
      if (r.status === 401) sse(res, 'unauth', {});
      else if (r.ok) {
        const arr = pickArray(await r.json().catch(() => ({})));
        idIndex.clear();
        // Hide the per-kind ":adapter" connection holders — show only real sessions.
        const real = arr.filter((a) => !String(a.agent_id || '').endsWith(':adapter'));
        sse(res, 'roster', real.map(mapAgent));
      } else {
        sse(res, 'srverr', { status: r.status });
      }
    } catch { /* transient — try again next tick */ }
    if (alive) t = setTimeout(tick, POLL_MS);
  };
  tick();
}

async function cloudCommand(req, res) {
  if (!cloudAuthed()) return json(res, 401, { error: 'not authenticated' });
  const b = await readBody(req);
  const { agentId, intent } = b;
  if (!agentId) return json(res, 400, { error: 'agentId required' });
  if (intent === 'interrupt') {
    return json(res, 400, { error: 'interrupt unsupported in Cloud', hint: 'Commander API is prompt-only — use Local mode' });
  }
  const text = intent === 'answer' ? String(b.answer || '') : String(b.prompt || '');
  if (!text) return json(res, 400, { error: 'empty prompt' });
  const id = idIndex.get(agentId) || agentId;
  const r = await cFetch(`/api/agents/${encodeURIComponent(id)}/prompt`, { method: 'POST', body: { prompt: text } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return json(res, 401, { error: 'session expired', hint: auth.mode === 'token' ? 're-paste token' : 're-login' });
  if (!r.ok) return json(res, r.status, { error: errOf(j) || 'prompt failed', detail: j && j.detail });
  return json(res, 200, { status: 'delivered', intent: intent || 'prompt' });
}

// Commander models.Agent (snake_case) → the AgentStatus shape app.js renders.
function mapAgent(a) {
  const agentId = a.agent_id || a.id || '';
  if (agentId && a.id) idIndex.set(agentId, a.id);
  const status = typeof a.status === 'string' ? a.status : (a.status && (a.status.state || a.status.status)) || 'idle';
  return {
    agentId,
    kind: a.kind,
    status,
    updatedAt: toMs(a.updated_at || a.status_changed_at || a.last_seen_at),
    title: a.title,
    sessionId: discOf(agentId),
    cwd: a.cwd,
    host: a.host,
    activeTools: Array.isArray(a.active_tools)
      ? a.active_tools.map((t) => ({ name: t.name || t.Name, inputPreview: t.input_preview || t.inputPreview, startedAt: toMs(t.started_at || t.startedAt) }))
      : [],
    lastReply: a.last_reply,
    waiting: a.waiting || null,
    online: a.online,
  };
}

// ── helpers ────────────────────────────────────────────────────────
function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { resolve({}); } });
  });
}
function unwrap(j) { return (j && typeof j === 'object' && j.data && typeof j.data === 'object') ? j.data : (j || {}); }
function errOf(j) { return j && (j.error || j.message || j.code); }
// Commander list endpoints wrap the array as { data: { items: [...], total, page } }.
function pickArray(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  if (Array.isArray(j.items)) return j.items;
  if (Array.isArray(j.agents)) return j.agents;
  if (Array.isArray(j.data)) return j.data;
  if (j.data && typeof j.data === 'object') {
    if (Array.isArray(j.data.items)) return j.data.items;   // ← /api/agents shape
    if (Array.isArray(j.data.agents)) return j.data.agents;
  }
  return [];
}
function discOf(agentId) {
  if (!agentId) return '';
  const parts = String(agentId).split(':');
  return parts.length > 2 ? parts.slice(2).join(':') : parts[parts.length - 1];
}
function toMs(v) {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(n) ? undefined : n;
}

server.listen(WEB_PORT, WEB_HOST, () => {
  process.stdout.write(
    `Agent Adapter dashboard → http://${WEB_HOST}:${WEB_PORT}\n` +
    `  Local  /local/*  → http://${HUB_HOST}:${HUB_PORT}  (no auth, full react-back)\n` +
    `  Cloud  /cloud/*  → ${COMMANDER}  (UserAuth, prompt-only)  ·  Ctrl-C to stop\n`,
  );
});
