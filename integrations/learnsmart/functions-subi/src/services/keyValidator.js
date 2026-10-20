// functions-subi/src/services/keyValidator.js
// Transient API-key validation (Phase 2A). Shape checks are sanity only;
// AUTHORITATIVE validation is the authenticated OpenRouter request.
// Never logs the key or the upstream response body.

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_KEY_LENGTH = 512;

function hasControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(value);
}

// Preliminary shape check. NOT proof of validity. Returns { ok } or
// { ok:false, code } with safe codes only (never echoes input).
function checkKeyShape(value) {
  if (typeof value !== "string") return { ok: false, code: "INVALID_REQUEST" };
  const key = value.trim();
  if (!key) return { ok: false, code: "INVALID_REQUEST" };
  if (key.length > MAX_KEY_LENGTH) return { ok: false, code: "INVALID_REQUEST" };
  if (hasControlChars(key)) return { ok: false, code: "INVALID_REQUEST" };
  return { ok: true, key };
}

// Authoritative check: read-only OpenRouter metadata endpoint. 200 proves
// the credential; 401/403 proves it is invalid; anything else (network,
// 5xx, timeout) is treated as validation-unavailable, never as valid.
async function validateWithOpenRouter(transientKey, fetchImpl) {
  const impl = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const res = await impl(OPENROUTER_KEY_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${transientKey}` },
      signal: controller.signal,
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: "INVALID_AI_CREDENTIAL" };
    }
    return { ok: false, code: "AI_VALIDATION_UNAVAILABLE" };
  } catch (_) {
    return { ok: false, code: "AI_VALIDATION_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkKeyShape, validateWithOpenRouter, MAX_KEY_LENGTH };
