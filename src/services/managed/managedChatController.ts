import {
  MANAGED_CHAT_ENABLED,
  ManagedChatError,
  ManagedChatMessage,
  streamManagedChat,
} from './managedChatService';
import { ManagedChatHistory } from './managedChatHistory';

/**
 * LearnSmart managed chat orchestration (Phase 8).
 *
 * Owns: single active request, AbortController, managed history, service
 * invocation, optimistic user-turn with rollback. Lives outside
 * ManagedSessionController (policy state) and the BYOK provider registry
 * (managed is not a BYOK provider).
 *
 * Production sends are rejected while MANAGED_CHAT_ENABLED is false —
 * before any token access or network call.
 */

export type ManagedChatSendEvent =
  | { type: 'started'; requestId: number }
  | { type: 'delta'; requestId: number; text: string }
  | { type: 'completed'; requestId: number; modelKey: string; content: string }
  | { type: 'error'; requestId: number; code: string; message: string }
  | { type: 'cancelled'; requestId: number };

export interface ManagedChatSendOptions {
  requestId: number;
  idToken: string;
  modelKey: string;
  text: string;
  origin?: string;
  signal?: AbortSignal;
  onEvent: (event: ManagedChatSendEvent) => void;
}

export type ManagedChatSender = typeof streamManagedChat;

const MAX_SEND_CHARS = 20000;

export class ManagedChatController {
  private readonly history = new ManagedChatHistory();
  private readonly sender: ManagedChatSender;
  private activeRequestId: number | null = null;
  private activeController: AbortController | null = null;

  constructor(sender: ManagedChatSender = streamManagedChat) {
    this.sender = sender;
  }

  get isActive(): boolean {
    return this.activeRequestId !== null;
  }

  getHistory(): ManagedChatMessage[] {
    return this.history.getMessages();
  }

  clearHistory(): void {
    this.history.clear();
  }

  abort(): void {
    try {
      this.activeController?.abort();
    } catch {
      // Best-effort cancellation only.
    }
  }

  async send(options: ManagedChatSendOptions): Promise<void> {
    const { requestId, idToken, modelKey, text, signal, onEvent, origin } = options;
    // Production gate: reject before touching tokens, history, or network.
    if (!MANAGED_CHAT_ENABLED) {
      onEvent({
        type: 'error',
        requestId,
        code: 'managed',
        message: 'Managed chat will be enabled in the next SUBI phase.',
      });
      return;
    }
    if (this.activeRequestId !== null) {
      onEvent({ type: 'error', requestId, code: 'BUSY', message: 'A managed request is already running.' });
      return;
    }
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed.length === 0 || trimmed.length > MAX_SEND_CHARS) {
      onEvent({ type: 'error', requestId, code: 'validation', message: 'Message cannot be empty.' });
      return;
    }
    const controller = new AbortController();
    const onExternalAbort = (): void => {
      try {
        controller.abort();
      } catch {
        // Best-effort only.
      }
    };
    if (signal) {
      if (signal.aborted) {
        onEvent({ type: 'cancelled', requestId });
        return;
      }
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    this.activeRequestId = requestId;
    this.activeController = controller;
    // Optimistic user turn; rolled back unless the stream completes.
    this.history.push('user', trimmed);
    const messages = this.history.getMessages();
    onEvent({ type: 'started', requestId });
    let content = '';
    let settled = false;
    const finish = (event: ManagedChatSendEvent): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
      if (this.activeRequestId === requestId) {
        this.activeRequestId = null;
        this.activeController = null;
      }
      onEvent(event);
    };
    try {
      await this.sender({
        origin,
        idToken,
        requestId: String(requestId),
        modelKey,
        messages,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'delta') {
            content += event.text;
            onEvent({ type: 'delta', requestId, text: event.text });
          }
        },
      });
      const finalText = content.trim();
      if (finalText.length === 0) {
        this.history.popLast();
        finish({ type: 'error', requestId, code: 'unknown', message: 'The SUBI service returned an empty response.' });
        return;
      }
      this.history.push('assistant', content);
      finish({ type: 'completed', requestId, modelKey, content });
    } catch (error) {
      this.history.popLast();
      if (error instanceof ManagedChatError && error.code === 'CANCELLED') {
        finish({ type: 'cancelled', requestId });
        return;
      }
      const code = error instanceof ManagedChatError && error.code ? error.code : 'unknown';
      const message = error instanceof Error && error.message ? error.message : 'An error occurred.';
      finish({ type: 'error', requestId, code, message });
    }
  }
}
