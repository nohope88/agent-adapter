import path from 'path';
import { AdapterDescriptor } from '../types';
import { AGENT_DIRS } from '../../util/paths';

/** Cursor — IDE, not a terminal. Native event names differ; hooks expose a
 *  permission-gating return value (the clean answer path). */
const cursor: AdapterDescriptor = {
  kind: 'cursor',
  level: 'L2',
  capabilities: ['answer', 'prompt'],
  provides: ['status', 'activeTool'],
  inject: { channel: 'none', hookReturn: true },
  detectDir: AGENT_DIRS.cursor,
  hooks: {
    configPath: path.join(AGENT_DIRS.cursor, 'hooks.json'),
    format: 'cursor',
    events: {
      beforeSubmitPrompt: 'UserPromptSubmit',
      beforeShellExecution: 'PreToolUse',
      beforeMCPExecution: 'PreToolUse',
      beforeReadFile: 'PreToolUse',
      afterShellExecution: 'PostToolUse',
      afterMCPExecution: 'PostToolUse',
      afterFileEdit: 'PostToolUse',
      stop: 'Stop',
    },
  },
};

export default cursor;
