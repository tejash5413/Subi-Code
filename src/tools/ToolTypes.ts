import type { AgentMode } from '../agent/AgentMode';

/**
 * Phase 10A: provider-independent tool types.
 *
 * Tools know nothing about AI providers, model APIs, or chat streaming.
 * Providers know nothing about tools. The agent runtime (Phase 10B) will
 * be the only glue between them.
 *
 * Phase 10A only ships READ-permission tools. The permission union is
 * forward-declared (write/execute/dangerous) so the surface area does not
 * need to change in later phases.
 */

export type ToolPermission = 'read' | 'write' | 'execute' | 'dangerous';

export type ToolCategory =
  | 'workspace'
  | 'files'
  | 'search'
  | 'edit'
  | 'terminal'
  | 'git'
  | 'diagnostics'
  | 'tests';

/** Static tool metadata (safe to send to the webview). */
export interface ToolMetadata {
  name: string;
  description: string;
  category: ToolCategory;
  permission: ToolPermission;
  /** Per-mode availability, in addition to the host runtime gate. */
  availableInModes: ReadonlyArray<AgentMode>;
  /** Stable, vscode-free argument shape. Validated host-side. */
  inputSchema: ToolInputField[];
  /** Optional, stable display label (e.g., for cards). */
  displayLabel?: string;
  /** When true, the tool is visible but not callable (BUILD today). */
  locked: boolean;
  /** Human-readable reason the tool is locked. */
  lockedReason?: string;
}

export interface ToolInputField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'path' | 'query';
  required: boolean;
  description: string;
  /** Max character length (for strings/queries/paths). */
  maxLength?: number;
}

/** Tool call envelope (webview → host). The webview never executes. */
export interface ToolCallRequest {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/** Tool result envelope (host → webview). Never includes secrets. */
export interface ToolResultSuccess<TPayload> {
  ok: true;
  callId: string;
  toolName: string;
  category: ToolCategory;
  permission: ToolPermission;
  label: string;
  /** Compact summary (always shown). */
  summary: string;
  /** Optional expanded payload (only when expanded). Bounded. */
  payload?: TPayload;
  durationMs: number;
}

export interface ToolResultFailure {
  ok: false;
  callId: string;
  toolName: string;
  category: ToolCategory;
  permission: ToolPermission;
  label: string;
  code: ToolErrorCode;
  message: string;
  durationMs: number;
}

export type ToolResult<TPayload = unknown> = ToolResultSuccess<TPayload> | ToolResultFailure;

/** Tool activity events posted to the webview for tool cards. */
export type ToolActivity =
  | { type: 'toolStarted'; callId: string; toolName: string; category: ToolCategory; label: string }
  | { type: 'toolCompleted'; callId: string; toolName: string; category: ToolCategory; label: string; durationMs: number; ok: boolean; code?: ToolErrorCode; message?: string; summary: string }
  | { type: 'toolFailed'; callId: string; toolName: string; category: ToolCategory; label: string; code: ToolErrorCode; message: string; durationMs: number };

/** Stable, provider-independent error codes (see ToolError class). */
export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_LOCKED'
  | 'TOOL_INVALID_ARGUMENTS'
  | 'TOOL_BUSY'
  | 'WORKSPACE_NOT_OPEN'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'BINARY_FILE'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'SECRET_FILE_BLOCKED'
  | 'SEARCH_LIMIT_REACHED'
  | 'ABORTED'
  | 'INTERNAL';

export class ToolError extends Error {
  public readonly code: ToolErrorCode;
  public readonly toolName: string;
  constructor(code: ToolErrorCode, message: string, toolName: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.toolName = toolName;
  }
}

/** Tool definition interface. */
export interface ToolDefinition<TArgs = Record<string, unknown>, TOutput = unknown> {
  readonly metadata: ToolMetadata;
  /** Run with already-validated args. Throws ToolError on failure. */
  execute(args: TArgs, ctx: ToolContext): Promise<TOutput>;
}

/** Per-call context provided by the executor. */
export interface ToolContext {
  /** Mode filter (the webview may only invoke tools available in this mode). */
  agentMode: AgentMode;
  /** Caller-supplied signal. */
  signal?: AbortSignal;
}
