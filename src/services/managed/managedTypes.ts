/**
 * LearnSmart managed session types + runtime validators (Phase 6).
 *
 * Extension-side model of the LearnSmart managed SUBI policy backend
 * (subiManagedApi). Safe configuration only: identity display fields,
 * backend-approved model records, and the effective monthly token limit.
 *
 * NEVER included here (by type construction AND runtime validation):
 * Firebase ID/refresh tokens, upstreamModelId / OpenRouter model IDs,
 * provider API keys, admin metadata, Firestore paths, usage counters.
 */

/** Lifecycle of the extension-side managed session bootstrap. */
export type ManagedSessionStatus = 'idle' | 'loading' | 'allowed' | 'blocked' | 'unavailable';

export type ManagedUserRole = 'student' | 'teacher';

/** Backend-safe model capabilities (backend projection, not provider metadata). */
export interface ManagedModelCapabilities {
  inputModalities: string[];
  outputModalities: string[];
  toolCalling: boolean;
}

/**
 * One backend-approved managed model. Identified ONLY by the SUBI-owned
 * `modelKey`. A record carrying `upstreamModelId` is rejected, never stored.
 */
export interface ManagedModel {
  modelKey: string;
  displayName: string;
  capabilities: ManagedModelCapabilities;
  contextLength?: number | null;
}

/** Effective per-user monthly token allowance (configuration only). */
export interface ManagedMonthlyLimit {
  configured: boolean;
  monthlyTokenLimit: number | null;
  period: 'calendar_month';
}

export interface ManagedSessionUser {
  uid: string;
  displayName?: string;
  role: ManagedUserRole;
}

export interface ManagedSessionState {
  status: ManagedSessionStatus;
  user?: ManagedSessionUser;
  models: ManagedModel[];
  selectedModelKey?: string;
  monthlyLimit: ManagedMonthlyLimit;
  /** Safe machine-readable reason (e.g. SUBI_ACCESS_DISABLED, managed_timeout). */
  errorCode?: string;
}

/**
 * Exact wire shape sent to the webview. Structurally identical to the safe
 * subset of ManagedSessionState; produced ONLY by toManagedWebviewState().
 */
export interface ManagedWebviewState {
  status: ManagedSessionStatus;
  user?: ManagedSessionUser;
  models: ManagedModel[];
  selectedModelKey?: string;
  monthlyLimit: ManagedMonthlyLimit;
  errorCode?: string;
}

/** Backend-safe access-status result (internal; codesStay server-clean). */
export type ManagedAccessResult = { allowed: true } | { allowed: false; code: string };

/** Internal safe error codes for managed configuration failures. */
export type ManagedErrorCode =
  | 'managed_auth'
  | 'managed_forbidden'
  | 'SUBI_ACCESS_DISABLED'
  | 'SUBI_ACCESS_UNAVAILABLE'
  | 'managed_timeout'
  | 'managed_network'
  | 'managed_invalid_response'
  | 'managed_cancelled';

// ---------------------------------------------------------------------------
// Runtime validators (fail closed; no throws for malformed backend data)
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 200;
const MAX_MODELS = 200;
const MAX_MODALITIES = 10;
const MAX_MODALITY_LENGTH = 40;
/** Mirrors the backend technical maximum (validation safety, not a quota). */
export const MANAGED_HARD_MAX_MONTHLY_TOKENS = 100_000_000;
const MAX_CONTEXT_LENGTH = 10_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return undefined;
  }
  return trimmed;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MODALITIES) {
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    const s = asBoundedString(entry, MAX_MODALITY_LENGTH);
    if (s === undefined) {
      return undefined;
    }
    out.push(s);
  }
  return out;
}

/** Validates GET /managed/access-status payloads. */
export function validateAccessResponse(body: unknown): ManagedAccessResult | null {
  if (!isRecord(body) || typeof body['allowed'] !== 'boolean') {
    return null;
  }
  if (body['allowed'] === true) {
    return { allowed: true };
  }
  const code = asBoundedString(body['code'], 64) ?? 'SUBI_ACCESS_DISABLED';
  return { allowed: false, code };
}

function validateCapabilities(value: unknown): ManagedModelCapabilities | null {
  if (!isRecord(value)) {
    return null;
  }
  const inputModalities = asStringArray(value['inputModalities']);
  const outputModalities = asStringArray(value['outputModalities']);
  if (inputModalities === undefined || outputModalities === undefined) {
    return null;
  }
  if (typeof value['toolCalling'] !== 'boolean') {
    return null;
  }
  return { inputModalities, outputModalities, toolCalling: value['toolCalling'] };
}

function validateContextLength(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_CONTEXT_LENGTH
  ) {
    return undefined;
  }
  return value;
}

/**
 * Validates one managed model record. Returns null for anything unsafe —
 * including any record that carries `upstreamModelId` (rejected, never
 * stripped-and-accepted, so upstream identifiers cannot leak by transform).
 */
export function validateManagedModel(item: unknown): ManagedModel | null {
  if (!isRecord(item)) {
    return null;
  }
  if ('upstreamModelId' in item) {
    return null;
  }
  const modelKey = asBoundedString(item['modelKey'], MAX_ID_LENGTH);
  const displayName = asBoundedString(item['displayName'], MAX_ID_LENGTH);
  if (modelKey === undefined || displayName === undefined) {
    return null;
  }
  const capabilities = validateCapabilities(item['capabilities']);
  if (capabilities === null) {
    return null;
  }
  const contextLength = validateContextLength(item['contextLength']);
  if (item['contextLength'] !== undefined && item['contextLength'] !== null && contextLength === undefined) {
    return null;
  }
  const model: ManagedModel = { modelKey, displayName, capabilities };
  if (contextLength !== undefined) {
    model.contextLength = contextLength;
  }
  return model;
}

/** Validates the GET /managed/models `models` array (drops unsafe records). */
export function validateManagedModels(value: unknown): ManagedModel[] | null {
  if (!Array.isArray(value) || value.length > MAX_MODELS) {
    return null;
  }
  const out: ManagedModel[] = [];
  for (const item of value) {
    const model = validateManagedModel(item);
    if (model === null) {
      return null;
    }
    out.push(model);
  }
  return out;
}

/** Validates GET /managed/monthly-limit payloads (configuration only). */
export function validateMonthlyLimit(body: unknown): ManagedMonthlyLimit | null {
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body['configured'] !== 'boolean') {
    return null;
  }
  if (body['period'] !== 'calendar_month') {
    return null;
  }
  if (body['configured'] === true) {
    const limit = body['monthlyTokenLimit'];
    if (
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > MANAGED_HARD_MAX_MONTHLY_TOKENS
    ) {
      return null;
    }
    return { configured: true, monthlyTokenLimit: limit, period: 'calendar_month' };
  }
  if (body['monthlyTokenLimit'] !== null) {
    return null;
  }
  return { configured: false, monthlyTokenLimit: null, period: 'calendar_month' };
}

/** Canonical not-configured monthly limit snapshot. */
export function emptyMonthlyLimit(): ManagedMonthlyLimit {
  return { configured: false, monthlyTokenLimit: null, period: 'calendar_month' };
}

/** Canonical idle managed session (memory only). */
export function idleManagedSession(): ManagedSessionState {
  return { status: 'idle', models: [], monthlyLimit: emptyMonthlyLimit() };
}
