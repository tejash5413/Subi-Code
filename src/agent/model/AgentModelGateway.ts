import type { AgentModelEvent, AgentModelRequest } from './AgentModelTypes';

/**
 * Phase 10B.1: provider-neutral model gateway interface.
 *
 * Implementations adapt between the canonical AgentModelRequest / AgentModelEvent
 * and a specific provider's wire format. Implementations must NOT execute tools;
 * tools are executed by the host AgentLoop via ToolExecutor. Implementations
 * must be vscode-free and must NOT read SecretStorage.
 */
export interface AgentModelGateway {
  /**
   * Stream one model turn. Yields AgentModelEvent until `completed` is
   * emitted or the iterator ends. Cancellation is signaled by `signal.aborted`.
   * Throwing is allowed only for unrecoverable errors; cancellation must
   * terminate the iterator cleanly (no event after abort).
   */
  streamTurn(
    request: AgentModelRequest,
    signal: AbortSignal
  ): AsyncIterable<AgentModelEvent>;
}
