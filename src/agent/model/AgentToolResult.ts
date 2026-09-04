import type { ToolResult } from '../../tools/ToolTypes';

/**
 * Phase 10B.1: canonical host result envelope produced by SUBI after a tool
 * runs through ToolExecutor. The model NEVER supplies a tool result; the
 * gateway's job is to translate AgentToolResult -> provider-native tool-result
 * message for the next model turn.
 */
import type { AgentModelToolCall } from './AgentModelTypes';
import type { AgentToolResult } from './AgentModelTypes';

export const TOOL_RESULT_BOUNDS = {
  /** Maximum size (in characters) of the model-facing content string. */
  maxModelChars: 50_000,
} as const;

/**
 * Truncate a string to the model-facing limit, appending a clear marker so
 * the model can self-correct. The original ToolResult is never mutated.
 */
export function boundToolResultForModel(
  content: string,
  maxChars: number = TOOL_RESULT_BOUNDS.maxModelChars
): string {
  if (content.length <= maxChars) {
    return content;
  }
  const truncated = content.slice(0, maxChars);
  return `${truncated}\n\n[Subi] Tool result truncated to ${maxChars} characters. Repeat the call with a more specific path/query to receive the rest.`;
}

/**
 * Build an AgentToolResult from a ToolResult + the originating tool call.
 * Deterministically clamps content size. The `args` from the call are
 * intentionally not echoed (the model already knows them).
 */
export function toAgentToolResult(
  call: AgentModelToolCall,
  result: ToolResult
): AgentToolResult {
  if (result.ok) {
    // Compact JSON of the payload, bounded.
    const serialized = serializePayloadForModel(result.payload);
    return {
      subiCallId: call.subiCallId,
      toolName: result.toolName,
      ok: true,
      content: boundToolResultForModel(serialized),
      durationMs: result.durationMs,
    };
  }
  // Failure: include code + message, bounded.
  const errContent = `TOOL_ERROR ${result.code}: ${result.message}`;
  return {
    subiCallId: call.subiCallId,
    toolName: result.toolName,
    ok: false,
    content: boundToolResultForModel(errContent),
    errorCode: result.code,
    errorMessage: result.message,
    durationMs: result.durationMs,
  };
}

function serializePayloadForModel(payload: unknown): string {
  if (payload === undefined) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload, (_key, value) => {
      if (typeof value === 'bigint') {
        return value.toString();
      }
      if (value instanceof Uint8Array) {
        return `<bytes:${value.length}>`;
      }
      return value;
    });
  } catch {
    return '[Subi] Tool result not serializable for model.';
  }
}

/**
 * Build an AgentToolResult for a tool-error that did not actually execute
 * (e.g. unknown tool, invalid args, repeated call). Used by AgentLoop to
 * synthesize a tool result without running the tool.
 */
export function synthesizeAgentToolError(
  call: AgentModelToolCall,
  errorCode: string,
  errorMessage: string
): AgentToolResult {
  return {
    subiCallId: call.subiCallId,
    toolName: call.toolName,
    ok: false,
    content: boundToolResultForModel(`TOOL_ERROR ${errorCode}: ${errorMessage}`),
    errorCode,
    errorMessage,
  };
}
