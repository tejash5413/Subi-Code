/**
 * Provider-neutral streaming events (Stage 4A.2.2).
 *
 * Adapters normalize raw provider wire formats into these events.
 * Raw provider events must never leave the adapter.
 */
export type AIStreamEvent =
  | {
      type: 'textDelta';
      text: string;
    }
  | {
      type: 'metadata';
      actualModelId?: string;
    }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      type: 'completed';
    };
