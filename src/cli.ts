#!/usr/bin/env node

/**
 * aca CLI. Subcommands lazy-require their deps so `hook` stays light
 * (it's invoked on every agent event and must be fast).
 */
export async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'setup':                       // user-facing: detect agents, wire hooks, register the daemon
    case 'install':         return setup();
    case 'login':           return login(rest);
    case 'logout':          return logout();
    case 'stop':            return stop();           // stop the installed daemon service
    case 'verify':          return reconcile();
    case 'web':             return web(rest);    // open the dashboard against the running daemon
    // internal — not advertised in help:
    case 'hook':            return (await import('./hookClient')).runHook(rest); // agents call this per event
    case 'start':           return start(rest);                                  // the daemon runs this
    case 'uninstall':       return uninstall();
    case 'selfcheck':       return selfcheck();                                  // acap conformance (CI)
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
    process.stderr.write('Not logged in. Run `aca login --token <cmdr_ak_…>` first.\n');
    process.exit(1);
    return;
  }
  const commanderUrl = process.env.AGENT_ADAPTER_COMMANDER || DEFAULT_COMMANDER;
  const hub = new Hub({ commanderUrl, credential });
  await hub.start();
  process.stdout.write(
    `aca running (uplink → ${commanderUrl}). ` +
    `control: http://127.0.0.1:${hub.controlPort}  ·  Ctrl-C to stop\n`);
  const web = args.web ? await startWebUi(args, hub.controlPort, commanderUrl) : null;
  const shutdown = async () => { web?.kill(); await hub.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** `aca web` — dashboard only. Attaches to the ALREADY-running daemon's control
 *  API (no hub, no single-instance lock), so it never conflicts with the
 *  installed headless service. This is the command to run post-install. */
async function web(rest: string[]): Promise<void> {
  const args = flags(rest);
  const { readControlPort } = await import('./util/paths');
  const { DEFAULT_COMMANDER } = await import('./commanderClient');
  const controlPort = readControlPort();             // published by the running hub; falls back to default
  const commanderUrl = process.env.AGENT_ADAPTER_COMMANDER || DEFAULT_COMMANDER;
  const child = await startWebUi(args, controlPort, commanderUrl);
  if (!child) { process.exit(1); return; }
  process.stdout.write(`Local tab → running daemon on control port ${controlPort}; Cloud tab → ${commanderUrl}\n`);
  const shutdown = () => { child.kill(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  child.on('exit', (code) => process.exit(code ?? 0));
}

/** Spawn the external web dashboard (web/server.js) as a child of the hub.
 *  Fail-open: a missing or broken web UI must never take the adapter down. */
async function startWebUi(args: Record<string, string | boolean>, controlPort: number, commanderUrl?: string) {
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
    env: {
      ...process.env,
      WEB_PORT: webPort,
      AGENT_ADAPTER_CONTROL_PORT: String(controlPort),
      ...(commanderUrl ? { AGENT_ADAPTER_COMMANDER: commanderUrl } : {}),
    },
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

async function logout(): Promise<void> {
  const had = (await import('./hooks/installer')).clearCredential();
  process.stdout.write(had ? 'Logged out — credential removed.\n' : 'Not logged in.\n');
}

async function setup(): Promise<void> {
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
  process.stdout.write('Next: `aca login --token <cmdr_ak_…>` — the adapter starts once you log in.\n');
  process.stdout.write('Re-run `aca verify` whenever you install or remove an agent.\n');
}

async function reconcile(): Promise<void> {
  const inst = await import('./hooks/installer');
  const report = inst.detectReport();
  process.stdout.write('Detected agents:\n');
  for (const r of report) {
    process.stdout.write(`  ${r.installed ? '✓' : '·'} ${r.kind}${r.installed && !r.wired ? ' (process-baseline only)' : ''}\n`);
  }
  const wired = inst.reconcileHooks();
  process.stdout.write(`\nIn sync. Hooks wired for: ${wired.join(', ') || '(none)'}\n`);
}

async function stop(): Promise<void> {
  const res = (await import('./hooks/installer')).stopDaemon();
  switch (res.kind) {
    case 'stopped':
      process.stdout.write(`Adapter service stopped (${res.target}).\n`);
      return;
    case 'not-running':
      process.stdout.write(`No running service to stop (${res.target}). If you ran \`aca start\` in a terminal, stop it with Ctrl-C.\n`);
      return;
    case 'unsupported':
      process.stdout.write('No service manager on this platform. If you ran `aca start` in a terminal, stop it with Ctrl-C.\n');
      return;
  }
}

async function uninstall(): Promise<void> {
  (await import('./hooks/installer')).uninstallHooks();
  process.stdout.write('Hooks removed. Run `aca stop` to stop the running daemon.\n');
}

async function selfcheck(): Promise<void> {
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
    inst.saveCredential(token);
    process.stdout.write('Credential saved — the headless daemon uses it automatically.\n');
    process.stdout.write('Optional dashboard: `aca web`.\n');
    return;
  }
  process.stdout.write(
    'Login obtains a tenant API key FROM your Commander (dashboard → API keys) — the adapter only holds it.\n' +
    'Then: aca login --token <cmdr_ak_…>\n');
}

function help(): void {
  process.stdout.write(`aca — listen & react back to local AI coding agents (ACAP adapter)

  setup                                           detect agents, wire their hooks, register the daemon
  login --token <cmdr_ak_…>                       store the Commander credential
  logout                                          remove the stored credential
  stop                                            stop the running adapter service (launchd/systemd/schtasks)
  verify                                          re-scan agents; add/remove hooks to match what's installed
  web   [--web-port <n>] [--open]                 open the dashboard (attaches to the running daemon)
`);
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
