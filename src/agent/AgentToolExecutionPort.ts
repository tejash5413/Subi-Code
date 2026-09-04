import { ToolErrorCode, ToolResult } from '../tools/ToolTypes';

/**
 * Phase 10B.1: narrow port that the AgentLoop uses to invoke tools. The
 * production implementation delegates directly to ToolExecutor (which
 * remains the only execution authority). Tests implement this port with a
 * fake so AgentLoop stays vscode-free and deterministic.
 *
 * This is NOT a second tool executor. The host ToolExecutor is the single
 * tool policy and execution boundary.
 */
export interface AgentToolExecutionRequest {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface AgentToolExecutionPort {
  execute(request: AgentToolExecutionRequest, signal: AbortSignal): Promise<ToolResult>;
}

/** Adapter that wires the production ToolExecutor to the agent port. */
export class ToolExecutorAgentPort implements AgentToolExecutionPort {
  constructor(
    private readonly executor: AgentToolExecutorHost
  ) {}

  public async execute(
    request: AgentToolExecutionRequest,
    _signal: AbortSignal
  ): Promise<ToolResult> {
    // The ToolExecutor already checks signal internally via its own
    // AbortController; the agent port is a thin pass-through.
    return this.executor.runTool({
      callId: request.callId,
      toolName: request.toolName,
      args: request.args,
    });
  }
}

/** Minimum surface of ToolExecutor that the agent port needs. */
export interface AgentToolExecutorHost {
  runTool(call: { callId: string; toolName: string; args: Record<string, unknown> }): Promise<ToolResult>;
}

/** Maps ToolErrorCode into the canonical agent error namespace. */
export const CANONICAL_TOOL_ERRORS: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'TOOL_NOT_FOUND',
  'TOOL_NOT_ALLOWED',
  'TOOL_LOCKED',
  'TOOL_INVALID_ARGUMENTS',
  'TOOL_BUSY',
  'WORKSPACE_NOT_OPEN',
  'FILE_NOT_FOUND',
  'FILE_TOO_LARGE',
  'BINARY_FILE',
  'PATH_OUTSIDE_WORKSPACE',
  'SECRET_FILE_BLOCKED',
  'SEARCH_LIMIT_REACHED',
  'ABORTED',
  'INTERNAL',
]);
