/**
 * Phase 10A: AgentMode (separate from accessMode).
 *
 * accessMode:   who provides / pays for AI  (learnsmart | byok | free)
 * agentMode:    what coding actions SUBI may perform (ask | plan | build)
 *
 * The two are independent axes. This file defines only the latter.
 * Phase 10A ships ASK and PLAN as read-only; BUILD is reserved but locked.
 */

export type AgentMode = 'ask' | 'plan' | 'build';

const VALID_AGENT_MODES: ReadonlySet<AgentMode> = new Set<AgentMode>(['ask', 'plan', 'build']);

export const DEFAULT_AGENT_MODE: AgentMode = 'ask';

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === 'string' && VALID_AGENT_MODES.has(value as AgentMode);
}

export function asAgentMode(value: unknown): AgentMode | undefined {
  return isAgentMode(value) ? value : undefined;
}

/** Human label for an agent mode (Phase 10A BUILD is locked). */
export function describeAgentMode(mode: AgentMode): { label: string; available: boolean; note: string } {
  switch (mode) {
    case 'ask':
      return { label: 'ASK', available: true, note: 'Read-only questions and inspection.' };
    case 'plan':
      return { label: 'PLAN', available: true, note: 'Read-only plan generation (no writes yet).' };
    case 'build':
      return { label: 'BUILD', available: false, note: 'Locked. Available after safe write/patch support lands.' };
  }
}
