/**
 * Phase 10B.1: centralized agent-loop limits.
 *
 * All values are read-only exports; no magic numbers inside AgentLoop.
 * Tests verify the exact values.
 */
export const AGENT_LIMITS = {
  /** Maximum number of model invocations (turns) per agent request. */
  MAX_AGENT_TURNS: 8,
  /** Maximum total number of tool calls accepted across the agent request. */
  MAX_TOOL_CALLS: 16,
  /** Maximum tool calls accepted in a single model turn. */
  MAX_TOOL_CALLS_PER_TURN: 4,
  /** Maximum consecutive tool failures before stopping. */
  MAX_CONSECUTIVE_TOOL_ERRORS: 3,
  /**
   * Maximum executions of the same exact tool+args fingerprint per session.
   * 1st executes + caches, 2nd reuses cache, 3rd returns repeated-call error
   * (and the loop may continue if the model self-corrects).
   */
  MAX_IDENTICAL_TOOL_CALL_EXECUTIONS: 1,
  /** Hard cap on the entire agent request duration. */
  MAX_AGENT_DURATION_MS: 300_000,
  /** Soft cap on transcript content size. */
  MAX_AGENT_TRANSCRIPT_CHARS: 200_000,
  /** Per-tool-result model-facing content bound. */
  MAX_TOOL_RESULT_MODEL_CHARS: 50_000,
  /** Per-agent-request cache entries. */
  AGENT_CACHE_MAX_ENTRIES: 32,
} as const;
