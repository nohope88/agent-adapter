import http from 'http';
import { URL } from 'url';
import { Command } from '../protocol';
import { InjectTarget } from '../binding';

/**
 * Native-API injection for agents with their own local control endpoint
 * (openclaw, hermes). We POST the canonical command; the adapter's manifest
 * supplies the endpoint shape. Best-effort: returns the response body or throws.
 */
export function nativeSend(target: InjectTarget, cmd: Command): Promise<string> {
  if (!target.controlEndpoint) {
    return Promise.reject(new Error('no controlEndpoint for native injection'));
  }
  const url = new URL(target.controlEndpoint);
  const body = JSON.stringify({
    sessionId: target.sessionId,
    intent: cmd.intent,
    prompt: cmd.prompt,
    answer: cmd.answer,
    mode: cmd.mode,
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          res.statusCode && res.statusCode < 400
            ? resolve(data)
            : reject(new Error(`native endpoint ${res.statusCode}`)));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('native endpoint timeout')));
    req.write(body);
    req.end();
  });
}
