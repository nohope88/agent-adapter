#!/usr/bin/env node
// Agent Adapter — Web UI server (external, standalone).
//
// Serves the static dashboard in ./public and proxies /api/* to the adapter's
// local control API (default http://127.0.0.1:7788). The browser only ever
// talks to THIS origin, so there is no CORS issue and the core adapter is
// never modified — this is a pure client of its existing control API.
//
//   node web/server.js
//   WEB_PORT=9000 AGENT_ADAPTER_CONTROL_PORT=7788 node web/server.js
//
// Zero dependencies (Node's http/fs only). Requires Node >= 18.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEB_HOST = process.env.WEB_HOST || '127.0.0.1';
const WEB_PORT = parseInt(process.env.WEB_PORT || '8787', 10);
const HUB_HOST = process.env.AGENT_ADAPTER_CONTROL_HOST || '127.0.0.1';
const HUB_PORT = parseInt(process.env.AGENT_ADAPTER_CONTROL_PORT || '7788', 10);
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) return proxy(req, res);
  return serveStatic(req, res);
});

// Forward /api/* → hub /*. The hub's control server doesn't keep connections
// alive and rejects chunked/streamed requests, so we buffer the (tiny) request
// body and send it with an explicit Content-Length on a fresh connection. The
// RESPONSE is still streamed (upRes.pipe), so SSE /api/stream works live.
function proxy(req, res) {
  const upstreamPath = req.url.slice('/api'.length) || '/';
  const headers = {};
  if (req.headers['accept']) headers['accept'] = req.headers['accept'];
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const up = http.request(
      // agent:false → a fresh, non-pooled connection per request (the hub
      // closes connections, so keep-alive reuse yields "socket hang up").
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
        detail: String(e && e.message ? e.message : e),
        hint: `is the adapter running? (control API expected on http://${HUB_HOST}:${HUB_PORT})`,
      }));
    });
    // Client (e.g. an EventSource) disconnected → tear down the upstream request.
    res.on('close', () => up.destroy());
    up.end(body.length ? body : undefined);
  });
}

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

server.listen(WEB_PORT, WEB_HOST, () => {
  process.stdout.write(
    `Agent Adapter dashboard → http://${WEB_HOST}:${WEB_PORT}\n` +
    `  proxying /api/* → http://${HUB_HOST}:${HUB_PORT}  ·  Ctrl-C to stop\n`,
  );
});
