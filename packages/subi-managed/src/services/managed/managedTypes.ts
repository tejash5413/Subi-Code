import { safeManagedBackendCode, type ManagedBackendCode } from './managedBackendCodes';
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

/** Coarse effective-policy origin safe to show to the signed-in user. */
export type ManagedPolicySource = 'school' | 'individual' | 'none';

/** Backend-safe model capabilities (backend projection, not provider metadata). */
export type ManagedTerminalCompatibility = 'verified' | 'unsupported';

/** Phase 17: verification-agent compatibility. Absent = pre-17I backend. */
export type ManagedVerifyCompatibility = 'verified' | 'unsupported' | 'unknown';

export interface ManagedModelCapabilities {
  inputModalities: string[];
  outputModalities: string[];
  toolCalling: boolean;
  /**
   * Phase 16 production: terminal-agent compatibility. Absent = unknown
   * (probe allowed while managedAgentMode=test; reserved for fail-closed
   * production policy). Never inferred from names/prices.
   */
  agentTerminal?: ManagedTerminalCompatibility;
  /**
   * Phase 17: verification-agent compatibility for the 18-tool verify_v1
   * bundle. Absent = unknown (same test-probe/production-fail-closed split
   * as agentTerminal, enforced server-side). agentTerminal=verified never
   * implies agentVerify=verified.
   */
  agentVerify?: ManagedVerifyCompatibility;
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
  /** Backend-confirmed free SKU with zero token prices; dispatch rechecks. */
  freeCoding?: boolean;
}

/** Validated GET /managed/models result, including its effective origin. */
export interface ManagedModelsResult {
  models: ManagedModel[];
  /** Optional for rolling compatibility with an older deployed backend. */
  source?: ManagedPolicySource;
  quotaMode?: ManagedQuotaMode;
}

/** Authoritative backend quota routing. Individuals use credits; schools use tokens. */
export type ManagedQuotaMode = 'school_tokens' | 'individual_credits';

/**
 * Individual SUBI credit balances (milliCredits; 1000 milli = 1 displayed
 * credit). All fields come straight from GET /managed/usage or
 * /managed/monthly-limit — never derived, estimated, or combined client-side.
 */
export interface ManagedIndividualCredits {
  monthlyGrantMilli?: number | null;
  monthlyRemainingMilli?: number | null;
  rolloverRemainingMilli?: number | null;
  topupRemainingMilli?: number | null;
  reservedMilli?: number | null;
  totalAvailableMilli?: number | null;
  cycleId?: string | null;
  cycleEndsAtMs?: number | null;
}

/** Effective per-user monthly token allowance (configuration only). */
export interface ManagedMonthlyLimit {
  configured: boolean;
  monthlyTokenLimit: number | null;
  period: 'calendar_month';
  /** Optional for rolling compatibility with an older deployed backend. */
  source?: ManagedPolicySource;
  /** Dual quota routing: school tokens vs individual credits. */
  quotaMode?: ManagedQuotaMode;
  credits?: {
    monthlyGrantMilli?: number | null;
    monthlyRemainingMilli?: number | null;
    rolloverRemainingMilli?: number | null;
    topupRemainingMilli?: number | null;
    reservedMilli?: number | null;
    totalAvailableMilli?: number | null;
    cycleId?: string | null;
    cycleEndsAtMs?: number | null;
  } | null;
  code?: string;
}

/**
 * Per-user monthly usage snapshot (Phase 9C.1). All token counts come
 * straight from GET /managed/usage — never derived, estimated, or combined
 * client-side. Quota remains server authoritative; this is display/preflight
 * state only. The backend already subtracts live reservation risk from
 * remainingTokens; the extension must not second-guess it.
 *
 * School branch (`school_tokens` or absent quotaMode) carries token fields.
 * Individual branch (`individual_credits`) carries `credits` instead — never
 * token fields. Rendering MUST branch on quotaMode, never on field presence.
 */
export interface ManagedUsage {
  /** Dual quota routing; individuals use the credits payload. */
  quotaMode?: ManagedQuotaMode;
  configured: boolean;
  /** Backend period format (YYYY-MM). School only. */
  period?: string;
  /** School only. */
  monthlyTokenLimit?: number | null;
  /** School only. */
  usedTokens?: number;
  /** School only. */
  remainingTokens?: number | null;
  /** Individual only. Null when the backend has no credit account yet. */
  credits?: ManagedIndividualCredits | null;
}

/**
 * GET /managed/subicode-status result. Single-plan SUBI: no tier is ever
 * exposed (`tier` must be null/absent; anything else is rejected).
 */
export interface SubiCodeStatus {
  active: boolean;
  /** Always null by backend contract (no Basic/Plus/Pro). */
  tier: null;
  /** Paid-through instant, or null when the backend has none. */
  renewalDateMs: number | null;
  /** Coarse entitlement origin safe to show. */
  source: 'individual_subscription' | 'school_default';
  /** Present on current backends; absent on older ones. */
  quotaMode?: ManagedQuotaMode;
  /** Present only when active === false. */
  code?: string;
}

/** Individual SUBI subscription snapshot kept in session state. */
export interface ManagedSubscriptionState {
  active: boolean;
  renewalDateMs: number | null;
  source?: 'individual_subscription' | 'school_default';
  /**
   * Quota routing from /managed/subicode-status (absent on older backends).
   * Used as a quotaMode fallback so an individual account never renders
   * school token rows while usage/monthly-limit snapshots are unavailable.
   */
  quotaMode?: ManagedQuotaMode;
}

/** Display health of the individual credit card (host-computed). */
export type SubiCreditHealth =
  | 'not-applicable'
  | 'unavailable'
  | 'expired'
  | 'uninitialized'
  | 'healthy'
  | 'low'
  | 'very-low'
  | 'exhausted';

/** Host-computed individual credit display state (safe scalars only). */
export interface SubiCreditSummary {
  health: SubiCreditHealth;
  totalAvailableMilli: number | null;
  monthlyGrantMilli: number | null;
  monthlyRemainingMilli: number | null;
  rolloverRemainingMilli: number | null;
  purchasedRemainingMilli: number | null;
  reservedMilli: number | null;
  cycleEndsAtMs: number | null;
  subscriptionActive: boolean | null;
  renewalDateMs: number | null;
}

/** Lifecycle of the extension-side usage/capability fetch. */
export type ManagedUsageStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Host-side usage + server capability state. `chatAvailable` is the
 * backend's current-user capability (operational gate), independent of the
 * local MANAGED_CHAT_ENABLED build gate. Missing data fails closed (false).
 */
export interface ManagedUsageState {
  status: ManagedUsageStatus;
  /** Present only when status === 'ready'. */
  usage?: ManagedUsage;
  chatAvailable: boolean;
  /** Safe machine-readable reason for status === 'error'. */
  errorCode?: string;
  /** Host-side fetch time (UX freshness hint only, never quota authority). */
  lastUpdatedAt?: number;
}

export interface ManagedSessionUser {
  uid: string;
  displayName?: string;
  role: ManagedUserRole;
  accountType?: 'school' | 'individual';
}

export interface ManagedSessionState {
  /** Host-only authenticated access-status snapshot; not webview authority. */
  permissionPolicy?: import('../../core/permissions/PermissionProfile').ManagedPermissionPolicy;
  status: ManagedSessionStatus;
  /** Safe directory-derived routing supplied by access-status. */
  accessQuotaMode?: ManagedQuotaMode;
  user?: ManagedSessionUser;
  models: ManagedModel[];
  /** Effective origin for the complete managed model list. */
  modelSource?: ManagedPolicySource;
  selectedModelKey?: string;
  monthlyLimit: ManagedMonthlyLimit;
  /** Safe machine-readable reason (e.g. SUBI_ACCESS_DISABLED, managed_timeout). */
  errorCode?: string;
  /** Usage + server chat capability (Phase 9C.1). Idle until bootstrap loads it. */
  usage: ManagedUsageState;
  /**
   * Individual SUBI subscription snapshot (from /managed/subicode-status).
   * Absent = unknown (fetch failed or not yet loaded); never invent active.
   */
  subscription?: ManagedSubscriptionState;
  /**
   * Phase 15: server-authoritative managed file capability
   * (from access-status; 'none' default, fail closed).
   */
  agentFileCapability: ManagedFileCapability;
  /** Server runtime availability; absent on older backend deployments. */
  agentAvailable?: boolean;
  agentTerminalCapability?: 'none' | 'terminal';
  agentImageCapability?: 'image_v1';
  /** Explicit server contracts; absent means no support on old deployments. */
  agentJobs?: 'jobs_v1'; agentCoordination?: 'coordination_v1'; agentMcp?: 'mcp_v1'; agentPty?: 'pty_v1'; toolCapabilities?: Array<'agent_skills_v1'>;
}

/**
 * Host-computed managed Send decision (Phase 9C.1). The webview renders it;
 * it never decides authorization. Reason codes are local UI state only and
 * deliberately reveal nothing about backend mode or test allowlists.
 */
export type ManagedSendReason =
  | 'ready'
  | 'build_disabled'
  | 'server_unavailable'
  | 'not_authenticated'
  | 'access_denied'
  | 'no_model'
  | 'usage_unavailable'
  | 'limit_not_configured'
  | 'quota_exhausted'
  | 'busy'
  | 'agent_disabled'
  | 'agent_unavailable'
  | 'mode_unavailable';

export interface ManagedSendState {
  canSend: boolean;
  reason: ManagedSendReason;
}

/**
 * Exact wire shape sent to the webview. Structurally identical to the safe
 * subset of ManagedSessionState; produced ONLY by toManagedWebviewState().
 */
export interface ManagedWebviewState {
  status: ManagedSessionStatus;
  agentAvailable?: boolean;
  accessQuotaMode?: ManagedQuotaMode;
  user?: ManagedSessionUser;
  models: Array<ManagedModel & { capabilityLabel: string }>;
  modelSource?: ManagedPolicySource;
  selectedModelKey?: string;
  monthlyLimit: ManagedMonthlyLimit;
  errorCode?: string;
  /** Safe usage + capability snapshot (absent fields stay absent). */
  usage: ManagedUsageState;
  /**
   * Individual SUBI subscription snapshot (from /managed/subicode-status).
   * Absent = unknown; carries quotaMode for the quotaMode fallback order.
   */
  subscription?: ManagedSubscriptionState;
  /** Host-authoritative Send decision for the managed composer. */
  sendState: ManagedSendState;
  /**
   * Host-computed individual credit display state (safe scalars only).
   * Present when computable; webview renders it without recomputing.
   */
  creditSummary?: SubiCreditSummary;
}

/**
 * Phase 15: server-authoritative file capability for the managed agent.
 * 'none' = reads only; 'plan' = reads + propose_patch; 'build' = full file
 * tools (still permission-gated host-side). Absent = 'none' (fail closed).
 */
export type ManagedFileCapability = 'none' | 'plan' | 'build';

/** Backend-safe access-status result (internal; codesStay server-clean). */
export type ManagedAccessResult =
  ({ accountType?: 'school' | 'individual'; quotaMode?: ManagedQuotaMode; permissionPolicy?: import('../../core/permissions/PermissionProfile').ManagedPermissionPolicy } & (
  | { allowed: true; agentAvailable?: boolean; agentFile?: ManagedFileCapability; agentTerminal?: 'none' | 'terminal'; agentImage?: 'image_v1'; agentJobs?: 'jobs_v1'; agentCoordination?: 'coordination_v1'; agentMcp?: 'mcp_v1'; agentPty?: 'pty_v1'; toolCapabilities?: Array<'agent_skills_v1'> }
  | { allowed: false; code: string }));

/**
 * Internal safe error codes for managed configuration failures.
 * Backend-safe codes (FX_UNAVAILABLE, SUBI_BILLING_UNAVAILABLE,
 * SUBI_NO_PAID_PERIOD, SUBI_PLAN_EXPIRED, ACCOUNT_TYPE_UNSUPPORTED) are
 * preserved from specific bootstrap failures so the UI can explain them
 * without exposing backend internals. All remain fail-closed client-side.
 */
export type ManagedErrorCode =
  | ManagedBackendCode
  | 'managed_auth'
  | 'managed_forbidden'
  | 'SUBI_ACCESS_DISABLED'
  | 'SUBI_ACCESS_UNAVAILABLE'
  | 'FX_UNAVAILABLE'
  | 'SUBI_BILLING_UNAVAILABLE'
  | 'SUBI_NO_PAID_PERIOD'
  | 'SUBI_PLAN_EXPIRED'
  | 'ACCOUNT_TYPE_UNSUPPORTED'
  | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'SUBI_CODE_REQUIRED' | 'MODEL_NOT_ALLOWED'
  | 'MONTHLY_LIMIT_NOT_CONFIGURED' | 'MONTHLY_LIMIT_EXHAUSTED' | 'CREDIT_EXHAUSTED'
  | 'MONTHLY_LIMIT_EXCEEDED' | 'INSUFFICIENT_CREDITS' | 'INTERNAL'
  | 'managed_timeout'
  | 'managed_network'
  | 'managed_invalid_response'
  | 'managed_cancelled';

// ---------------------------------------------------------------------------
// Runtime validators (fail closed; no throws for malformed backend data)
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 200;
// A validation ceiling, not a display or policy limit. Large approved
// registries retain their entire eligible list instead of disappearing.
const MAX_MODELS = 5000;
const MAX_MODALITIES = 10;
const MAX_MODALITY_LENGTH = 40;
/** Mirrors the backend technical maximum (validation safety, not a quota). */
export const MANAGED_HARD_MAX_MONTHLY_TOKENS = 100_000_000;
const MAX_CONTEXT_LENGTH = 10_000_000;
function safeManagedStatusCode(value: unknown, fallback: string): string {
  return safeManagedBackendCode(value) ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strictly validates the authoritative backend quota mode. Missing stays
 * undefined (legacy school-shaped backends). Anything else fails closed —
 * rendering must never infer the account experience from field presence.
 */
export function validateQuotaMode(value: unknown): ManagedQuotaMode | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return value === 'school_tokens' || value === 'individual_credits' ? value : null;
}

/** Display routing only. Unknown never becomes school; server gates remain authoritative. */
export function resolveManagedQuotaMode(state: Pick<ManagedSessionState, 'usage' | 'monthlyLimit' | 'subscription' | 'user' | 'accessQuotaMode'>): ManagedQuotaMode | undefined {
  return state.usage.usage?.quotaMode ?? state.monthlyLimit.quotaMode ?? state.subscription?.quotaMode ?? state.accessQuotaMode
    ?? (state.user?.accountType === 'individual' ? 'individual_credits' : state.user?.accountType === 'school' ? 'school_tokens' : undefined);
}

/** Strictly validates the coarse policy source. Missing stays undefined. */
export function validateManagedPolicySource(value: unknown): ManagedPolicySource | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return value === 'school' || value === 'individual' || value === 'none' ? value : null;
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

function validateFileCapability(value: unknown): ManagedFileCapability {
  return value === 'plan' || value === 'build' ? value : 'none';
}

/** Validates GET /managed/access-status payloads. */
export function validateAccessResponse(body: unknown): ManagedAccessResult | null {
  if (!isRecord(body) || typeof body['allowed'] !== 'boolean') {
    return null;
  }
  const quotaMode = validateQuotaMode(body['quotaMode']);
  const accountType = body['accountType'];
  if (quotaMode === null || (accountType !== undefined && accountType !== 'school' && accountType !== 'individual')) return null;
  if ((accountType === 'school' && quotaMode === 'individual_credits') || (accountType === 'individual' && quotaMode === 'school_tokens')) return null;
  let permissionPolicy: import('../../core/permissions/PermissionProfile').ManagedPermissionPolicy | undefined;
  if (body['allowed'] === true && body['permissionPolicy'] !== undefined) {
    const policy = body['permissionPolicy'];
    if (!isRecord(policy) || Object.keys(policy).some(key => !['schemaVersion', 'profileCeiling', 'source', 'validUntilMs'].includes(key)) ||
        policy['schemaVersion'] !== 1 || typeof policy['profileCeiling'] !== 'string' || !['ask', 'session', 'full'].includes(policy['profileCeiling']) ||
        (accountType !== 'school' && accountType !== 'individual') ||
        policy['source'] !== (accountType === 'school' ? 'school_role' : 'individual') ||
        !Number.isSafeInteger(policy['validUntilMs']) || (policy['validUntilMs'] as number) < 0) return null;
    permissionPolicy = { schemaVersion: 1, profileCeiling: policy['profileCeiling'] as 'ask' | 'session' | 'full', source: policy['source'] as 'school_role' | 'individual', validUntilMs: policy['validUntilMs'] as number };
  }
  const context = { ...(quotaMode ? { quotaMode } : {}), ...(accountType ? { accountType: accountType as 'school' | 'individual' } : {}), ...(permissionPolicy ? { permissionPolicy } : {}) };
  if (body['allowed'] === true) {
    const advertised = body['toolCapabilities'];
    if (advertised !== undefined && (!Array.isArray(advertised) || advertised.length > 8 || advertised.some(v => v !== 'agent_skills_v1') || new Set(advertised).size !== advertised.length)) return null;
    if (body['agentCoordination'] !== undefined && (body['agentCoordination'] !== 'coordination_v1' || body['agentJobs'] !== 'jobs_v1')) return null;
    if (body['agentAvailable'] !== undefined && typeof body['agentAvailable'] !== 'boolean') return null;
    if (body['agentPty'] !== undefined && body['agentPty'] !== 'pty_v1') return null;
    if (body['agentMcp'] !== undefined && body['agentMcp'] !== 'mcp_v1') return null;
    const agentFile = validateFileCapability(body['agentFile']);
    return { ...context, ...(body['agentCoordination'] === 'coordination_v1' ? { agentCoordination: 'coordination_v1' as const } : {}), ...(body['agentPty'] === 'pty_v1' ? { agentPty: 'pty_v1' as const } : {}), ...(body['agentMcp'] === 'mcp_v1' ? { agentMcp: 'mcp_v1' as const } : {}), ...(body['agentJobs'] === 'jobs_v1' ? { agentJobs: 'jobs_v1' as const } : {}), ...(advertised !== undefined ? { toolCapabilities: [...advertised] as Array<'agent_skills_v1'> } : {}), ...(agentFile === 'none' ? { allowed: true as const } : { allowed: true as const, agentFile }), ...(typeof body['agentAvailable'] === 'boolean' ? { agentAvailable: body['agentAvailable'] } : {}), ...(body['agentTerminal'] === 'terminal' && agentFile === 'build' ? { agentTerminal: 'terminal' as const } : {}), ...(body['agentImage'] === 'image_v1' ? { agentImage: 'image_v1' as const } : {}) };
  }
  const code = safeManagedStatusCode(body['code'], 'SUBI_ACCESS_DISABLED');
  return { ...context, allowed: false, code };
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
  const capabilities: ManagedModelCapabilities = { inputModalities, outputModalities, toolCalling: value['toolCalling'] };
  const agentTerminal = value['agentTerminal'];
  if (agentTerminal === 'verified' || agentTerminal === 'unsupported') {
    capabilities.agentTerminal = agentTerminal;
  }
  const agentVerify = value['agentVerify'];
  if (agentVerify === 'verified' || agentVerify === 'unsupported' || agentVerify === 'unknown') {
    capabilities.agentVerify = agentVerify;
  }
  return capabilities;
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
  if (item['freeCoding'] !== undefined) {
    if (typeof item['freeCoding'] !== 'boolean') return null;
    model.freeCoding = item['freeCoding'];
  }
  return model;
}

/**
 * Validates the GET /managed/models `models` array.
 *
 * Model-assignment live-sync repair: drops individual unsafe records
 * (keeping the rest) instead of failing the whole list when a single
 * registry record is malformed. A newly assigned model with an off-shape
 * record must never hide the entire effective list, and a malformed
 * record must never block a refresh from showing newly assigned models.
 * Returns null only when the envelope itself is malformed or when a
 * non-empty input validates to zero models (total corruption fails
 * closed, preserving the previous fail-closed behavior for that case).
 */
export function validateManagedModels(value: unknown): ManagedModel[] | null {
  if (!Array.isArray(value) || value.length > MAX_MODELS) {
    return null;
  }
  const out: ManagedModel[] = [];
  for (const item of value) {
    const model = validateManagedModel(item);
    if (model === null) {
      continue;
    }
    out.push(model);
  }
  if (value.length > 0 && out.length === 0) {
    return null;
  }
  return out;
}

const MAX_MILLI_CREDITS = 1_000_000_000_000_000;
const MAX_CYCLE_ID_LENGTH = 200;

function asMilliCredits(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_MILLI_CREDITS) {
    return undefined;
  }
  return value;
}

function asCycleId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  const s = asBoundedString(value, MAX_CYCLE_ID_LENGTH);
  return s === undefined ? undefined : s;
}

function asEpochMs(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/**
 * Validates an individual credit bucket object. Missing fields normalize to
 * null (older backends may omit newer buckets); present-but-malformed
 * fields fail the whole object closed. Never computes or combines balances.
 */
export function validateIndividualCredits(value: unknown): ManagedIndividualCredits | null {
  if (!isRecord(value)) {
    return null;
  }
  const monthlyGrantMilli = asMilliCredits(value['monthlyGrantMilli']);
  const monthlyRemainingMilli = asMilliCredits(value['monthlyRemainingMilli']);
  const rolloverRemainingMilli = asMilliCredits(value['rolloverRemainingMilli']);
  const topupRemainingMilli = asMilliCredits(value['topupRemainingMilli']);
  const reservedMilli = asMilliCredits(value['reservedMilli']);
  const totalAvailableMilli = asMilliCredits(value['totalAvailableMilli']);
  const cycleId = asCycleId(value['cycleId']);
  const cycleEndsAtMs = asEpochMs(value['cycleEndsAtMs']);
  if (
    monthlyGrantMilli === undefined ||
    monthlyRemainingMilli === undefined ||
    rolloverRemainingMilli === undefined ||
    topupRemainingMilli === undefined ||
    reservedMilli === undefined ||
    totalAvailableMilli === undefined ||
    cycleId === undefined ||
    cycleEndsAtMs === undefined
  ) {
    return null;
  }
  return {
    monthlyGrantMilli,
    monthlyRemainingMilli,
    rolloverRemainingMilli,
    topupRemainingMilli,
    reservedMilli,
    totalAvailableMilli,
    cycleId,
    cycleEndsAtMs,
  };
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
  const source = validateManagedPolicySource(body['source']);
  if (source === null) {
    return null;
  }
  const quotaMode = validateQuotaMode(body['quotaMode']);
  if (quotaMode === null) {
    return null;
  }
  // Individual branch: credit-mode payload carries no token limit.
  if (quotaMode === 'individual_credits') {
    if (body['period'] !== 'calendar_month') {
      return null;
    }
    const rawCredits = body['credits'];
    if (rawCredits !== undefined && rawCredits !== null && !isRecord(rawCredits)) {
      return null;
    }
    const credits = rawCredits == null
      ? null
      : validateIndividualCredits(rawCredits);
    if (rawCredits != null && credits === null) {
      return null;
    }
    // No monthlyTokenLimit authority for individuals; a token limit on a
    // credit-mode payload is a contract violation, not a fallback.
    if (body['monthlyTokenLimit'] !== undefined && body['monthlyTokenLimit'] !== null) {
      return null;
    }
    return {
      configured: body['configured'] === true,
      monthlyTokenLimit: null,
      period: 'calendar_month',
      ...(source ? { source } : {}),
      quotaMode: 'individual_credits' as const,
      credits,
      ...(asBoundedString(body['code'], 64) ? { code: asBoundedString(body['code'], 64) } : {}),
    };
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
    return {
      configured: true,
      monthlyTokenLimit: limit,
      period: 'calendar_month',
      ...(source ? { source } : {}),
      ...(quotaMode ? { quotaMode } : {}),
    };
  }
  if (body['monthlyTokenLimit'] !== null) {
    return null;
  }
  return {
    configured: false,
    monthlyTokenLimit: null,
    period: 'calendar_month',
    ...(source ? { source } : {}),
    ...(quotaMode ? { quotaMode } : {}),
  };
}

/** Canonical not-configured monthly limit snapshot. */
export function emptyMonthlyLimit(): ManagedMonthlyLimit {
  return { configured: false, monthlyTokenLimit: null, period: 'calendar_month' };
}

/** Canonical idle usage/capability snapshot (fail closed: not available). */
export function idleManagedUsage(): ManagedUsageState {
  return { status: 'idle', chatAvailable: false };
}

/** Canonical idle managed session (memory only). */
export function idleManagedSession(): ManagedSessionState {
  return {
    status: 'idle',
    models: [],
    monthlyLimit: emptyMonthlyLimit(),
    usage: idleManagedUsage(),
    agentFileCapability: 'none',
  };
}

function asNonNegativeInt(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    return undefined;
  }
  return value;
}

function asPeriod(value: unknown): string | undefined {
  // Backend period format is YYYY-MM. Anything else fails closed.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * Validates the inner `usage` object of GET /managed/usage (Phase 9C.1).
 * Server fields are used directly — usedTokens is never derived as
 * limit-minus-remaining. Unknown fields are ignored (never projected).
 *
 * School branch requires the token shape exactly as before. Individual
 * branch (`quotaMode: 'individual_credits'`) carries `credits` instead and
 * never token fields.
 */
export function validateManagedUsage(value: unknown): ManagedUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const quotaMode = validateQuotaMode(value['quotaMode']);
  if (quotaMode === null) {
    return null;
  }
  if (quotaMode === 'individual_credits') {
    const rawCredits = value['credits'];
    if (rawCredits !== undefined && rawCredits !== null && !isRecord(rawCredits)) {
      return null;
    }
    const credits = rawCredits == null ? null : validateIndividualCredits(rawCredits);
    if (rawCredits != null && credits === null) {
      return null;
    }
    // Token fields on a credit-mode payload are a contract violation.
    for (const key of ['configured', 'period', 'monthlyTokenLimit', 'usedTokens', 'remainingTokens']) {
      if (value[key] !== undefined && value[key] !== null) {
        return null;
      }
    }
    return { quotaMode: 'individual_credits', configured: credits !== null, credits };
  }
  if (typeof value['configured'] !== 'boolean') {
    return null;
  }
  const period = asPeriod(value['period']);
  if (period === undefined) {
    return null;
  }
  const usedTokens = asNonNegativeInt(value['usedTokens'], MANAGED_HARD_MAX_MONTHLY_TOKENS * 12);
  if (usedTokens === undefined) {
    return null;
  }
  if (value['configured'] === true) {
    const monthlyTokenLimit = asNonNegativeInt(value['monthlyTokenLimit'], MANAGED_HARD_MAX_MONTHLY_TOKENS);
    if (monthlyTokenLimit === undefined) {
      return null;
    }
    const rawRemaining = value['remainingTokens'];
    const remainingTokens =
      rawRemaining === null ? null : asNonNegativeInt(rawRemaining, MANAGED_HARD_MAX_MONTHLY_TOKENS);
    if (remainingTokens === undefined) {
      return null;
    }
    return {
      configured: true,
      period,
      monthlyTokenLimit,
      usedTokens,
      remainingTokens,
      ...(quotaMode ? { quotaMode } : {}),
    };
  }
  if (value['monthlyTokenLimit'] !== null || value['remainingTokens'] !== null) {
    return null;
  }
  return {
    configured: false,
    period,
    monthlyTokenLimit: null,
    usedTokens,
    remainingTokens: null,
    ...(quotaMode ? { quotaMode } : {}),
  };
}

/**
 * Validates the full GET /managed/usage envelope (Phase 9C.1).
 * Missing `chatAvailable` (pre-9B.2A backend) fails closed to false.
 * Unknown fields (uid, mode, testUids, reservations, …) are dropped.
 *
 * School branch carries a nested `usage` token object. Individual branch
 * (`quotaMode: 'individual_credits'`) carries top-level `credits` instead —
 * there is no `usage` key on that envelope.
 */
export type ManagedUsageResponse =
  | { allowed: true; quotaMode?: ManagedQuotaMode; usage: ManagedUsage; chatAvailable: boolean }
  | { allowed: false; code: string; chatAvailable: false };

export function validateUsageResponse(body: unknown): ManagedUsageResponse | null {
  if (!isRecord(body) || typeof body['allowed'] !== 'boolean') {
    return null;
  }
  if (body['allowed'] === false) {
    const code = asBoundedString(body['code'], 64) ?? 'SUBI_ACCESS_DISABLED';
    return { allowed: false, code, chatAvailable: false };
  }
  const quotaMode = validateQuotaMode(body['quotaMode']);
  if (quotaMode === null) {
    return null;
  }
  const rawAvailable = body['chatAvailable'];
  const chatAvailable = rawAvailable === undefined ? false : rawAvailable === true;
  if (quotaMode === 'individual_credits') {
    const rawCredits = body['credits'];
    if (rawCredits !== undefined && rawCredits !== null && !isRecord(rawCredits)) {
      return null;
    }
    const credits = rawCredits == null ? null : validateIndividualCredits(rawCredits);
    if (rawCredits != null && credits === null) {
      return null;
    }
    if (body['usage'] !== undefined && body['usage'] !== null) {
      return null;
    }
    return {
      allowed: true,
      quotaMode: 'individual_credits',
      usage: { quotaMode: 'individual_credits', configured: credits !== null, credits },
      chatAvailable,
    };
  }
  const usage = validateManagedUsage(body['usage']);
  if (usage === null) {
    return null;
  }
  return {
    allowed: true,
    ...(quotaMode ? { quotaMode } : {}),
    usage,
    chatAvailable,
  };
}

/**
 * Validates GET /managed/subicode-status. Single-plan SUBI: `tier` must be
 * null or absent — any other value rejects the payload (no Basic/Plus/Pro
 * is ever exposed or consumed).
 */
export function validateSubiCodeStatus(body: unknown): SubiCodeStatus | null {
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body['active'] !== 'boolean') {
    return null;
  }
  if (body['tier'] !== undefined && body['tier'] !== null) {
    return null;
  }
  const renewalDateMs = asEpochMs(body['renewalDateMs']);
  if (renewalDateMs === undefined) {
    return null;
  }
  const source = body['source'];
  if (source !== 'individual_subscription' && source !== 'school_default') {
    return null;
  }
  const quotaMode = validateQuotaMode(body['quotaMode']);
  if (quotaMode === null) {
    return null;
  }
  const out: SubiCodeStatus = {
    active: body['active'],
    tier: null,
    renewalDateMs,
    source,
  };
  if (quotaMode !== undefined) {
    out.quotaMode = quotaMode;
  }
  if (body['active'] === false) {
    const code = asBoundedString(body['code'], 64);
    if (code === undefined && body['code'] !== undefined) {
      return null;
    }
    if (code !== undefined) {
      out.code = code;
    }
  }
  return out;
}
