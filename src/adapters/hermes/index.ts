import { AdapterDescriptor } from '../types';
import { AGENT_DIRS } from '../../util/paths';

/** Hermes — daemon with a local control socket/RPC. No hooks: status comes from
 *  the process-fallback layer until its control socket is wired here; inject is
 *  via its native control endpoint (controlEndpoint, learned through binding). */
const hermes: AdapterDescriptor = {
  kind: 'hermes',
  // L0 until its control socket is wired here — today it only gets the
  // process-fallback baseline (working/idle), like gemini.
  level: 'L0',
  // L0 (Observer) MUST declare no capabilities (ACAP §11; the Commander rejects
  // register otherwise). Restore prompt/answer/interrupt here together with the
  // raised level once the control socket below makes them real.
  capabilities: [],
  provides: ['status'],
  inject: { channel: 'native', hookReturn: false },
  detectDir: AGENT_DIRS.hermes,
  // poll / hooks: TODO — wrap the hermes control socket / RPC.
};

export default hermes;
