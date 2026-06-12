#!/usr/bin/env node
import http from 'http';
import { readControlPort } from './util/paths';

/**
 * agent-adapter CLI. Subcommands lazy-require their deps so `hook` stays light
 * (it's invoked on every agent event and must be fast).
 */
export async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'hook':            return (await import('./hookClient')).runHook(rest);
    case 'start':           return start(rest);
    case 'status':          return status();
    case 'answer':          return command('answer', rest[0], { answer: rest.slice(1).join(' ') });
    case 'prompt':          return command('prompt', rest[0], { prompt: rest.slice(1).join(' ') });
    case 'interrupt':       return command('interrupt', rest[0], {});
    case 'install':         return install();
    case 'uninstall':       return uninstall();
    case 'detect':          return detect();
    case 'verify':          return verify();
    case 'login':           return login(rest);
    case undefined:
    case 'help':
    case '--help':          return help();
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      help();
      process.exit(2);
  }
}

async function start(rest: string[]): Promise<void> {
  const args = flags(rest);
  const { Hub } = await import('./hub');
  const { loadCredential } = await import('./hooks/installer');
  const { DEFAULT_COMMANDER } = await import('./commanderClient');
  const credential = loadCredential();
  if (!credential) {
    process.stderr.write('Not logged in. Run `agent-adapter login --token <cmdr_ak_…> [--commander <https-url>]` first.\n');
    process.exit(1);
    return;
  }
  const commanderUrl = typeof args.commander === 'string'
    ? args.commander
    : (process.env.AGENT_ADAPTER_COMMANDER || DEFAULT_COMMANDER);
  const hub = new Hub({ commanderUrl, credential });
  await hub.start();
  process.stdout.write(
    `agent-adapter running (uplink → ${commanderUrl}). ` +
    `control: http://127.0.0.1:${hub.controlPort}  ·  Ctrl-C to stop\n`);
  const web = args.web ? await startWebUi(args, hub.controlPort) : null;
  const shutdown = async () => { web?.kill(); await hub.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Spawn the external web dashboard (web/server.js) as a child of the hub.
 *  Fail-open: a missing or broken web UI must never take the adapter down. */
async function startWebUi(args: Record<string, string | boolean>, controlPort: number) {
  const path = await import('path');
  const fs = await import('fs');
  const { spawn } = await import('child_process');
  const server = path.resolve(__dirname, '..', 'web', 'server.js');
  if (!fs.existsSync(server)) {
    process.stderr.write(`web UI not found at ${server} — skipping --web\n`);
    return null;
  }
  const webPort = String(typeof args['web-port'] === 'string' ? args['web-port'] : process.env.WEB_PORT || '8787');
  const child = spawn(process.execPath, [server], {
    // Point the dashboard's /api proxy at THIS hub's actual control port.
    env: { ...process.env, WEB_PORT: webPort, AGENT_ADAPTER_CONTROL_PORT: String(controlPort) },
    stdio: 'inherit',
  });
  child.on('error', (e) => process.stderr.write(`web UI failed to start: ${String(e)}\n`));
  const url = `http://127.0.0.1:${webPort}`;
  process.stdout.write(`dashboard: ${url}\n`);
  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    try { spawn(opener, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* best-effort */ }
  }
  return child;
}

async function status(): Promise<void> {
  try {
    const roster = (await getJson('/agents')) as Array<Record<string, unknown>>;
    if (!roster.length) { process.stdout.write('(no active sessions)\n'); return; }
    const dot: Record<string, string> = { waiting: '⚠', busy: '●', idle: '○', error: '✖', ended: '·' };
    for (const s of roster) {
      const st = String(s.status);
      const w = s.waiting ? `  ← ${(s.waiting as { text: string }).text}` : '';
      process.stdout.write(
        `${dot[st] ?? '?'} ${st.padEnd(7)} ${String(s.agentId).padEnd(34)} ${s.title ?? ''}${w}\n`);
    }
  } catch {
    process.stderr.write('cannot reach hub — is `agent-adapter start` running?\n');
    process.exit(1);
  }
}

async function command(intent: string, agentId: string | undefined, extra: Record<string, string>): Promise<void> {
  if (!agentId) { process.stderr.write(`usage: agent-adapter ${intent} <agentId> [...]\n`); process.exit(2); }
  try {
    const ack = await postJson('/command', { agentId, intent, ...extra });
    process.stdout.write(`${JSON.stringify(ack)}\n`);
  } catch (e) {
    process.stderr.write(`failed: ${String(e)}\n`); process.exit(1);
  }
}

async function install(): Promise<void> {
  const inst = await import('./hooks/installer');
  const report = inst.detectReport();
  process.stdout.write('Detected agents:\n');
  for (const r of report) {
    process.stdout.write(`  ${r.installed ? '✓' : '·'} ${r.kind}${r.installed && !r.wired ? ' (process-baseline only)' : ''}\n`);
  }
  const wired = inst.installHooks();
  inst.registerDaemon();
  process.stdout.write(`\nWired hooks for: ${wired.join(', ') || '(none)'}\n`);
  process.stdout.write('Daemon registered (runs the headless adapter).\n');
  process.stdout.write('Next: `agent-adapter login --token <cmdr_ak_…>` — the adapter starts once you log in.\n');
  process.stdout.write('Optional dashboard: `agent-adapter start --web`.\n');
}

async function uninstall(): Promise<void> {
  (await import('./hooks/installer')).uninstallHooks();
  process.stdout.write('Hooks removed. (Daemon: launchctl/systemctl/schtasks remove manually if desired.)\n');
}

async function detect(): Promise<void> {
  const report = (await import('./hooks/installer')).detectReport();
  for (const r of report) {
    process.stdout.write(`${r.installed ? '✓ installed' : '· absent  '}  ${r.kind.padEnd(12)} ${r.wired ? 'hooks' : 'process-baseline'}\n`);
  }
}

async function verify(): Promise<void> {
  const results = (await import('./acapVerify')).verifyAll();
  let ok = true;
  for (const r of results) {
    process.stdout.write(`${r.pass ? '✓' : '✗'} ${r.kind}\n`);
    for (const p of r.problems) { ok = false; process.stdout.write(`    - ${p}\n`); }
  }
  process.exit(ok ? 0 : 1);
}

async function login(rest: string[]): Promise<void> {
  const args = flags(rest);
  const inst = await import('./hooks/installer');
  if (args.token) {
    const token = String(args.token);
    // Best-effort fail-fast: verify the key when an http(s) Commander is named.
    if (typeof args.commander === 'string' && /^https?:\/\//i.test(args.commander)) {
      try {
        const { verifyKey } = await import('./commanderClient');
        const who = await verifyKey(args.commander, token);
        const acct = who.userEmail || who.userName || who.keyName || 'account';
        process.stdout.write(`Key verified — ${acct} (acap ${who.acap || '?'}).\n`);
      } catch (e) {
        process.stdout.write(`Warning: could not verify key against ${args.commander}: ${String(e)}\n`);
      }
    }
    inst.saveCredential(token);
    process.stdout.write('Credential saved.\n');
    process.stdout.write(`Start with: agent-adapter start${args.commander ? ' --commander ' + args.commander : ''}\n`);
    return;
  }
  process.stdout.write(
    'Login obtains a tenant API key FROM your Commander (dashboard → API keys) — the adapter only holds it.\n' +
    'Then: agent-adapter login --token <cmdr_ak_…> [--commander <https-url>]\n');
}

function help(): void {
  process.stdout.write(`agent-adapter — listen to & react back to local AI coding agents

  start [--commander <url>]                 run the hub (requires login; daemon entrypoint)
        [--web] [--web-port N] [--open]       …also serve the web dashboard
  status                                    show the live session roster
  answer <agentId> <choice>                 react to a waiting agent (e.g. yes)
  prompt <agentId> <text...>                send a prompt into an agent
  interrupt <agentId>                       interrupt a running agent
  install                                   detect agents, wire hooks, register daemon
  uninstall                                 remove installed hooks
  detect                                    show which agents are present
  verify                                    run acap-verify on all adapters
  login --token <t> [--commander <url>]     store a Commander credential
  hook --kind <k> --event <e>               (internal) invoked by agent hooks
`);
}

// ── tiny control-API client ────────────────────────────────────
function getJson(pathname: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: readControlPort(), path: pathname }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
function postJson(pathname: string, body: unknown): Promise<unknown> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: readControlPort(), path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function flags(rest: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    }
  }
  return out;
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`${String(e?.stack || e)}\n`); process.exit(1); });
}
