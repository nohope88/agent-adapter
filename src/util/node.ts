import fs from 'fs';
import path from 'path';

const STABLE_CANDIDATES = [
  // macOS / Linux
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
  // Windows — official installer; nvm-windows junction (resolves to the active version)
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files\\nvm\\nodejs\\node.exe',
];

/**
 * A node path that survives version upgrades. `process.execPath` is the
 * version-pinned realpath (e.g. …/Cellar/node/25.8.1_1/bin/node on Homebrew,
 * ~/.nvm/versions/node/vX/… on nvm); a later `brew upgrade` / version switch
 * deletes it, silently breaking the daemon and every hook. Prefer a stable
 * symlink that resolves to the SAME node we run now; fall back to execPath when
 * none matches (e.g. nvm — no stable path, documented limitation).
 *
 * Dependencies are injected so the resolution logic is testable off-machine.
 */
export function stableNode(
  exec: string = process.execPath,
  realpath: (p: string) => string = fs.realpathSync,
  candidates: string[] = STABLE_CANDIDATES,
): string {
  if (path.basename(exec).includes('agent-adapter')) return exec; // packaged binary, not node
  for (const c of candidates) {
    try { if (realpath(c) === exec) return c; } catch { /* not present */ }
  }
  return exec;
}
