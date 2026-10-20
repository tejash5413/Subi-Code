// functions-subi/src/utils/structuredLogger.js
// Phase 9B.1A observability: structured Cloud Logging for Gen-2.
//
// BANNED FIELDS (never log, never include in metadata):
//   prompt, message content, assistant completion, SSE deltas
//   Firebase ID token, refresh token, Authorization header
//   OpenRouter API key, raw secret, secret payload
//   upstreamModelId, raw provider request body, raw provider response body
//
// Allowed: requestIdHash (sha256), period, modelKey, stage, safeCode,
// retryAttempt, providerAccepted boolean, accountingOutcome, durationMs,
// reservationId, stage, attempt count. Anything else must be vetted.
//
// Failure mode: if the logger throws, this module MUST NOT propagate the
// error to the caller. Observability must never affect accounting.

const crypto = require("crypto");

const BANNED_KEYS = new Set([
  "prompt", "prompts", "message", "messages", "content", "completion",
  "delta", "deltas", "text", "assistant", "user",
  "authorization", "idtoken", "id_token", "refreshtoken", "refresh_token",
  "apikey", "api_key", "secret", "secrets", "key",
  "upstreammodelid", "upstream_model_id", "openrouter", "openrouterresponse",
  "rawprovider", "providerresponse", "providerbody",
]);

// requestId is allowed as requestIdHash only. Caller must pre-hash.
function hashRequestId(requestId) {
  try {
    return crypto.createHash("sha256")
      .update(String(requestId || ""), "utf8")
      .digest("hex")
      .slice(0, 32);
  } catch (_) {
    return "unknown";
  }
}

function sanitizeFields(input) {
  const safe = {};
  if (!input || typeof input !== "object") return safe;
  for (const [k, v] of Object.entries(input)) {
    const key = String(k);
    if (BANNED_KEYS.has(key.toLowerCase())) continue;
    if (key.toLowerCase().includes("secret")) continue;
    if (key.toLowerCase().includes("apikey")) continue;
    if (key.toLowerCase().includes("authorization")) continue;
    if (key.toLowerCase().includes("upstreammodel")) continue;
    if (key.toLowerCase().endsWith("modelid")) continue;
    if (typeof v === "string") {
      if (v.length > 256) safe[key] = v.slice(0, 256) + "…";
      else safe[key] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      safe[key] = v;
    } else if (v === null) {
      safe[key] = null;
    } else {
      try {
        safe[key] = String(v).slice(0, 256);
      } catch (_) {
        // skip non-stringifiable values
      }
    }
  }
  return safe;
}

let cachedLogger = null;
function getLogger() {
  if (cachedLogger !== null) return cachedLogger;
  try {
    // eslint-disable-next-line global-require
    cachedLogger = require("firebase-functions/logger");
  } catch (_) {
    cachedLogger = false; // explicit false = unavailable
  }
  return cachedLogger || null;
}

function emit(level, action, fields) {
  const logger = getLogger();
  if (!logger) return; // observability-only; never fail the call path
  const safe = sanitizeFields(fields || {});
  const data = Object.assign({ action }, safe);
  try {
    if (level === "error") logger.error(data);
    else if (level === "warn") logger.warn(data);
    else if (level === "debug") logger.debug(data);
    else logger.info(data);
  } catch (_) {
    // Never propagate logger failures.
  }
}

function info(action, fields) {
  emit("info", action, fields);
}
function warn(action, fields) {
  emit("warn", action, fields);
}
function error(action, fields) {
  emit("error", action, fields);
}
function debug(action, fields) {
  emit("debug", action, fields);
}

module.exports = {
  info,
  warn,
  error,
  debug,
  hashRequestId,
  sanitizeFields,
  BANNED_KEYS,
  _setLoggerForTests(logger) {
    cachedLogger = logger;
  },
  _resetLoggerForTests() {
    cachedLogger = null;
  },
};
