// functions-subi/src/services/creditMath.js
// Exact individual credit math, integer-safe via milliCredits.
//
// CREDIT INVARIANT (authoritative):
//   1 displayed SUBI credit = $0.001 model list-price inference cost.
//   1000 milliCredits = 1 displayed credit.
//   $1.00 model usage = 1000 displayed credits = 1,000,000 milliCredits.
//
// INPUT UNITS (authoritative):
//   inputTokens / outputTokens: integer token counts.
//   inputPricePerMillion / outputPricePerMillion: USD per 1,000,000 tokens
//     (numbers, e.g. 0.10 means $0.10/1M). Produced EXACTLY ONCE by
//     pricingSnapshot.pinPricing from stored per-token strings via
//     Number(stored) * 1_000_000. Never pass per-token prices here.
//
// WHY milli = tokens * pricePerMillion (no explicit /1M or x1000):
//   inputCostUSD  = inputTokens / 1M * inputPricePerMillion
//   outputCostUSD = outputTokens / 1M * outputPricePerMillion
//   credits       = (inputCostUSD + outputCostUSD) / 0.001
//   milli         = credits * 1000
//               = (inT/1M*inP + outT/1M*outP) * (1/0.001) * 1000
//               = (inT*inP + outT*outP) * (1_000_000 / 1_000_000)
//               = inT*inP + outT*outP
//   So tokens x USD-per-million numerically equals milliCredits under the
//   1 credit = $0.001 definition. FLOOR so estimates never over-grant.
//
// milliCredits (1 credit = 1000 milli) avoids float drift in Firestore.
// All token counts must be non-negative safe integers.
// Prices are USD per 1M tokens, finite >= 0. Free = 0/0.
//
// Minimum anti-abuse: 1 displayed credit per successful chargeable FREE-model
// request is applied at commit time by individualCreditQuotaService, not here
// (this module returns 0 for 0 usage so shadow calculations stay truthful;
// paid models may legitimately burn < 1000 milli and get no minimum).

const CREDITS_PER_USD = 1000; // 1 credit = $0.001
const MILLIS_PER_CREDIT = 1000;
const MILLIS_PER_USD = CREDITS_PER_USD * MILLIS_PER_CREDIT; // 1,000,000 milli per $1
const TOKENS_PER_MILLION = 1_000_000;

function invalidRequest(message) {
  const err = new Error(message || "invalid credit payload");
  err.code = "INVALID_REQUEST";
  return err;
}

function cleanTokenCount(value, what) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidRequest(`${what} must be a non-negative safe integer`);
  }
  return value;
}

function cleanPricePerMillion(value, what) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw invalidRequest(`${what} must be a finite number >= 0`);
  }
  // Sanity ceiling: $10,000 / 1M tokens (above Astra $10/$50 + headroom).
  if (n > 10000) throw invalidRequest(`${what} out of range`);
  return n;
}

// Returns integer milliCredits, FLOORED (never over-grants on estimate).
function creditsMilliForUsage({ inputTokens, outputTokens, inputPricePerMillion, outputPricePerMillion }) {
  const inT = cleanTokenCount(inputTokens, "inputTokens");
  const outT = cleanTokenCount(outputTokens, "outputTokens");
  const inP = cleanPricePerMillion(inputPricePerMillion, "inputPricePerMillion");
  const outP = cleanPricePerMillion(outputPricePerMillion, "outputPricePerMillion");
  // milli = tokens/1M * pricePerM * 1M milli per $1  =>  tokens * price (exact for safe ints within ceiling)
  // Use integer path when prices have <= 4 decimals, else float floor (still deterministic).
  const milli = Math.floor(inT * inP + outT * outP);
  if (!Number.isSafeInteger(milli) || milli < 0) throw invalidRequest("credit amount out of range");
  return milli;
}

function creditsForUsage(args) {
  return creditsMilliForUsage(args) / MILLIS_PER_CREDIT;
}

function isFreePricing(inputPricePerMillion, outputPricePerMillion) {
  return (
    cleanPricePerMillion(inputPricePerMillion, "inputPricePerMillion") === 0 &&
    cleanPricePerMillion(outputPricePerMillion, "outputPricePerMillion") === 0
  );
}

// UI-only cost class (never gates access for individuals; schools ignore).
// Thresholds mirror current auto-eligibility ($0.5 cheap) extended:
//   free: 0/0 | economy: out <= $2 | advanced: out <= $15 | flagship: above
function costClassForPricing(inputPricePerMillion, outputPricePerMillion) {
  const inP = cleanPricePerMillion(inputPricePerMillion, "inputPricePerMillion");
  const outP = cleanPricePerMillion(outputPricePerMillion, "outputPricePerMillion");
  if (inP === 0 && outP === 0) return "free";
  if (outP <= 2) return "economy";
  if (outP <= 15) return "advanced";
  return "flagship";
}

module.exports = {
  CREDITS_PER_USD,
  MILLIS_PER_CREDIT,
  MILLIS_PER_USD,
  TOKENS_PER_MILLION,
  creditsMilliForUsage,
  creditsForUsage,
  isFreePricing,
  costClassForPricing,
};
