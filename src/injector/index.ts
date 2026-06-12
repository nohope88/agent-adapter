import { Ack, Command, SCHEMA_V } from '../protocol';
import { BindingMap } from '../binding';
import { PtyInjector, NoTargetError, KEYS } from './pty';
import { HookReturnChannel, decisionFromAnswer } from './hookReturn';
import { nativeSend } from './nativeApi';
import { logger } from '../util/log';

const log = logger('inject');

/** How a given adapter can be driven back. */
export interface InjectSpec {
  channel: 'pty' | 'native' | 'none';
  /** Adapter's hooks can answer permission prompts via their stdout decision. */
  hookReturn: boolean;
}

export class Injector {
  readonly pty = new PtyInjector();
  readonly hookReturn = new HookReturnChannel();

  constructor(private binding: BindingMap) {}

  async dispatch(cmd: Command, spec: InjectSpec): Promise<Ack> {
    const ack = (status: Ack['status'], detail?: string, reason?: string): Ack =>
      ({ v: SCHEMA_V, cmdId: cmd.cmdId, status, detail, reason });

    const target = this.binding.resolve(sessionIdOf(cmd.agentId));
    if (!target && spec.channel !== 'none') return ack('nosession', 'no binding for session');

    try {
      // Clean path first: stage a hook-return decision for approvals.
      let staged = false;
      if (cmd.intent === 'answer' && spec.hookReturn && cmd.answer) {
        this.hookReturn.stage(sessionIdOf(cmd.agentId), decisionFromAnswer(cmd.answer));
        staged = true;
      }

      if (spec.channel === 'native') {
        const detail = await nativeSend(target!, cmd);
        return ack('delivered', `native:${detail.slice(0, 40)}`);
      }

      if (spec.channel === 'pty') {
        const detail = await this.viaPty(cmd, target!);
        return ack('delivered', staged ? `${detail}+hookReturn` : detail);
      }

      // channel === 'none'
      return staged ? ack('delivered', 'hookReturn') : ack('rejected', 'adapter is read-only', 'unsupported-intent');
    } catch (e) {
      if (e instanceof NoTargetError) return ack('rejected', 'no inject target', 'agent-error');
      log.error('dispatch failed', String(e));
      return ack('rejected', String((e as Error).message || e), 'agent-error');
    }
  }

  private async viaPty(cmd: Command, target: NonNullable<ReturnType<BindingMap['resolve']>>): Promise<string> {
    switch (cmd.intent) {
      case 'answer':
        return 'pty:' + (await this.pty.typeText(target, cmd.answer ?? '', true));
      case 'prompt':
        return 'pty:' + (await this.pty.typeText(target, cmd.prompt ?? '', true));
      case 'interrupt':
        return 'pty:' + (await this.pty.sendKey(target, KEYS.escape));
      case 'mode':
        // No portable pty gesture for mode switching; surface as unsupported.
        throw new Error('mode switch not supported over pty');
      default:
        throw new Error(`unknown intent ${cmd.intent}`);
    }
  }
}

function sessionIdOf(agentId: string): string {
  // agentId = kind:host:sessionId  → take everything after the 2nd colon
  const parts = agentId.split(':');
  return parts.slice(2).join(':') || agentId;
}
