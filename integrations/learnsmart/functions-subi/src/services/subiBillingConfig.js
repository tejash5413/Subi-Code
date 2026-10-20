// functions-subi/src/services/subiBillingConfig.js
// Authoritative INDIVIDUAL SUBI commercial product (backend-owned).
// Single plan only: ₹499/month + 18% GST. No Basic/Plus/Pro.
//
// GST convention (mirrors functions/createCashfreeOrder + HomePurchase):
// integer rupees via Math.round — NO paise. So the charged total is
//   base 499 + gst round(499*0.18)=round(89.82)=90 → total 589,
// NOT 588.82. The frontend must display backend-quoted amounts, never its
// own GST math.
//
// This module is pure (no store). Quotes persist via subiPurchaseQuoteService.
//
// BOUNDARY: individual-only product constants. Never school pricing.

const PRODUCT_TYPE = "subi_subscription";
const BASE_AMOUNT_INR = 499;
const GST_RATE = 0.18;
const BILLING_MONTHS = 1;
const CURRENCY = "INR";
// Server quotes live 30 minutes; checkout must complete inside the window.
const QUOTE_TTL_MS = 30 * 60 * 1000;

// Canonical Cashfree return origin (product behavior: buyers return to the
// production purchase page). Extra origins come ONLY from the explicit
// SUBI_ALLOWED_RETURN_ORIGINS env allowlist (comma-separated exact origins).
const CANONICAL_RETURN_ORIGIN = "https://stlearnsmart.in";

function invalidOrigin(m) { const e = new Error(m || "return origin not allowed"); e.code = "SUBI_RETURN_ORIGIN_REJECTED"; return e; }

function parseAllowedReturnOrigins(raw) {
  return String(raw || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

// Exact-origin normalization: scheme + lowercased hostname + port (default
// ports collapse via URL). Rejects non-http(s), credentials in URL, garbage.
function normalizeSubiOrigin(origin) {
  let u;
  try {
    u = new URL(String(origin || "").trim());
  } catch (_) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (!u.hostname) return null;
  let out = `${u.protocol}//${u.hostname.toLowerCase()}`;
  if (u.port) out += `:${u.port}`;
  return out;
}

function isLocalhostOrigin(normalized) {
  return normalized === null ? false : /^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(normalized);
}

// Strict allowlist: canonical + explicitly configured origins only (exact
// match, never substring). Missing origin → canonical fallback. Anything
// else throws (fail closed). opts.allowedOrigins overrides env (tests).
// Localhost is accepted ONLY when explicitly configured, never by default.
function validateSubiReturnOrigin(origin, opts = {}) {
  if (origin === undefined || origin === null || String(origin).trim() === "") {
    return CANONICAL_RETURN_ORIGIN;
  }
  const rawExtra = opts.allowedOrigins !== undefined
    ? opts.allowedOrigins
    : parseAllowedReturnOrigins(process.env.SUBI_ALLOWED_RETURN_ORIGINS);
  const list = Array.isArray(rawExtra) ? rawExtra : parseAllowedReturnOrigins(rawExtra);
  const allowed = new Set(
    [CANONICAL_RETURN_ORIGIN, ...list.map(normalizeSubiOrigin).filter(Boolean)]
  );
  const norm = normalizeSubiOrigin(origin);
  if (norm && allowed.has(norm)) {
    if (isLocalhostOrigin(norm)) {
      const explicit = list.map(normalizeSubiOrigin);
      if (!explicit.includes(norm)) return CANONICAL_RETURN_ORIGIN;
    }
    return norm;
  }
  throw invalidOrigin(`return origin not allowed: ${String(origin).slice(0, 80)}`);
}

function invalidRequest(m) { const e = new Error(m || "invalid billing payload"); e.code = "INVALID_REQUEST"; return e; }

// Server-side quote math. The ONLY place ₹499+GST totals are computed.
// Returns integer-rupee amounts (Math.round, project convention).
function buildSubiQuoteAmounts({ baseAmountINR = BASE_AMOUNT_INR, gstRate = GST_RATE, billingMonths = BILLING_MONTHS } = {}) {
  const base = Math.round(Number(baseAmountINR));
  const rate = Number(gstRate);
  const months = Math.floor(Number(billingMonths));
  if (!Number.isSafeInteger(baseAmountINR) || base < 1 || base > 100000) {
    throw invalidRequest("subi base amount must be an integer 1..100000");
  }
  if (!(rate >= 0 && rate <= 1)) throw invalidRequest("gst rate out of range");
  if (rate !== GST_RATE) throw invalidRequest("subi gst rate must be 0.18");
  if (months !== BILLING_MONTHS) throw invalidRequest("subi billing must be 1 month");
  const gstAmountINR = Math.round(base * rate);
  return {
    product: "subi",
    productType: PRODUCT_TYPE,
    baseAmountINR: base,
    gstRate: rate,
    gstAmountINR,
    totalAmountINR: base + gstAmountINR,
    currency: CURRENCY,
    billingMonths: months,
  };
}

module.exports = {
  PRODUCT_TYPE,
  BASE_AMOUNT_INR,
  GST_RATE,
  BILLING_MONTHS,
  CURRENCY,
  QUOTE_TTL_MS,
  CANONICAL_RETURN_ORIGIN,
  buildSubiQuoteAmounts,
  parseAllowedReturnOrigins,
  normalizeSubiOrigin,
  validateSubiReturnOrigin,
};
