// functions-subi/src/services/individualCreditEconomics.js
// Phase 1 foundation (pure config + math, NO store writes, NO behavior change).
// Individual-only economics for ₹499 + GST product.
//
//   priceINR = 499 (GST extra at checkout, never included in AI budget)
//   targetAiGrossBufferINR = 50
//   availableForAIINR = 499 - 50 = 449
//   costPerCreditINR = fxRate * providerFundingMultiplier * 0.001
//   rawCredits = availableForAIINR / costPerCreditINR
//   monthlyGrant = FLOOR(rawCredits / 50) * 50
//
// providerFundingMultiplier covers OpenRouter 5.5% top-up fee + gateway ~2%
// + buffer. Default 1.10. At fx 90: costPerCredit = 0.099 -> grant ~4535 -> 4500.
// At fx 83: ~4900. Spec example ~4,400 at higher fx/fees — dynamic, never hard-coded.
//
// Top-ups (individual only): topupMarginPct = 25%
//   availableForAI = packINR * (1 - 0.25)
//   credits = FLOOR(availableForAI / costPerCreditINR)
// Quote locked at order creation; webhook grants exact quoted amount.
//
// Rollover: 80% of unused FRESH monthly credits, one extra cycle only.
// Top-up + previous rollover never roll again. School tokens never roll here.

const PRICE_INR = 499;
const TARGET_AI_GROSS_BUFFER_INR = 50;
const PROVIDER_FUNDING_MULTIPLIER = 1.10;
const ROLLOVER_PCT = 0.8;
const TOPUP_MARGIN_PCT = 0.25;
const GRANT_ROUND_STEP = 50;
const MIN_GRANT_CREDITS = 500;

function invalidRequest(message) {
  const err = new Error(message || "invalid economics payload");
  err.code = "INVALID_REQUEST";
  return err;
}

function cleanFx(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 40 || n > 200) {
    throw invalidRequest("fxRate must be finite 40..200");
  }
  return n;
}

function costPerCreditINR(fxRate, providerFundingMultiplier = PROVIDER_FUNDING_MULTIPLIER) {
  const fx = cleanFx(fxRate);
  const m = Number(providerFundingMultiplier);
  if (!Number.isFinite(m) || m < 1 || m > 3) throw invalidRequest("providerFundingMultiplier must be 1..3");
  return fx * m * 0.001;
}

function monthlyGrantCredits({ fxRate, priceINR = PRICE_INR, bufferINR = TARGET_AI_GROSS_BUFFER_INR, providerFundingMultiplier = PROVIDER_FUNDING_MULTIPLIER } = {}) {
  const fx = cleanFx(fxRate);
  if (priceINR <= bufferINR) throw invalidRequest("price must exceed buffer");
  const available = priceINR - bufferINR;
  const perCredit = costPerCreditINR(fx, providerFundingMultiplier);
  const raw = available / perCredit;
  const grant = Math.floor(raw / GRANT_ROUND_STEP) * GRANT_ROUND_STEP;
  if (!Number.isSafeInteger(grant) || grant < MIN_GRANT_CREDITS) throw invalidRequest("grant out of range");
  return {
    monthlyGrant: grant,
    rawCredits: raw,
    availableForAIINR: available,
    costPerCreditINR: perCredit,
    economicsSnapshot: {
      priceINR, bufferINR, providerFundingMultiplier, fxRate: fx,
    },
  };
}

function topupQuoteCredits({ packINR, fxRate, providerFundingMultiplier = PROVIDER_FUNDING_MULTIPLIER, marginPct = TOPUP_MARGIN_PCT } = {}) {
  const fx = cleanFx(fxRate);
  const pack = Number(packINR);
  if (!Number.isFinite(pack) || pack <= 0 || pack > 100000) throw invalidRequest("packINR out of range");
  if (marginPct < 0 || marginPct >= 1) throw invalidRequest("marginPct must be 0..<1");
  const available = pack * (1 - marginPct);
  const perCredit = costPerCreditINR(fx, providerFundingMultiplier);
  const credits = Math.floor(available / perCredit);
  if (!Number.isSafeInteger(credits) || credits <= 0) throw invalidRequest("topup credits out of range");
  return { credits, availableForAIINR: available, costPerCreditINR: perCredit };
}

function rolloverCredits({ monthlyGrant, freshUsed }) {
  const g = Number(monthlyGrant);
  const u = Number(freshUsed);
  if (!Number.isSafeInteger(g) || g < 0 || !Number.isSafeInteger(u) || u < 0 || u > g) {
    throw invalidRequest("invalid grant/used for rollover");
  }
  return Math.floor((g - u) * ROLLOVER_PCT);
}

module.exports = {
  PRICE_INR,
  TARGET_AI_GROSS_BUFFER_INR,
  PROVIDER_FUNDING_MULTIPLIER,
  ROLLOVER_PCT,
  TOPUP_MARGIN_PCT,
  GRANT_ROUND_STEP,
  costPerCreditINR,
  monthlyGrantCredits,
  topupQuoteCredits,
  rolloverCredits,
};
