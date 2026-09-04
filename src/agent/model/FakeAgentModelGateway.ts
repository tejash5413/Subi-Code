import { AgentModelEvent, AgentModelRequest } from './AgentModelTypes';
import { AgentModelGateway } from './AgentModelGateway';

/**
 * Phase 10B.1: deterministic, test-only AgentModelGateway.
 *
 * The fake takes a queued set of "model turns" ahead of time. Each turn is
 * a function that returns an array of AgentModelEvents. The fake yields
 * events synchronously via async iteration. The fake honors `signal.aborted`
 * by returning an iterator that ends immediately.
 */
export type FakeModelTurn = (
  request: AgentModelRequest
) => AgentModelEvent[];

export interface FakeAgentModelGatewayOptions {
  turns: FakeModelTurn[];
  /** Optional abort delay in ms; yields nothing further once aborted. */
  yieldDelayMs?: number;
}

export class FakeAgentModelGateway implements AgentModelGateway {
  private readonly turns: FakeModelTurn[];
  private turnIndex = 0;
  private readonly yieldDelayMs: number;

  constructor(options: FakeAgentModelGatewayOptions) {
    if (!Array.isArray(options.turns) || options.turns.length === 0) {
      throw new Error('FakeAgentModelGateway requires at least one turn.');
    }
    this.turns = options.turns.slice();
    this.yieldDelayMs = options.yieldDelayMs ?? 0;
  }

  public async *streamTurn(
    request: AgentModelRequest,
    signal: AbortSignal
  ): AsyncGenerator<AgentModelEvent> {
    const turn = this.turns[this.turnIndex] ?? this.turns[this.turns.length - 1];
    this.turnIndex += 1;
    for (const event of turn(request)) {
      if (signal.aborted) {
        return;
      }
      if (this.yieldDelayMs > 0) {
        const until = Date.now() + this.yieldDelayMs;
        while (Date.now() < until) {
          /* spin */
        }
      }
      yield event;
      if (signal.aborted) {
        return;
      }
    }
  }

  public getCallCount(): number {
    return this.turnIndex;
  }
}
