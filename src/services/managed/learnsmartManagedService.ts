import {
  ManagedAccessResult,
  ManagedErrorCode,
  ManagedModel,
  ManagedMonthlyLimit,
  validateAccessResponse,
  validateManagedModels,
  validateMonthlyLimit,
} from './managedTypes';

/**
 * LearnSmart managed SUBI policy client (Phase 6).
 *
 * Talks ONLY to subiManagedApi configuration endpoints. Extension-host
 * fetch with a bounded timeout per request. No Firebase login, no BYOK
 * secrets, no provider chat, no Firestore, no webview code.
 *
 * The Firebase ID token arrives per call from the caller (extension-side
 * memory) and is used solely in the Authorization header. It is never
 * stored, logged, or included in errors.
 */

export const MANAGED_API_ORIGIN =
  'https://asia-south1-learnsmart-c2a7e.cloudfunctions.net/subiManagedApi';

/** Bounded timeout per managed configuration request (~12s). */
export const MANAGED_REQUEST_TIMEOUT_MS = 12_000;

export type ManagedFetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Safe normalized error: static message only, never token/header/body. */
export class ManagedError extends Error {
  public readonly code: ManagedErrorCode;
  constructor(code: ManagedErrorCode, message: string) {
    super(message);
    this.name = 'ManagedError';
    this.code = code;
  }
}

interface RequestOptions {
  idToken: string;
  signal?: AbortSignal;
}

export class LearnSmartManagedService {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: ManagedFetchFn;

  constructor(
    origin: string = MANAGED_API_ORIGIN,
    timeoutMs: number = MANAGED_REQUEST_TIMEOUT_MS,
    fetchFn: ManagedFetchFn = fetch
  ) {
    this.origin = origin.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  /** GET /managed/access-status — must complete before models/limit calls. */
  async getAccessStatus(idToken: string, signal?: AbortSignal): Promise<ManagedAccessResult> {
    const body = await this.getJson('/managed/access-status', { idToken, signal });
    const parsed = validateAccessResponse(body);
    if (parsed === null) {
      throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
    }
    return parsed;
  }

  /** GET /managed/models — call only after access allowed. */
  async getModels(idToken: string, signal?: AbortSignal): Promise<ManagedModel[]> {
    const body = await this.getJson('/managed/models', { idToken, signal });
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as { allowed?: unknown }).allowed !== true
    ) {
      throw this.accessErrorFromBody(body);
    }
    const models = validateManagedModels((body as { models?: unknown }).models);
    if (models === null) {
      throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
    }
    return models;
  }

  /** GET /managed/monthly-limit — call only after access allowed. */
  async getMonthlyLimit(idToken: string, signal?: AbortSignal): Promise<ManagedMonthlyLimit> {
    const body = await this.getJson('/managed/monthly-limit', { idToken, signal });
    if (
      typeof body !== 'object' ||
      body === null ||
      'allowed' in (body as Record<string, unknown>)
    ) {
      throw this.accessErrorFromBody(body);
    }
    const limit = validateMonthlyLimit(body);
    if (limit === null) {
      throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
    }
    return limit;
  }

  private accessErrorFromBody(body: unknown): ManagedError {
    if (typeof body === 'object' && body !== null) {
      const code = (body as Record<string, unknown>)['code'];
      if (code === 'SUBI_ACCESS_DISABLED') {
        return new ManagedError('SUBI_ACCESS_DISABLED', 'SUBI access is currently disabled for your account.');
      }
      if (code === 'SUBI_ACCESS_UNAVAILABLE') {
        return new ManagedError(
          'SUBI_ACCESS_UNAVAILABLE',
          'Unable to verify your SUBI access right now. Please try again.'
        );
      }
    }
    return new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
  }

  private async getJson(path: string, options: RequestOptions): Promise<unknown> {
    const { idToken, signal } = options;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new ManagedError('managed_auth', 'LearnSmart session has expired. Please sign in again.');
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onParentAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        throw new ManagedError('managed_cancelled', 'Request was cancelled.');
      }
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.origin}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${idToken}`, Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch (error) {
        throw this.networkError(error, timedOut, signal);
      }
      if (response.status === 401) {
        throw new ManagedError('managed_auth', 'LearnSmart session has expired. Please sign in again.');
      }
      if (response.status === 403) {
        throw new ManagedError('managed_forbidden', 'This LearnSmart account cannot use SUBI.');
      }
      if (response.status === 503 || response.status === 500 || response.status === 502 || response.status === 504) {
        const code = await this.readErrorCode(response);
        if (code === 'SUBI_ACCESS_UNAVAILABLE') {
          throw new ManagedError(
            'SUBI_ACCESS_UNAVAILABLE',
            'Unable to verify your SUBI access right now. Please try again.'
          );
        }
        throw new ManagedError(
          'SUBI_ACCESS_UNAVAILABLE',
          'The SUBI service is temporarily unavailable. Please try again.'
        );
      }
      if (!response.ok) {
        throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onParentAbort);
    }
  }

  private networkError(error: unknown, timedOut: boolean, signal?: AbortSignal): ManagedError {
    if (timedOut) {
      return new ManagedError('managed_timeout', 'The SUBI service took too long to respond. Please try again.');
    }
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return new ManagedError('managed_cancelled', 'Request was cancelled.');
    }
    return new ManagedError('managed_network', 'Unable to reach the SUBI service. Check your connection and try again.');
  }

  private async readErrorCode(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as unknown;
      if (typeof body === 'object' && body !== null) {
        const code = (body as Record<string, unknown>)['code'];
        return typeof code === 'string' ? code : '';
      }
    } catch {
      // Fall through: body unreadable, caller maps generically.
    }
    return '';
  }
}
