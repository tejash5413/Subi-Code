import {
  type ManagedAccessResult,
  type ManagedErrorCode,
  type ManagedModelsResult,
  type ManagedMonthlyLimit,
  type ManagedUsageResponse,
  type SubiCodeStatus,
  validateAccessResponse,
  validateManagedModels,
  validateManagedPolicySource,
  validateMonthlyLimit,
  validateSubiCodeStatus,
  validateUsageResponse,
  validateQuotaMode,
} from './managedTypes';
import { safeManagedBackendCode } from './managedBackendCodes';

/** Trusted LearnSmart web destinations (centralized; never from webview input). */
export const SUBI_TOPUP_URL = 'https://stlearnsmart.in/purchase?subi=topup';
export const SUBI_SUBSCRIPTION_URL = 'https://stlearnsmart.in/purchase?subi=1';

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

/**
 * Backend-safe error codes preserved verbatim from non-2xx managed
 * responses (never raw backend internals — fixed allowlist + fixed
 * user-facing copy). Everything else keeps the previous generic mapping
 * so the session still fails closed to `unavailable`.
 */
const PRESERVED_MANAGED_CODES: ReadonlyMap<string, string> = new Map([
  ['UNAUTHENTICATED', 'LearnSmart session has expired. Please sign in again.'],
  ['FORBIDDEN', 'This LearnSmart account cannot use SUBI.'],
  ['SUBI_ACCESS_DISABLED', 'SUBI access is currently disabled for your account.'],
  ['SUBI_CODE_REQUIRED', 'An active SUBI subscription is required.'],
  ['MODEL_NOT_ALLOWED', 'This model is unavailable for your account.'],
  ['MONTHLY_LIMIT_NOT_CONFIGURED', 'Your school token allowance is not configured.'],
  ['MONTHLY_LIMIT_EXHAUSTED', 'Your school token allowance is exhausted.'],
  ['MONTHLY_LIMIT_EXCEEDED', 'Your school token allowance is exhausted.'],
  ['CREDIT_EXHAUSTED', 'Your SUBI credits are exhausted.'],
  ['INSUFFICIENT_CREDITS', 'Your SUBI credits are exhausted.'],
  ['INTERNAL', 'The SUBI service is temporarily unavailable. Please try again.'],
  ['SUBI_ACCESS_UNAVAILABLE', 'Unable to verify your SUBI access right now. Please try again.'],
  ['FX_UNAVAILABLE', 'Credit setup is temporarily unavailable. Refresh after the FX rate is configured.'],
  ['SUBI_BILLING_UNAVAILABLE', 'The SUBI service is temporarily unavailable. Please try again.'],
  ['SUBI_NO_PAID_PERIOD', 'SUBI credits are being prepared.'],
  ['SUBI_PLAN_EXPIRED', 'Your LearnSmart plan has expired. Renew your plan to continue using Subi.'],
  ['ACCOUNT_TYPE_UNSUPPORTED', 'Your LearnSmart account type is not configured. Ask your administrator to review your account.'],
]);

export type ManagedFetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Safe normalized error: static message only, never token/header/body. */
export class ManagedError extends Error {
  public readonly code: ManagedErrorCode;
  constructor(code: ManagedErrorCode, message: string, public readonly httpStatus?: number) {
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
  async getModels(idToken: string, signal?: AbortSignal): Promise<ManagedModelsResult> {
    const body = await this.getJson('/managed/models', { idToken, signal });
    if (
      typeof body !== 'object' ||
      body === null ||
      (body as { allowed?: unknown }).allowed !== true
    ) {
      throw this.accessErrorFromBody(body);
    }
    const models = validateManagedModels((body as { models?: unknown }).models);
    const source = validateManagedPolicySource((body as { source?: unknown }).source);
    const quotaMode = validateQuotaMode((body as { quotaMode?: unknown }).quotaMode);
    if (models === null || source === null || quotaMode === null) {
      throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
    }
    return { models, ...(source ? { source } : {}), ...(quotaMode ? { quotaMode } : {}) };
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
    if (limit.code) throw this.accessErrorFromBody(body);
    return limit;
  }

  /**
   * GET /managed/usage — call only after access allowed (Phase 9C.1).
   * Returns the server usage snapshot plus the current-user chat
   * capability. A missing `chatAvailable` (pre-9B.2A backend) fails closed
   * to false. Denied responses return normally (no usage details) so the
   * caller can keep session state without leaking quota information.
   */
  async getUsage(idToken: string, signal?: AbortSignal): Promise<ManagedUsageResponse> {
    const body = await this.getJson('/managed/usage', { idToken, signal });
    const parsed = validateUsageResponse(body);
    if (parsed === null) {
      throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
    }
    return parsed;
  }

  /**
   * GET /managed/subicode-status — individual subscription state
   * (active/renewalDateMs/source/quotaMode). Tier is never exposed by the
   * backend and never consumed here. Best-effort display data: callers must
   * keep the session usable when it fails.
   */
  async getSubiCodeStatus(idToken: string, signal?: AbortSignal): Promise<SubiCodeStatus> {
    const body = await this.getJson('/managed/subicode-status', { idToken, signal });
    const parsed = validateSubiCodeStatus(body);
    if (parsed === null) {
      throw new ManagedError('managed_invalid_response', 'Unexpected response from the SUBI service.');
    }
    return parsed;
  }

  private accessErrorFromBody(body: unknown): ManagedError {
    const preserved = this.preservedError(body, 200);
    if (preserved) return preserved;
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
      if (!response.ok) {
        const preserved = await this.readPreservedError(response);
        if (preserved) throw preserved;
      }
      if (response.status === 401) {
        throw new ManagedError('managed_auth', 'LearnSmart session has expired. Please sign in again.', response.status);
      }
      if (response.status === 403) {
        throw new ManagedError('managed_forbidden', 'This LearnSmart account cannot use SUBI.', response.status);
      }
      if (response.status === 503 || response.status === 500 || response.status === 502 || response.status === 504) {
        throw new ManagedError(
          'SUBI_ACCESS_UNAVAILABLE',
          'The SUBI service is temporarily unavailable. Please try again.', response.status
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

  /**
   * Reads a preserved backend-safe error from a non-2xx response.
   * Returns null when the body carries no allowlisted code (caller falls
   * back to the generic mapping). Never surfaces raw backend internals.
   */
  private async readPreservedError(response: Response): Promise<ManagedError | null> {
    try {
      const body = (await response.json()) as unknown;
      return this.preservedError(body, response.status);
    } catch {
      // Fall through: body unreadable, caller maps generically.
    }
    return null;
  }

  private preservedError(body: unknown, status?: number): ManagedError | null {
    if (typeof body !== 'object' || body === null) return null;
    const record = body as Record<string, unknown>;
    const nested = record.error;
    const code = record.code ?? (typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>).code : undefined);
    const safe = safeManagedBackendCode(code);
    if (!safe) return null;
    const message = PRESERVED_MANAGED_CODES.get(safe) ?? 'The SUBI service could not complete this request.';
    return new ManagedError(safe, message, status);
  }

}
