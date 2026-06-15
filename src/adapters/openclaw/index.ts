import fs from 'fs';
import path from 'path';
import { AdapterDescriptor } from '../types';
import { HookEvent } from '../../protocol';
import { AGENT_DIRS } from '../../util/paths';

const SESSIONS_DIR = path.join(AGENT_DIRS.openclaw, 'sessions');
const ACTIVE_MS = 10_000; // a session file touched within 10s = working

/** OpenClaw — API-native. No hooks: we poll its session JSONL files for
 *  working/idle (the same approach oc-claw uses for OpenClaw). Native control
 *  endpoint for inject is learned via binding (controlEndpoint) once known. */
const openclaw: AdapterDescriptor = {
  kind: 'openclaw',
  // L0 (Observer) — status only. The native inject path has no controlEndpoint
  // wired yet (binding never learns one), so a `prompt` cmd can't actually be
  // delivered. Stay honest at L0 like hermes; restore L1 ["prompt"] in the same
  // change that wires the controlEndpoint (then L2 with answer/interrupt).
  level: 'L0',
  capabilities: [],
  provides: ['status'],
  inject: { channel: 'native', hookReturn: false },
  detectDir: AGENT_DIRS.openclaw,
  poll: (emit) => {
    const seen = new Map<string, boolean>(); // sessionId → wasActive
    const tick = () => {
      let files: string[] = [];
      try {
        files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
      } catch { return; }
      const now = Date.now();
      for (const f of files) {
        const sessionId = f.replace(/\.jsonl$/, '');
        let mtime = 0;
        try { mtime = fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs; } catch { continue; }
        const active = now - mtime < ACTIVE_MS;
        if (!seen.has(sessionId)) {
          emit(mkEvent(sessionId, 'SessionStart'));
        }
        if (seen.get(sessionId) !== active) {
          emit(mkEvent(sessionId, active ? 'UserPromptSubmit' : 'Stop'));
          seen.set(sessionId, active);
        }
      }
    };
    const timer = setInterval(tick, 2000);
    if (timer.unref) timer.unref();
    tick();
    return () => clearInterval(timer);
  },
};

function mkEvent(sessionId: string, event: HookEvent['event']): HookEvent {
  return { v: 1, kind: 'openclaw', event, sessionId, cwd: SESSIONS_DIR };
}

export default openclaw;
