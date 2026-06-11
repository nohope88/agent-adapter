import fs from 'fs';
import { PATHS, ensureRoot } from './paths';

/**
 * Single-instance guard. Writes a pidfile; if a live pid already holds it,
 * refuses to start a second hub (design: "double-install → single-instance lock").
 * Returns a release() to call on shutdown.
 */
export function acquireSingleInstance(): () => void {
  ensureRoot();
  if (fs.existsSync(PATHS.pidfile)) {
    const prev = Number(fs.readFileSync(PATHS.pidfile, 'utf8').trim());
    if (prev && prev !== process.pid && isAlive(prev)) {
      throw new Error(`another agent-adapter is already running (pid ${prev})`);
    }
  }
  fs.writeFileSync(PATHS.pidfile, String(process.pid), { mode: 0o600 });
  const release = () => {
    try {
      if (fs.existsSync(PATHS.pidfile) &&
          fs.readFileSync(PATHS.pidfile, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(PATHS.pidfile);
      }
    } catch { /* best-effort */ }
  };
  return release;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
