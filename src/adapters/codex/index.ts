import path from 'path';
import { AdapterDescriptor } from '../types';
import { AGENT_DIRS } from '../../util/paths';

/** Codex — non-interactive drive available; same hook pipeline as Claude Code. */
const codex: AdapterDescriptor = {
  kind: 'codex',
  level: 'L2',
  capabilities: ['prompt', 'answer', 'interrupt'],
  provides: ['status', 'activeTool', 'model'],
  inject: { channel: 'pty', hookReturn: true },
  detectDir: AGENT_DIRS.codex,
  hooks: {
    configPath: path.join(AGENT_DIRS.codex, 'hooks.json'),
    format: 'codex',
    events: {
      SessionStart: 'SessionStart',
      UserPromptSubmit: 'UserPromptSubmit',
      PreToolUse: 'PreToolUse',
      PostToolUse: 'PostToolUse',
      PermissionRequest: 'PermissionRequest',
      Stop: 'Stop',
      StopFailure: 'Stop',
    },
  },
};

export default codex;
