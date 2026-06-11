import { execFile } from 'child_process';
import { InjectTarget } from '../binding';
import { logger } from '../util/log';

const log = logger('inject.pty');

export class NoTargetError extends Error {}

/** Keystrokes we map non-text intents onto. */
export const KEYS = {
  enter: 'Enter',
  escape: 'Escape',
  ctrlC: 'C-c',
};

/**
 * Terminal-agent injection. Two real strategies:
 *   1) tmux send-keys  — if the session runs in a tmux pane (clean, no special perms)
 *   2) a node-pty the adapter itself spawned ("managed" sessions)
 * If neither resolves, we reject with NoTargetError so the caller can ack rejected.
 */
export class PtyInjector {
  /** sessionId → write() for sessions the adapter launched under its own pty. */
  private managed = new Map<string, (data: string) => void>();

  registerManaged(sessionId: string, write: (data: string) => void): void {
    this.managed.set(sessionId, write);
  }
  unregisterManaged(sessionId: string): void {
    this.managed.delete(sessionId);
  }

  /** Type `text` then optionally Enter into the session's terminal. */
  async typeText(target: InjectTarget, text: string, enter = true): Promise<string> {
    const managed = this.managed.get(target.sessionId);
    if (managed) {
      managed(text + (enter ? '\r' : ''));
      return 'managed-pty';
    }
    const pane = target.tmuxPane || (await this.findTmuxPane(target));
    if (pane) {
      await tmuxSendLiteral(pane, text);
      if (enter) await tmuxSendKeys(pane, KEYS.enter);
      return `tmux:${pane}`;
    }
    throw new NoTargetError(`no pty target for session ${target.sessionId}`);
  }

  /** Send a control key (interrupt). */
  async sendKey(target: InjectTarget, key: string): Promise<string> {
    const managed = this.managed.get(target.sessionId);
    if (managed) {
      managed(key === KEYS.escape ? '\x1b' : '\x03');
      return 'managed-pty';
    }
    const pane = target.tmuxPane || (await this.findTmuxPane(target));
    if (pane) {
      await tmuxSendKeys(pane, key);
      return `tmux:${pane}`;
    }
    throw new NoTargetError(`no pty target for session ${target.sessionId}`);
  }

  /** Best-effort: locate a tmux pane whose cwd or pid matches the session. */
  private async findTmuxPane(target: InjectTarget): Promise<string | null> {
    try {
      const out = await run('tmux', [
        'list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_path}\t#{pane_pid}',
      ]);
      for (const line of out.split('\n')) {
        const [pane, path, pid] = line.split('\t');
        if (!pane) continue;
        if (target.pid && Number(pid) === target.pid) return pane;
        if (target.cwd && path && samePath(path, target.cwd)) return pane;
      }
    } catch (e) {
      log.debug('tmux not available / no panes', String(e));
    }
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

function tmuxSendLiteral(pane: string, text: string): Promise<string> {
  // -l sends text literally (no key-name interpretation).
  return run('tmux', ['send-keys', '-t', pane, '-l', text]);
}
function tmuxSendKeys(pane: string, key: string): Promise<string> {
  return run('tmux', ['send-keys', '-t', pane, key]);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}
