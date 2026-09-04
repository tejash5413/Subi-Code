import type { AgentMode } from './AgentMode';
import type { SubiAccessMode } from '../types';

/**
 * Phase 10B.1: memory-only agent session state.
 *
 * No persistence. No globalState. Cleared when the session ends.
 * The webview never sees the transcript; it sees ToolActivityProjection and
 * a final answer (via UI events). The transcript is internal to AgentLoop.
 */
export interface AgentSession {
  sessionId: string;
  requestId: number;
  accessMode: SubiAccessMode | null;
  agentMode: AgentMode;
  provider: string | null;
  model: string | null;
  startedAt: number;
  visibleUserRequest: string;
  /**
   * Internal provider-neutral transcript. Only the final assistant text is
   * surfaced as a visible user/assistant message; the rest is opaque.
   */
  transcript: AgentTranscriptEntry[];
  /** Recent host-side tool activity (bounded, mirrored in RecentToolActivity). */
  toolActivity: AgentToolActivityEntry[];
  usage: AgentUsageSnapshot;
  turnCount: number;
  toolCallCount: number;
  finalAnswer?: string;
}

export type AgentTranscriptEntry =
  | { kind: 'system';          content: string }
  | { kind: 'user';            content: string }
  | { kind: 'assistantText';   content: string }
  | {
      kind: 'assistantToolCalls';
      text: string;
      toolCalls: AgentTranscriptToolCall[];
    }
  | {
      kind: 'toolResult';
      callId: string;
      toolName: string;
      content: string;
      isError: boolean;
    };

export interface AgentTranscriptToolCall {
  callId: string;
  providerCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface AgentToolActivityEntry {
  callId: string;
  toolName: string;
  ok: boolean;
  durationMs: number;
  /** Host-side tool result payload (opaque, NOT surfaced to webview). */
  resultPayload: unknown;
  errorCode?: string;
  errorMessage?: string;
}

export interface AgentUsageSnapshot {
  modelCalls: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentSessionInput {
  sessionId: string;
  requestId: number;
  accessMode: SubiAccessMode | null;
  agentMode: AgentMode;
  provider: string | null;
  model: string | null;
  visibleUserRequest: string;
}

export function createAgentSession(input: AgentSessionInput): AgentSession {
  return {
    sessionId: input.sessionId,
    requestId: input.requestId,
    accessMode: input.accessMode,
    agentMode: input.agentMode,
    provider: input.provider,
    model: input.model,
    startedAt: Date.now(),
    visibleUserRequest: input.visibleUserRequest,
    transcript: [],
    toolActivity: [],
    usage: { modelCalls: 0 },
    turnCount: 0,
    toolCallCount: 0,
  };
}

/** Opaque re-export to avoid duplicating the AgentMode type. */
export type { AgentMode };
