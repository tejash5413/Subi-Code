// functions-subi/src/utils/redact.js
// Error normalization + log redaction (Phase 2A).
// HTTP responses carry safe codes only. Server logs carry categories only.
// Key material, tokens, payloads and upstream bodies must never be logged.

const SAFE_CODES = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "INVALID_AI_CREDENTIAL",
  "ALREADY_CONFIGURED",
  "NOT_CONFIGURED",
  "NO_ROLLBACK_VERSION",
  "AI_NOT_CONFIGURED",
  "SECRET_UNAVAILABLE",
  "AI_VALIDATION_UNAVAILABLE",
  "AI_VALIDATION_FAILED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_INVALID",
  "DUPLICATE_MODEL",
  // Managed chat gateway (Phase 8). Policy denials first, then provider
  // mapping. No raw upstream bodies, keys, or model IDs ever leave as codes.
  "SUBI_ACCESS_DISABLED",
  "SUBI_ACCESS_UNAVAILABLE",
  "MODEL_NOT_ALLOWED",
  "MODEL_NOT_AVAILABLE",
  "MONTHLY_LIMIT_NOT_CONFIGURED",
  "MONTHLY_LIMIT_EXCEEDED",
  "MONTHLY_LIMIT_EXHAUSTED",
  "CREDIT_EXHAUSTED",
  "AI_CONNECTION_UNAVAILABLE",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "AGENT_INVALID_TOOL_CALL",
  "REQUEST_TOO_LARGE",
  "CANCELLED",
  "TIMEOUT",
  // Phase 9A quota/idempotency denials. Never carry amounts, ids, or policy.
  "REQUEST_IN_PROGRESS",
  "REQUEST_ALREADY_PROCESSED",
  "TOO_MANY_ACTIVE_REQUESTS",
  // Individual credit wallet denials (credit-quota safety phase). Same
  // conventions: usage/entitlement failures are client-visible, pricing
  // internals stay INTERNAL.
  "INSUFFICIENT_CREDITS",
  "CREDITS_NOT_CONFIGURED",
  "SUBI_PLAN_EXPIRED",
  "CREDIT_RESERVATION_NOT_FOUND",
  "CREDIT_REQUEST_IN_PROGRESS",
  "CREDIT_REQUEST_ALREADY_PROCESSED",
  // Credit-cycle engine denials (grant path only, never school).
  "SUBI_CODE_REQUIRED",
  "FX_UNAVAILABLE",
  // Cutover hardening: unknown account type never coerces to school.
  "ACCOUNT_TYPE_UNSUPPORTED",
  // Individual SUBI billing (quote/order/webhook paths only, never school).
  "SUBI_QUOTE_INVALID",
  "SUBI_QUOTE_EXPIRED",
  "SUBI_RETURN_ORIGIN_REJECTED",
  "SUBI_TOPUP_PACK_INVALID",
  "SUBI_TOPUP_QUOTE_FAILED",
  "SUBI_BILLING_UNAVAILABLE",
  "SUBI_WRONG_ACCOUNT_TYPE",
  "SUBI_UNKNOWN_USER",
  "SUBI_NO_PAID_PERIOD",
  "SUBI_WEBHOOK_UNAUTHORIZED",
  // Unified assignment: optimistic-concurrency guard for school/individual
  // policy saves (stale-tab overwrite protection). No ids or policy.
  "POLICY_CONFLICT",
  // Unified assignment identity diagnostics (counts/reasons only server-side;
  // client shows concise text). Never carry ids, keys, or policy content.
  "UNKNOWN_MODEL_KEY",
  "UNKNOWN_CATALOGUE_MODEL",
  // Phase 9A.1 managed-chat operational gate. No config internals leak.
  "MANAGED_CHAT_DISABLED",
  // Phase 9B.1A: durable accounting could not be finalized. The client may
  // see this only after provider-risk exposure; the durable reservation
  // state stays recoverable via TTL sweep. Never silently swallowed.
  "ACCOUNTING_UNAVAILABLE",
  // Phase 13 managed agent gateway. No raw upstream bodies/keys/model IDs.
  "MANAGED_AGENT_DISABLED",
  // Phase 18 certification: backend-proxied web search. No query text,
  // results, keys, or tokens ever leave as codes.
  "WEB_SEARCH_UNAVAILABLE",
  "AGENT_UNSUPPORTED_MODEL",
  "IMAGE_INPUT_UNAVAILABLE",
  // Phase 16 production: model explicitly marked terminal-incompatible.
  "MODEL_TERMINAL_UNSUPPORTED",
  // Phase 17: model explicitly marked verify-incompatible, or unknown in production.
  "MODEL_VERIFY_UNSUPPORTED",
  "AGENT_BUILD_LOCKED",
  "INTERNAL",
]);

const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "secret",
  "payload",
  "token",
]);

function safeCode(code) {
  return SAFE_CODES.has(code) ? code : "INTERNAL";
}

function statusFor(code) {
  switch (safeCode(code)) {
    case "UNAUTHENTICATED":
    case "SUBI_WEBHOOK_UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "INVALID_REQUEST":
    case "INVALID_AI_CREDENTIAL":
    case "SUBI_QUOTE_INVALID":
    case "SUBI_QUOTE_EXPIRED":
    case "SUBI_RETURN_ORIGIN_REJECTED":
    case "SUBI_TOPUP_PACK_INVALID":
      return 400;
    case "ALREADY_CONFIGURED":
    case "NO_ROLLBACK_VERSION":
      return 409;
    case "AI_NOT_CONFIGURED":
    case "WEB_SEARCH_UNAVAILABLE":
    case "SECRET_UNAVAILABLE":
    case "AI_VALIDATION_FAILED":
    case "UPSTREAM_UNAVAILABLE":
    case "SUBI_ACCESS_UNAVAILABLE":
    case "AI_CONNECTION_UNAVAILABLE":
    case "ACCOUNTING_UNAVAILABLE":
    case "FX_UNAVAILABLE":
    case "SUBI_BILLING_UNAVAILABLE":
    case "SUBI_NO_PAID_PERIOD":
    case "SUBI_TOPUP_QUOTE_FAILED":
      return 503;
    case "MODEL_NOT_AVAILABLE":
      return 404;
    case "SUBI_ACCESS_DISABLED":
    case "MODEL_NOT_ALLOWED":
    case "MONTHLY_LIMIT_NOT_CONFIGURED":
    case "MONTHLY_LIMIT_EXCEEDED":
    case "MONTHLY_LIMIT_EXHAUSTED":
    case "CREDITS_NOT_CONFIGURED":
    case "SUBI_PLAN_EXPIRED":
    case "SUBI_CODE_REQUIRED":
    case "ACCOUNT_TYPE_UNSUPPORTED":
    case "SUBI_WRONG_ACCOUNT_TYPE":
    case "SUBI_UNKNOWN_USER":
    case "MANAGED_CHAT_DISABLED":
      return 403;
    case "INSUFFICIENT_CREDITS":
    case "CREDIT_EXHAUSTED":
      return 402;
    case "MANAGED_AGENT_DISABLED":
    case "AGENT_UNSUPPORTED_MODEL":
    case "IMAGE_INPUT_UNAVAILABLE":
    case "MODEL_TERMINAL_UNSUPPORTED":
    case "MODEL_VERIFY_UNSUPPORTED":
    case "AGENT_BUILD_LOCKED":
      return 403;
    case "PROVIDER_AUTH_FAILED":
    case "PROVIDER_UNAVAILABLE":
    case "AGENT_INVALID_TOOL_CALL":
      return 502;
    case "PROVIDER_RATE_LIMITED":
      return 429;
    case "REQUEST_TOO_LARGE":
      return 413;
    case "REQUEST_IN_PROGRESS":
    case "REQUEST_ALREADY_PROCESSED":
    case "CREDIT_REQUEST_IN_PROGRESS":
    case "CREDIT_REQUEST_ALREADY_PROCESSED":
    case "POLICY_CONFLICT":
      return 409;
    case "CREDIT_RESERVATION_NOT_FOUND":
      return 404;
    case "UNKNOWN_MODEL_KEY":
    case "UNKNOWN_CATALOGUE_MODEL":
      return 400;
    case "TOO_MANY_ACTIVE_REQUESTS":
      return 429;
    case "AI_VALIDATION_UNAVAILABLE":
    case "UPSTREAM_INVALID":
      return 502;
    case "DUPLICATE_MODEL":
      return 409;
    case "UPSTREAM_TIMEOUT":
    case "TIMEOUT":
      return 504;
    default:
      return 500;
  }
}

// Normalized HTTP error body. Never includes details.
function errorBody(code) {
  const c = safeCode(code);
  return { error: { code: c } };
}

// Minimal safe server log line: action + admin + category + status.
function logEvent(action, fields) {
  const safe = { action };
  if (fields && typeof fields === "object") {
    if (fields.adminUid !== undefined) safe.adminUid = String(fields.adminUid).slice(0, 128);
    if (fields.code !== undefined) safe.code = safeCode(String(fields.code));
    if (fields.status !== undefined) safe.status = Number(fields.status) || 0;
    if (fields.version !== undefined && /^\d+$/.test(String(fields.version))) {
      safe.version = String(fields.version);
    }
  }
  console.error(`[subi] ${JSON.stringify(safe)}`);
}

// Deep-strip sensitive keys for any object that might reach logs.
function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(String(k).toLowerCase()) ? "[redacted]" : stripSensitive(v);
    }
    return out;
  }
  return value;
}

module.exports = { safeCode, statusFor, errorBody, logEvent, stripSensitive, safeCodes: Object.freeze([...SAFE_CODES]) };
