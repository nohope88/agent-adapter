/** Minimal structured logger. Levels gate on AGENT_ADAPTER_LOG (default "info"). */
type Lvl = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Lvl, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = ORDER[(process.env.AGENT_ADAPTER_LOG as Lvl) || 'info'] ?? 1;

function emit(lvl: Lvl, scope: string, msg: string, extra?: unknown) {
  if (ORDER[lvl] < threshold) return;
  const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
  if (extra !== undefined) out.write(`${line} ${safe(extra)}\n`);
  else out.write(`${line}\n`);
}

function safe(v: unknown): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', scope, m, e),
    info: (m: string, e?: unknown) => emit('info', scope, m, e),
    warn: (m: string, e?: unknown) => emit('warn', scope, m, e),
    error: (m: string, e?: unknown) => emit('error', scope, m, e),
  };
}
