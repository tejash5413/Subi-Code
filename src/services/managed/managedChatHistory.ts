import type { ManagedChatMessage } from './managedChatService';

/**
 * LearnSmart managed conversation history (Phase 8).
 *
 * Memory-only, LearnSmart-scoped, TEXT ONLY. Strictly separate from
 * AIService.history: managed turns must never contain BYOK turns (which
 * carry provider model IDs) and BYOK history must never be submitted to
 * the managed backend. Bounds mirror the BYOK budgets.
 */

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_CHARS = 60_000;

export class ManagedChatHistory {
  private readonly turns: ManagedChatMessage[] = [];

  getMessages(): ManagedChatMessage[] {
    return this.turns.map((t) => ({ ...t }));
  }

  get size(): number {
    return this.turns.length;
  }

  /** Append a turn, trimming oldest-first within budgets. */
  push(role: 'user' | 'assistant', content: string): void {
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || content.length === 0) {
      return;
    }
    this.turns.push({ role, content });
    this.trim();
  }

  /** Remove the most recent turn (preflight-failure/cancel rollback). */
  popLast(): void {
    this.turns.pop();
  }

  clear(): void {
    this.turns.length = 0;
  }

  private trim(): void {
    while (this.turns.length > MAX_HISTORY_MESSAGES) {
      this.turns.shift();
    }
    let chars = this.turns.reduce((sum, t) => sum + t.content.length, 0);
    while (this.turns.length > 0 && chars > MAX_HISTORY_CHARS) {
      const removed = this.turns.shift();
      chars -= removed ? removed.content.length : 0;
    }
  }
}
