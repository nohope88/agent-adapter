import { ALL_ADAPTERS } from './adapters/registry';
import { AdapterDescriptor } from './adapters/types';

const LEVELS = new Set(['L0', 'L1', 'L2', 'L3']);
const INTENTS = new Set(['prompt', 'answer', 'interrupt', 'mode']);
const CHANNELS = new Set(['pty', 'native', 'none']);

export interface VerifyResult {
  kind: string;
  pass: boolean;
  problems: string[];
}

/**
 * acap-verify (ACAP spec §11 levels / conformance.md): static conformance check of every adapter
 * descriptor against the protocol — levels, capabilities, inject spec, hook
 * recipe shape. A new provider must pass this before it's listed.
 */
export function verifyAll(): VerifyResult[] {
  return ALL_ADAPTERS.map(verify);
}

export function verify(a: AdapterDescriptor): VerifyResult {
  const problems: string[] = [];
  if (!a.kind) problems.push('missing kind');
  if (!LEVELS.has(a.level)) problems.push(`bad level ${a.level}`);
  for (const c of a.capabilities) if (!INTENTS.has(c)) problems.push(`bad capability ${c}`);
  if (!CHANNELS.has(a.inject.channel)) problems.push(`bad inject channel ${a.inject.channel}`);
  if (!a.detectDir) problems.push('missing detectDir');

  // Capabilities must be reachable by the declared inject path.
  if (a.capabilities.length && a.inject.channel === 'none' && !a.inject.hookReturn) {
    problems.push('declares capabilities but has no inject channel or hook-return');
  }
  // Level ↔ capability consistency (spec §11 table). The Commander enforces this
  // on register — declaring more than the level allows fails with 400
  // invalid_register, so these are the upper bounds, not just lower ones.
  if (a.level === 'L0' && a.capabilities.length) {
    problems.push('L0 (Observer) must declare no capabilities');
  }
  if (a.level === 'L1' &&
      !(a.capabilities.length === 1 && a.capabilities[0] === 'prompt')) {
    problems.push('L1 (Promptable) capabilities must be exactly ["prompt"]');
  }
  // L1+ must accept prompt; L2+ must accept answer or interrupt.
  if (a.level !== 'L0' && !a.capabilities.includes('prompt')) {
    problems.push(`${a.level} should accept "prompt"`);
  }
  if ((a.level === 'L2' || a.level === 'L3') &&
      !a.capabilities.some((c) => c === 'answer' || c === 'interrupt')) {
    problems.push(`${a.level} should accept "answer" or "interrupt"`);
  }
  // Hook recipe sanity.
  if (a.hooks) {
    if (!a.hooks.configPath) problems.push('hooks.configPath missing');
    if (!Object.keys(a.hooks.events).length) problems.push('hooks.events empty');
  }
  if (!a.hooks && !a.poll && a.level !== 'L0') {
    problems.push(`${a.level} has neither hooks nor poll (only process-fallback) — expected L0`);
  }
  return { kind: a.kind, pass: problems.length === 0, problems };
}
