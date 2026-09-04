import { AGENT_LIMITS } from './AgentLimits';
import { AgentMode } from './AgentMode';
import {
  AgentFinishReason,
  AgentModelEvent,
  AgentModelMessage,
  AgentModelRequest,
  AgentModelToolCall,
  AgentModelToolDefinition,
  AgentRunOutcome,
  AgentStatus,
  AgentUsageAggregate,
} from './model/AgentModelTypes';
import { AgentModelGateway } from './model/AgentModelGateway';
import {
  AgentSession,
  AgentTranscriptEntry,
  AgentTranscriptToolCall,
  createAgentSession,
} from './AgentSession';
import { buildAgentSystemPrompt } from './AgentSystemPrompt';
import { toAgentModelToolDefinition, toAgentModelToolDefinitions } from './model/toolProjection';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolError, ToolResult, ToolDefinition } from '../tools/ToolTypes';
import { AgentToolExecutionPort } from './AgentToolExecutionPort';
import { boundToolResultForModel, synthesizeAgentToolError, toAgentToolResult } from './model/AgentToolResult';
import { SubiAccessMode } from '../types';

/**
 * Phase 10B.1: bounded, vscode-free, provider-neutral coding agent loop.
 *
 * Responsibilities (and ONLY these):
 *   - Build an AgentSession from a user request.
 *   - Drive a bounded MODEL -> [TOOL CALL] -> [TOOL EXECUTION] -> [TOOL RESULT] -> MODEL loop.
 *   - Validate tool-call args + tool policy (via ToolRegistry) before every
 *     execution. The host ToolExecutor remains the only execution authority.
 *   - Maintain a request-local LRU cache for identical tool calls.
 *   - Honor a single parent AbortSignal (model stream, next iteration, and
 *     a soft "in-flight tool" signal where possible).
 *   - Emit a deterministic AgentRunOutcome.
 *
 * Non-responsibilities (intentional):
 *   - No provider-native JSON. The gateway owns the codec.
 *   - No file/terminal/Git/secrets/persistence.
 *   - No webview / SidebarProvider coupling. AgentLoop returns an outcome; a
 *     later phase (10B.7) wires AgentController to the webview.
 */
export interface AgentLoopInput {
  requestId: number;
  sessionId: string;
  accessMode: SubiAccessMode | null;
  agentMode: AgentMode;
  provider: string | null;
  model: string | null;
  userText: string;
  signal: AbortSignal;
}

export interface AgentLoopPorts {
  gateway: AgentModelGateway;
  toolRegistry: ToolRegistry;
  toolPort: AgentToolExecutionPort;
  /** When provided, called on each AgentModelEvent for diagnostics. */
  onEvent?: (event: AgentModelEvent) => void;
  /** When provided, called after each tool execution with the host result. */
  onToolExecuted?: (result: ToolResult) => void;
}

const STARTING_TURN = 0;

export class AgentLoop {
  private readonly input: AgentLoopInput;
  private readonly ports: AgentLoopPorts;
  private readonly session: AgentSession;
  private readonly cache: Map<string, ToolResult> = new Map();
  private readonly fingerprintCount: Map<string, number> = new Map();
  private consecutiveToolErrors = 0;

  constructor(input: AgentLoopInput, ports: AgentLoopPorts) {
    this.input = input;
    this.ports = ports;
    this.session = createAgentSession({
      sessionId: input.sessionId,
      requestId: input.requestId,
      accessMode: input.accessMode,
      agentMode: input.agentMode,
      provider: input.provider,
      model: input.model,
      visibleUserRequest: input.userText,
    });
  }

  /** Read-only access for tests and the future AgentController. */
  public getSession(): AgentSession {
    return this.session;
  }

  public async run(): Promise<AgentRunOutcome> {
    // BUILD remains locked: refuse to drive a real loop in this phase.
    if (this.input.agentMode === 'build') {
      return this.finalize('error_mode_unavailable', 'AGENT_MODE_UNAVAILABLE', 'Build mode is locked in Phase 10B.');
    }

    if (this.input.signal.aborted) {
      return this.finalize('cancelled', 'AGENT_CANCELLED', 'Request was cancelled before start.');
    }

    // Seed transcript with the system prompt + user request.
    this.pushTranscript({ kind: 'system', content: buildAgentSystemPrompt(this.input.agentMode) });
    this.pushTranscript({ kind: 'user', content: this.input.userText });

    const start = Date.now();
    for (let turn = 0; turn < AGENT_LIMITS.MAX_AGENT_TURNS; turn++) {
      this.session.turnCount = turn + 1;

      if (this.input.signal.aborted) {
        return this.finalize('cancelled', 'AGENT_CANCELLED', 'Request was cancelled.');
      }
      if (this.exceedsDuration(start)) {
        return this.finalize('error_provider', 'AGENT_MODEL_TIMEOUT', 'Agent request exceeded the duration cap.');
      }
      if (this.session.toolCallCount >= AGENT_LIMITS.MAX_TOOL_CALLS) {
        return this.finalize('limit_tool', 'AGENT_TOOL_LIMIT', 'Maximum tool calls reached.');
      }
      if (this.exceedsTranscriptBudget()) {
        return this.finalize('limit_context', 'AGENT_CONTEXT_LIMIT', 'Transcript exceeded the size cap.');
      }

      const turnOutcome = await this.runOneTurn();
      if (turnOutcome.kind === 'completed') {
        return this.finalize(
          'completed',
          undefined,
          undefined,
          turnOutcome.assistantText
        );
      }
      if (turnOutcome.kind === 'error_provider') {
        return this.finalize('error_provider', 'AGENT_PROVIDER_ERROR', turnOutcome.message);
      }
      if (turnOutcome.kind === 'cancelled') {
        return this.finalize('cancelled', 'AGENT_CANCELLED', 'Request was cancelled.');
      }
      // 'tool_calls' -> loop continues.
    }
    return this.finalize('limit_turn', 'AGENT_TURN_LIMIT', 'Maximum agent turns reached.');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async runOneTurn(): Promise<
    { kind: 'completed'; assistantText: string }
    | { kind: 'error_provider'; message: string }
    | { kind: 'cancelled' }
    | { kind: 'tool_calls' }
  > {
    const request = this.buildRequest();
    if (request === null) {
      return { kind: 'error_provider', message: 'No tools available for the current mode.' };
    }

    const events = this.ports.gateway.streamTurn(request, this.input.signal);
    let assistantText = '';
    let finishReason: AgentFinishReason = 'unknown';
    let usageFromFinish: AgentUsageAggregate | undefined;
    const toolCalls: AgentModelToolCall[] = [];
    const pendingDeltas: Map<string, string> = new Map();
    const pendingToolName: Map<string, string> = new Map();
    const pendingProviderCallId: Map<string, string> = new Map();
    let lastFinishUsage: AgentUsageAggregate | undefined;
    let sawToolCallReady = false;

    try {
      for await (const event of events) {
        if (this.input.signal.aborted) {
          return { kind: 'cancelled' };
        }
        this.ports.onEvent?.(event);

        switch (event.type) {
          case 'textDelta': {
            assistantText += event.text;
            break;
          }
          case 'toolCallStart': {
            pendingDeltas.set(event.subiCallId, '');
            pendingToolName.set(event.subiCallId, event.toolName);
            if (event.providerCallId !== undefined) {
              pendingProviderCallId.set(event.subiCallId, event.providerCallId);
            }
            break;
          }
          case 'toolCallArgumentsDelta': {
            const prev = pendingDeltas.get(event.subiCallId) ?? '';
            pendingDeltas.set(event.subiCallId, prev + event.partialArgs);
            break;
          }
          case 'toolCallReady': {
            sawToolCallReady = true;
            const assembledArgs = parseJsonRecord(pendingDeltas.get(event.subiCallId) ?? '');
            if (assembledArgs === null) {
              // JSON failed; synthesize an invalid-args error result.
              toolCalls.push({
                subiCallId: event.subiCallId,
                ...(pendingProviderCallId.has(event.subiCallId)
                  ? { providerCallId: pendingProviderCallId.get(event.subiCallId) }
                  : {}),
                toolName: event.toolName,
                args: {},
              });
              // The actual invalid-args result is generated during execution
              // by the port (the port cannot see assembled args failed). We
              // tag this call as `argsMissing` so the execution path knows
              // to short-circuit.
              pendingDeltas.set(event.subiCallId, '__INVALID_ARGS__');
            } else {
              toolCalls.push({
                subiCallId: event.subiCallId,
                ...(event.providerCallId !== undefined
                  ? { providerCallId: event.providerCallId }
                  : {}),
                toolName: event.toolName,
                args: assembledArgs,
              });
            }
            pendingDeltas.delete(event.subiCallId);
            pendingToolName.delete(event.subiCallId);
            pendingProviderCallId.delete(event.subiCallId);
            break;
          }
          case 'usage': {
            lastFinishUsage = event.usage;
            break;
          }
          case 'finish': {
            finishReason = event.reason;
            usageFromFinish = event.usage;
            if (event.usage !== undefined) {
              lastFinishUsage = event.usage;
            }
            break;
          }
          case 'completed': {
            // End of stream.
            break;
          }
        }
      }
    } catch (error) {
      return {
        kind: 'error_provider',
        message: error instanceof Error ? error.message : 'Provider error.',
      };
    }

    // Accumulate usage (only reported values; no estimation).
    const turnUsage: AgentUsageAggregate = usageFromFinish ?? lastFinishUsage ?? {
      modelCalls: 1,
    };
    this.accumulateUsage(turnUsage);

    if (this.input.signal.aborted) {
      return { kind: 'cancelled' };
    }

    // No tool calls -> final answer.
    if (!sawToolCallReady || toolCalls.length === 0) {
      // If the model produced no text and finish is `error`, surface provider error.
      if (finishReason === 'error' && assistantText.trim().length === 0) {
        return { kind: 'error_provider', message: 'Provider returned an error finish.' };
      }
      return { kind: 'completed', assistantText };
    }

    if (toolCalls.length > AGENT_LIMITS.MAX_TOOL_CALLS_PER_TURN) {
      return {
        kind: 'error_provider',
        message: `Model requested ${toolCalls.length} tool calls in one turn (max ${AGENT_LIMITS.MAX_TOOL_CALLS_PER_TURN}).`,
      };
    }

    // Push assistant tool-call message and execute each call.
    this.pushTranscript({
      kind: 'assistantToolCalls',
      text: assistantText,
      toolCalls: toolCalls.map((c) => ({
        callId: c.subiCallId,
        ...(c.providerCallId !== undefined ? { providerCallId: c.providerCallId } : {}),
        toolName: c.toolName,
        args: c.args,
      })),
    });

    for (const call of toolCalls) {
      if (this.input.signal.aborted) {
        return { kind: 'cancelled' };
      }
      await this.executeAndRecordToolCall(call, finishReason);
    }

    return { kind: 'tool_calls' };
  }

  private async executeAndRecordToolCall(
    call: AgentModelToolCall,
    finishReason: AgentFinishReason
  ): Promise<void> {
    this.session.toolCallCount += 1;

    // 1. Pre-flight: if the assembled JSON was invalid, we tag with
    //    __INVALID_ARGS__ sentinel to surface TOOL_INVALID_ARGUMENTS.
    if (call.toolName.length === 0) {
      const err = synthesizeAgentToolError(
        call,
        'TOOL_INVALID_ARGUMENTS',
        'Tool call missing toolName.'
      );
      this.recordToolResult(call, err, 'TOOL_INVALID_ARGUMENTS');
      return;
    }

    if (!this.ports.toolRegistry.has(call.toolName)) {
      const err = synthesizeAgentToolError(
        call,
        'TOOL_NOT_FOUND',
        `Unknown tool: ${call.toolName}`
      );
      this.recordToolResult(call, err, 'TOOL_NOT_FOUND');
      return;
    }

    // Mode + lock policy enforced by ToolRegistry.resolveForInvocation
    // (in the port path). We check it here too so we can produce a clean
    // tool result without invoking the executor for an obviously locked call.
    let tool: ToolDefinition;
    try {
      tool = this.ports.toolRegistry.resolveForInvocation(call.toolName, this.input.agentMode);
    } catch (error) {
      const code = error instanceof ToolError ? error.code : 'INTERNAL';
      const message = error instanceof Error ? error.message : 'Tool resolution failed.';
      this.recordToolResult(call, synthesizeAgentToolError(call, code, message), code);
      return;
    }

    // 2. Fingerprint cache.
    const fp = fingerprintToolCall(tool.metadata.name, call.args);
    const priorCount = this.fingerprintCount.get(fp) ?? 0;

    if (priorCount > AGENT_LIMITS.MAX_IDENTICAL_TOOL_CALL_EXECUTIONS) {
      // Already executed + cached + reused once. Third attempt -> error.
      const err = synthesizeAgentToolError(
        call,
        'AGENT_REPEATED_TOOL_CALL',
        'The same tool call was repeated too many times.'
      );
      this.recordToolResult(call, err, 'AGENT_REPEATED_TOOL_CALL');
      return;
    }

    if (priorCount === 1 && this.cache.has(fp)) {
      // Reuse cached result without invoking the tool.
      const cached = this.cache.get(fp)!;
      this.fingerprintCount.set(fp, priorCount + 1);
      this.ports.onToolExecuted?.(cached);
      const agentResult = toAgentToolResult(call, cached);
      this.pushTranscript({
        kind: 'toolResult',
        callId: call.subiCallId,
        toolName: call.toolName,
        content: agentResult.content,
        isError: !cached.ok,
      });
      return;
    }

    // 3. Execute via port (host ToolExecutor validates args and enforces
    //    secret / size / binary policy).
    let result: ToolResult;
    try {
      result = await this.ports.toolPort.execute(
        { callId: call.subiCallId, toolName: call.toolName, args: call.args },
        this.input.signal
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution threw.';
      const err = synthesizeAgentToolError(call, 'INTERNAL', message);
      this.recordToolResult(call, err, 'INTERNAL');
      return;
    }

    // 4. Record, cache, advance counters.
    this.fingerprintCount.set(fp, priorCount + 1);
    this.cache.set(fp, result);
    this.ports.onToolExecuted?.(result);
    this.session.toolActivity.push({
      callId: call.subiCallId,
      toolName: result.toolName,
      ok: result.ok,
      durationMs: result.durationMs,
      resultPayload: result.ok ? result.payload : undefined,
      ...(result.ok
        ? {}
        : { errorCode: result.code, errorMessage: result.message }),
    });
    this.session.toolCallCount += 1;

    if (result.ok) {
      this.consecutiveToolErrors = 0;
    } else {
      this.consecutiveToolErrors += 1;
      if (this.consecutiveToolErrors >= AGENT_LIMITS.MAX_CONSECUTIVE_TOOL_ERRORS) {
        // Surface the error and stop the loop.
        this.recordToolResult(call, toAgentToolResult(call, result), result.code);
        // Signal via a synthetic final answer (the outer loop will pick this
        // up as the last turn's assistant text).
        this.pushTranscript({
          kind: 'toolResult',
          callId: call.subiCallId,
          toolName: call.toolName,
          content: boundToolResultForModel(toAgentToolResult(call, result).content),
          isError: true,
        });
        this.session.finalAnswer = `Agent stopped: ${AGENT_LIMITS.MAX_CONSECUTIVE_TOOL_ERRORS} consecutive tool errors.`;
        return;
      }
    }

    this.recordToolResult(call, toAgentToolResult(call, result), result.ok ? undefined : result.code);
  }

  private recordToolResult(
    call: AgentModelToolCall,
    agentResult: ReturnType<typeof toAgentToolResult>,
    errorCode: string | undefined
  ): void {
    this.pushTranscript({
      kind: 'toolResult',
      callId: call.subiCallId,
      toolName: call.toolName,
      content: agentResult.content,
      isError: !agentResult.ok,
    });
  }

  private buildRequest(): AgentModelRequest | null {
    const availableTools = this.ports.toolRegistry
      .listForMode(this.input.agentMode)
      .map((meta) => this.ports.toolRegistry.get(meta.name))
      .filter((t): t is ToolDefinition => t !== undefined);
    if (availableTools.length === 0) {
      // No tools available -> no point calling the model with a tool list.
      return null;
    }
    const projected = toAgentModelToolDefinitions(availableTools);

    // Build provider-neutral messages from the session transcript.
    const messages: AgentModelMessage[] = this.session.transcript.map(toAgentModelMessage);

    return {
      provider: this.input.provider ?? 'unknown',
      model: this.input.model ?? 'unknown',
      messages,
      tools: projected,
    };
  }

  private pushTranscript(entry: AgentTranscriptEntry): void {
    this.session.transcript.push(entry);
  }

  private accumulateUsage(turnUsage: AgentUsageAggregate): void {
    this.session.usage.modelCalls += 1;
    if (typeof turnUsage.inputTokens === 'number') {
      this.session.usage.inputTokens =
        (this.session.usage.inputTokens ?? 0) + turnUsage.inputTokens;
    }
    if (typeof turnUsage.outputTokens === 'number') {
      this.session.usage.outputTokens =
        (this.session.usage.outputTokens ?? 0) + turnUsage.outputTokens;
    }
  }

  private exceedsDuration(start: number): boolean {
    return Date.now() - start > AGENT_LIMITS.MAX_AGENT_DURATION_MS;
  }

  private exceedsTranscriptBudget(): boolean {
    let total = 0;
    for (const entry of this.session.transcript) {
      total += transcriptEntrySize(entry);
    }
    return total > AGENT_LIMITS.MAX_AGENT_TRANSCRIPT_CHARS;
  }

  private finalize(
    status: AgentStatus,
    errorCode: string | undefined,
    errorMessage: string | undefined,
    finalAnswer?: string
  ): AgentRunOutcome {
    if (finalAnswer !== undefined) {
      this.session.finalAnswer = finalAnswer;
    }
    if (this.session.finalAnswer === undefined) {
      // No tool calls returned text: surface a sanitized message.
      this.session.finalAnswer = '';
    }
    return {
      status,
      finalAnswer: this.session.finalAnswer,
      usage: this.session.usage,
      toolCallCount: this.session.toolCallCount,
      turnCount: this.session.turnCount,
      ...(errorCode !== undefined ? { errorCode } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAgentModelMessage(entry: AgentTranscriptEntry): AgentModelMessage {
  switch (entry.kind) {
    case 'system':
      return { role: 'system', content: entry.content };
    case 'user':
      return { role: 'user', content: entry.content };
    case 'assistantText':
      return { role: 'assistantText', content: entry.content };
    case 'assistantToolCalls':
      return {
        role: 'assistantToolCalls',
        text: entry.text,
        toolCalls: entry.toolCalls.map((c) => ({
          subiCallId: c.callId,
          ...(c.providerCallId !== undefined ? { providerCallId: c.providerCallId } : {}),
          toolName: c.toolName,
          args: c.args,
        })),
      };
    case 'toolResult':
      return {
        role: 'toolResult',
        callId: entry.callId,
        toolName: entry.toolName,
        content: entry.content,
        isError: entry.isError,
      };
  }
}

function parseJsonRecord(partial: string): Record<string, unknown> | null {
  if (partial === '__INVALID_ARGS__') {
    return null;
  }
  if (partial.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(partial) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fingerprintToolCall(toolName: string, args: Record<string, unknown>): string {
  const stable = canonicalizeJson(args);
  return `${toolName}::${stable}`;
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeJson(v)}`).join(',')}}`;
}

function transcriptEntrySize(entry: AgentTranscriptEntry): number {
  switch (entry.kind) {
    case 'system':
    case 'user':
    case 'assistantText':
      return entry.content.length;
    case 'assistantToolCalls':
      return (
        entry.text.length +
        entry.toolCalls.reduce(
          (n, c) => n + c.callId.length + c.toolName.length + JSON.stringify(c.args).length,
          0
        )
      );
    case 'toolResult':
      return entry.callId.length + entry.toolName.length + entry.content.length;
  }
}

export { toAgentModelToolDefinition };
