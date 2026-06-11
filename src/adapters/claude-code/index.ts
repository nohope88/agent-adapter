import path from 'path';
import { AdapterDescriptor } from '../types';
import { AGENT_DIRS } from '../../util/paths';

/** Claude Code — stock interactive CLI, no native input API. Status via hooks,
 *  react-back via pty/tmux + hook-return for approvals. */
const claudeCode: AdapterDescriptor = {
  kind: 'claude-code',
  level: 'L3',
  capabilities: ['prompt', 'answer', 'interrupt'],
  provides: ['status', 'title', 'activeTool', 'model', 'context', 'waiting'],
  inject: { channel: 'pty', hookReturn: true },
  detectDir: AGENT_DIRS['claude-code'],
  hooks: {
    configPath: path.join(AGENT_DIRS['claude-code'], 'settings.json'),
    format: 'claude',
    events: {
      SessionStart: 'SessionStart',
      UserPromptSubmit: 'UserPromptSubmit',
      PreToolUse: 'PreToolUse',
      PostToolUse: 'PostToolUse',
      Notification: 'Notification',
      Stop: 'Stop',
      SessionEnd: 'SessionEnd',
    },
  },
};

export default claudeCode;
