import fs from 'fs';
import { AdapterDescriptor } from './types';
import claudeCode from './claude-code';
import codex from './codex';
import cursor from './cursor';
import gemini from './gemini';
import openclaw from './openclaw';
import hermes from './hermes';

/** All known adapters. Add a provider → import its descriptor and list it here. */
export const ALL_ADAPTERS: AdapterDescriptor[] = [
  claudeCode, codex, cursor, gemini, openclaw, hermes,
];

export function byKind(kind: string): AdapterDescriptor | undefined {
  return ALL_ADAPTERS.find((a) => a.kind === kind);
}

/** Adapters whose agent is actually installed on this machine. */
export function detected(): AdapterDescriptor[] {
  return ALL_ADAPTERS.filter((a) => dirExists(a.detectDir));
}

/** Kinds that need the process-fallback layer (no hooks, no poller). */
export function fallbackKinds(adapters: AdapterDescriptor[]): string[] {
  return adapters.filter((a) => !a.hooks && !a.poll).map((a) => a.kind);
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
