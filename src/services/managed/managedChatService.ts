import { readSSEEvents } from '../ai/streaming/SSEParser';

/**
 * LearnSmart managed chat transport (Phase 8, TEXT ONLY, local-only).
 *
 * Posts to the dedicated (UNDEPLOYED) managed chat gateway and parses the
 * provider-neutral SSE contract (start/delta/done/error). Sends modelKey
 * ONLY, with the Firebase ID token as a Bearer header.
 *
 * NEVER here: provider hosts/URLs, provider names/IDs, BYOK secret storage,
 * API keys, Firestore, upstream model identifiers, BYOK registry/catalogue.
 * Phase 8 production gate is FALSE (see MANAGED_CHAT_ENABLED).
 */

/** Dedicated chat gateway origin. UNDEPLOYED in Phase 8 — local only. */
export const MANAGED_CHAT_ORIGIN =
  'https://asia-south1-learnsmart-c2a7e.cloudfunctions.net/subiManagedChatApi';

/**
 * Production capability gate. Phase 8 value is FALSE: the host must reject
 * managed sends before any network call, and the webview keeps Send
 * disabled with the standard "next SUBI phase" message. Phase 9 flips this
 * only after quota reservation/accounting/enforcement lands and passes.
 */
export const MANAGED_CHAT_ENABLED = false;

/** Absolute ceiling reconciled with the 540s chat-function maximum. */
export const MANAGED_ABSOLUTE_MAX_MS = 540_000;

export interface ManagedChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ManagedChatEvent =
  | { type: 'start'; requestId: string; modelKey: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; requestId: string; modelKey: string }
  | { type: 'error'; code: string; message: string };

/** Safe normalized error: code + message only, never bodies/headers. */
export class ManagedChatError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ManagedChatError';
    this.code = code;
  }
}

export type ManagedFetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface StreamManagedChatOptions {
  origin?: string;
  idToken: string;
  requestId: string;
  modelKey: string;
  messages: ManagedChatMessage[];
  fetchFn?: ManagedFetchFn;
  signal?: AbortSignal;
  onEvent: (event: ManagedChatEvent) => void;
}

const MODEL_KEY_RE = /^mdl_[A-Za-z0-9-]+$/;

function fail(code: string, message: string): never {
  throw new ManagedChatError(code, message);
}

function validateOptions(options: StreamManagedChatOptions): void {
  if (!options || typeof options !== 'object') {
    fail('INVALID_REQUEST', 'Invalid managed chat request.');
  }
  if (typeof options.idToken !== 'string' || options.idToken.length === 0) {
    fail('managed_auth', 'LearnSmart session has expired. Please sign in again.');
  }
  if (typeof options.requestId !== 'string' || options.requestId.length === 0 || options.requestId.length > 64) {
    fail('INVALID_REQUEST', 'Invalid managed chat request.');
  }
  if (typeof options.modelKey !== 'string' || !MODEL_KEY_RE.test(options.modelKey)) {
    fail('INVALID_REQUEST', 'Invalid managed chat request.');
  }
  if (!Array.isArray(options.messages) || options.messages.length === 0 || options.messages.length > 20) {
    fail('INVALID_REQUEST', 'Invalid managed chat request.');
  }
  for (const m of options.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      fail('INVALID_REQUEST', 'Invalid managed chat request.');
    }
    if (typeof m.content !== 'string' || m.content.length === 0 || m.content.length > 20000) {
      fail('INVALID_REQUEST', 'Invalid managed chat request.');
    }
  }
  if (typeof options.onEvent !== 'function') {
    fail('INTERNAL', 'Invalid managed chat handler.');
  }
}

function parseEvent(event: string | undefined, data: string): ManagedChatEvent | null {
  if (event === undefined || event === '') {
    return null; // keep-alive / untyped frame
  }
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    fail('INTERNAL', 'Unexpected response from the SUBI service.');
  }
  if (!body || typeof body !== 'object') {
    fail('INTERNAL', 'Unexpected response from the SUBI service.');
  }
  const record = body as Record<string, unknown>;
  switch (event) {
    case 'start':
    case 'done': {
      if (typeof record['requestId'] !== 'string' || typeof record['modelKey'] !== 'string') {
        fail('INTERNAL', 'Unexpected response from the SUBI service.');
      }
      return event === 'start'
        ? { type: 'start', requestId: record['requestId'] as string, modelKey: record['modelKey'] as string }
        : { type: 'done', requestId: record['requestId'] as string, modelKey: record['modelKey'] as string };
    }
    case 'delta': {
      if (typeof record['text'] !== 'string') {
        fail('INTERNAL', 'Unexpected response from the SUBI service.');
      }
      return { type: 'delta', text: record['text'] as string };
    }
    case 'error': {
      const code = typeof record['code'] === 'string' && record['code'].length > 0 ? record['code'] : 'INTERNAL';
      const message = typeof record['message'] === 'string' && record['message'].length > 0
        ? record['message']
        : 'The SUBI service could not complete this request.';
      return { type: 'error', code, message };
    }
    default:
      return null; // forward-compatible: ignore unknown event types
  }
}

/**
 * Stream one managed chat turn. Resolves on `done`, throws ManagedChatError
 * on `error` frames, HTTP errors, aborts, or malformed streams. The ID
 * token travels in the Authorization header only and is never stored,
 * logged, or forwarded anywhere else.
 */
export async function streamManagedChat(options: StreamManagedChatOptions): Promise<{ requestId: string; modelKey: string }> {
  validateOptions(options);
  const {
    idToken,
    requestId,
    modelKey,
    messages,
    signal,
    onEvent,
    fetchFn = fetch,
    origin = MANAGED_CHAT_ORIGIN,
  } = options;

  if (signal?.aborted) {
    fail('CANCELLED', 'Request was cancelled.');
  }
  let response: Response;
  try {
    response = await fetchFn(`${origin.replace(/\/+$/, '')}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ requestId, modelKey, messages }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      fail('CANCELLED', 'Request was cancelled.');
    }
    fail('PROVIDER_UNAVAILABLE', 'Unable to reach the SUBI service. Check your connection and try again.');
  }
  if (response!.status === 401) {
    fail('managed_auth', 'LearnSmart session has expired. Please sign in again.');
  }
  if (!response!.ok) {
    let code = 'INTERNAL';
    try {
      const body = (await response!.json()) as unknown;
      if (body && typeof body === 'object' && 'error' in body) {
        const inner = (body as { error?: unknown }).error;
        if (inner && typeof inner === 'object' && typeof (inner as { code?: unknown }).code === 'string') {
          code = (inner as { code: string }).code;
        }
      }
    } catch {
      // Unreadable body: keep generic code.
    }
    fail(code, 'The SUBI service could not complete this request.');
  }
  const contentType = response!.headers?.get('content-type') ?? '';
  if (contentType && !contentType.includes('text/event-stream')) {
    fail('INTERNAL', 'Unexpected response from the SUBI service.');
  }
  if (!response!.body) {
    fail('INTERNAL', 'Unexpected response from the SUBI service.');
  }
  if (signal?.aborted) {
    fail('CANCELLED', 'Request was cancelled.');
  }
  let sawDone = false;
  try {
    for await (const frame of readSSEEvents(response!.body as ReadableStream<Uint8Array>)) {
      if (signal?.aborted) {
        fail('CANCELLED', 'Request was cancelled.');
      }
      const event = parseEvent(frame.event, frame.data);
      if (!event) {
        continue;
      }
      if (event.type === 'error') {
        fail(event.code, event.message);
      }
      if (event.type === 'done') {
        sawDone = true;
      }
      onEvent(event);
    }
  } catch (error) {
    if (error instanceof ManagedChatError) {
      throw error;
    }
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      fail('CANCELLED', 'Request was cancelled.');
    }
    fail('PROVIDER_UNAVAILABLE', 'The SUBI service connection was interrupted. Please try again.');
  }
  if (!sawDone) {
    fail('INTERNAL', 'Unexpected response from the SUBI service.');
  }
  return { requestId, modelKey };
}
