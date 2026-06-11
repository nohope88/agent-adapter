import { AdapterDescriptor } from '../types';
import { AGENT_DIRS } from '../../util/paths';

/** Gemini CLI — no confirmed hook system yet, so it ships at L0 (status via the
 *  process-fallback layer). Inject is best-effort pty. Add a `hooks` recipe here
 *  once Gemini CLI's event mechanism is verified — that's the only change needed. */
const gemini: AdapterDescriptor = {
  kind: 'gemini',
  level: 'L0',
  capabilities: ['prompt'],
  provides: ['status'],
  inject: { channel: 'pty', hookReturn: false },
  detectDir: AGENT_DIRS.gemini,
  // hooks: TODO — verify Gemini CLI's hook/settings format.
};

export default gemini;
