import { AdapterDescriptor } from '../types';
import { AGENT_DIRS } from '../../util/paths';

/** Gemini CLI — no confirmed hook system yet, so it ships at L0 (status via the
 *  process-fallback layer). Inject is best-effort pty. Add a `hooks` recipe here
 *  once Gemini CLI's event mechanism is verified — that's the only change needed. */
const gemini: AdapterDescriptor = {
  kind: 'gemini',
  level: 'L0',
  // L0 (Observer) is status-only — it MUST declare no capabilities (ACAP §11;
  // the Commander rejects register with "L0 must declare no capabilities"
  // otherwise). Add `prompt` here only when promoted to L1 with a verified
  // inject path.
  capabilities: [],
  provides: ['status'],
  inject: { channel: 'pty', hookReturn: false },
  detectDir: AGENT_DIRS.gemini,
  // hooks: TODO — verify Gemini CLI's hook/settings format.
};

export default gemini;
