import { Capability, CanonicalEvent, Level } from '../protocol';
import { InjectSpec } from '../injector';

/**
 * One descriptor per agent kind. Adding a provider = drop a folder with a
 * manifest.json + a descriptor like these (design.html §08 "one folder").
 */
export interface AdapterDescriptor {
  kind: string;
  level: Level;
  capabilities: Capability[];
  provides: string[];
  inject: InjectSpec;
  /** Absolute dir whose existence means this agent is installed on the machine. */
  detectDir: string;
  /** How to wire this agent's native hooks to our universal hook script. */
  hooks?: HookRecipe;
  /**
   * Agents without a hook system (e.g. openclaw) provide a poller instead.
   * Returns a stop() function. `emit` feeds normalized events into the hub.
   */
  poll?: (emit: (ev: import('../protocol').HookEvent) => void) => () => void;
}

/** Config formats the installer knows how to merge a hook into. */
export type HookFormat = 'claude' | 'codex' | 'cursor';

export interface HookRecipe {
  /** Agent's hook config file we merge into. */
  configPath: string;
  format: HookFormat;
  /** native event name → our canonical event; one hook entry registered per pair. */
  events: Partial<Record<string, CanonicalEvent>>;
}

export type { InjectSpec, CanonicalEvent, Level, Capability };
