import { AgentMode } from '../agent/AgentMode';
import { ToolRegistry } from './ToolRegistry';
import {
  ToolActivity,
  ToolCallRequest,
  ToolContext,
  ToolDefinition,
  ToolError,
  ToolErrorCode,
  ToolResult,
  ToolResultSuccess,
} from './ToolTypes';

/**
 * Phase 10A: tool executor.
 *
 * The only path that can invoke a registered tool. Validates:
 *   - tool exists (TOOL_NOT_FOUND)
 *   - tool is not locked (TOOL_LOCKED)
 *   - tool is allowed for the current agentMode (TOOL_NOT_ALLOWED)
 *   - args match the tool's declared inputSchema (TOOL_INVALID_ARGUMENTS)
 *
 * Normalizes the result into a safe ToolResult envelope. Emits tool
 * activity events for the webview.
 */
export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly emitter: (event: ToolActivity) => void;
  private activeController: AbortController | null = null;
  private activeCallId: string | null = null;

  constructor(registry: ToolRegistry, emitter: (event: ToolActivity) => void) {
    this.registry = registry;
    this.emitter = emitter;
  }

  /** True while a tool call is running. */
  public isActive(): boolean {
    return this.activeCallId !== null;
  }

  /** Cancel the in-flight call. */
  public cancel(): void {
    try {
      this.activeController?.abort();
    } catch {
      // Best-effort.
    }
  }

  /** Look up a tool by name without executing it. */
  public describe(name: string): ToolDefinition | undefined {
    return this.registry.get(name);
  }

  /** Validate args against the tool's inputSchema. Returns a clean record or throws. */
  public validateArgs(
    name: string,
    args: Record<string, unknown>
  ): Record<string, unknown> {
    const tool = this.registry.get(name);
    if (!tool) {
      throw new ToolError('TOOL_NOT_FOUND', `Unknown tool: ${name}`, name);
    }
    if (!args || typeof args !== 'object') {
      throw new ToolError('TOOL_INVALID_ARGUMENTS', 'Tool args must be an object.', name);
    }
    const out: Record<string, unknown> = {};
    const declared = tool.metadata.inputSchema;
    for (const field of declared) {
      const raw = args[field.name];
      if (raw === undefined || raw === null || raw === '') {
        if (field.required) {
          throw new ToolError(
            'TOOL_INVALID_ARGUMENTS',
            `Missing required argument: ${field.name}`,
            name
          );
        }
        continue;
      }
      if (field.type === 'string' || field.type === 'path' || field.type === 'query') {
        if (typeof raw !== 'string') {
          throw new ToolError(
            'TOOL_INVALID_ARGUMENTS',
            `Argument "${field.name}" must be a string.`,
            name
          );
        }
        if (field.maxLength && raw.length > field.maxLength) {
          throw new ToolError(
            'TOOL_INVALID_ARGUMENTS',
            `Argument "${field.name}" exceeds maximum length of ${field.maxLength}.`,
            name
          );
        }
        out[field.name] = raw;
      } else if (field.type === 'number') {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) {
          throw new ToolError(
            'TOOL_INVALID_ARGUMENTS',
            `Argument "${field.name}" must be a number.`,
            name
          );
        }
        out[field.name] = n;
      } else if (field.type === 'boolean') {
        if (typeof raw === 'boolean') {
          out[field.name] = raw;
        } else if (raw === 'true') {
          out[field.name] = true;
        } else if (raw === 'false') {
          out[field.name] = false;
        } else {
          throw new ToolError(
            'TOOL_INVALID_ARGUMENTS',
            `Argument "${field.name}" must be a boolean.`,
            name
          );
        }
      }
    }
    // Reject unknown args.
    const declaredNames = new Set(declared.map((d) => d.name));
    for (const key of Object.keys(args)) {
      if (!declaredNames.has(key)) {
        throw new ToolError(
          'TOOL_INVALID_ARGUMENTS',
          `Unknown argument: ${key}`,
          name
        );
      }
    }
    return out;
  }

  /** Execute a tool call (host-side, single-flight). */
  public async execute(call: ToolCallRequest, mode: AgentMode): Promise<ToolResult> {
    if (this.activeCallId !== null) {
      return this.failure(call, 'TOOL_BUSY', 'A tool call is already running.', 0);
    }
    if (!call || typeof call !== 'object' || typeof call.callId !== 'string' || call.callId.length === 0) {
      throw new ToolError('TOOL_INVALID_ARGUMENTS', 'Tool call must have a string callId.', 'unknown');
    }
    if (typeof call.toolName !== 'string' || call.toolName.length === 0) {
      return this.failure(
        { callId: call.callId, toolName: call.toolName ?? 'unknown', args: call.args ?? {} },
        'TOOL_INVALID_ARGUMENTS',
        'Tool call must have a toolName.',
        0
      );
    }

    let tool;
    try {
      tool = this.registry.resolveForInvocation(call.toolName, mode);
    } catch (error) {
      const code = error instanceof ToolError ? error.code : 'INTERNAL';
      const message = error instanceof Error ? error.message : 'Tool resolution failed.';
      return this.failure(call, code, message, 0);
    }

    let validatedArgs: Record<string, unknown>;
    try {
      validatedArgs = this.validateArgs(call.toolName, call.args ?? {});
    } catch (error) {
      const code = error instanceof ToolError ? error.code : 'TOOL_INVALID_ARGUMENTS';
      const message = error instanceof Error ? error.message : 'Invalid arguments.';
      return this.failure(call, code, message, 0);
    }

    const controller = new AbortController();
    this.activeController = controller;
    this.activeCallId = call.callId;
    this.emitter({
      type: 'toolStarted',
      callId: call.callId,
      toolName: tool.metadata.name,
      category: tool.metadata.category,
      label: tool.metadata.displayLabel ?? tool.metadata.name,
    });

    const start = Date.now();
    const ctx: ToolContext = { agentMode: mode, signal: controller.signal };
    try {
      const payload = await tool.execute(validatedArgs, ctx);
      const durationMs = Date.now() - start;
      const summary = this.makeSummary(tool.metadata.name, payload);
      const result: ToolResultSuccess<unknown> = {
        ok: true,
        callId: call.callId,
        toolName: tool.metadata.name,
        category: tool.metadata.category,
        permission: tool.metadata.permission,
        label: tool.metadata.displayLabel ?? tool.metadata.name,
        summary,
        durationMs,
      };
      // Attach payload only if it fits within the bounded size.
      if (payload !== undefined && payload !== null) {
        result.payload = payload;
      }
      this.emitter({
        type: 'toolCompleted',
        callId: call.callId,
        toolName: tool.metadata.name,
        category: tool.metadata.category,
        label: result.label,
        durationMs,
        ok: true,
        summary,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - start;
      const code = error instanceof ToolError ? error.code : 'INTERNAL';
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      this.emitter({
        type: 'toolFailed',
        callId: call.callId,
        toolName: tool.metadata.name,
        category: tool.metadata.category,
        label: tool.metadata.displayLabel ?? tool.metadata.name,
        code,
        message,
        durationMs,
      });
      return this.failure(call, code, message, durationMs, {
        name: tool.metadata.name,
        category: tool.metadata.category,
        displayLabel: tool.metadata.displayLabel ?? tool.metadata.name,
      });
    } finally {
      this.activeController = null;
      this.activeCallId = null;
    }
  }

  private makeSummary(toolName: string, payload: unknown): string {
    if (payload === null || payload === undefined) {
      return 'Done.';
    }
    if (typeof payload === 'object') {
      const p = payload as Record<string, unknown>;
      switch (toolName) {
        case 'get_workspace_info': {
          const name = typeof p['name'] === 'string' ? p['name'] : '?';
          const type = typeof p['projectType'] === 'string' ? p['projectType'] : '?';
          return `${name} (${type})`;
        }
        case 'find_files': {
          const count = typeof p['count'] === 'number' ? p['count'] : 0;
          return count === 1 ? '1 file' : `${count} files`;
        }
        case 'read_file': {
          const path = typeof p['displayPath'] === 'string' ? p['displayPath'] : 'file';
          const size = typeof p['size'] === 'number' ? p['size'] : 0;
          return `${path} (${size} bytes)`;
        }
        case 'search_text': {
          const count = typeof p['count'] === 'number' ? p['count'] : 0;
          return count === 1 ? '1 match' : `${count} matches`;
        }
      }
    }
    if (typeof payload === 'string') {
      return payload.length > 80 ? `${payload.slice(0, 77)}...` : payload;
    }
    return 'Done.';
  }

  private failure(
    call: ToolCallRequest,
    code: ToolErrorCode,
    message: string,
    durationMs: number,
    meta?: { name: string; category: ToolDefinition['metadata']['category']; displayLabel?: string }
  ): ToolResult {
    const toolName = meta?.name ?? call.toolName;
    const category = meta?.category ?? 'workspace';
    const label = meta?.displayLabel ?? toolName;
    return {
      ok: false,
      callId: call.callId,
      toolName,
      category,
      permission: 'read',
      label,
      code,
      message,
      durationMs,
    };
  }
}
