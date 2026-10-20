// functions-subi/src/services/pricingSnapshot.js
// Pricing-unit normalization + reservation pinning (single conversion point).
// Pins model pricing at reservation time so credit burn is auditable and
// immune to mid-request catalog price moves.
//
// AUTHORITATIVE UNITS (do not change without a migration):
// - STORED form (input): OpenRouter/model-registry per-TOKEN price.
//   modelCatalogService.cleanPrice and approvedModelService.cleanPricing keep
//   the exact upstream per-token string, e.g. "0.0000001" means $0.0000001
//   per token == $0.10 per 1M tokens. See autoEligibleModelService
//   .priceToPerMillion for the same per-token -> per-1M mapping.
// - NORMALIZED form (output): USD per 1,000,000 tokens (number), e.g. 0.10.
//   creditMath.creditsMilliForUsage REQUIRES this normalized per-1M form.
//   Conversion happens EXACTLY ONCE, here:
//     inputUsdPerMillion  = Number(pricing.input)  * 1_000_000
//     outputUsdPerMillion = Number(pricing.output) * 1_000_000
//   Never pre-convert before calling pinPricing, and never multiply the
//   output again. Callers pass stored pricing through untouched; only this
//   module multiplies by TOKENS_PER_MILLION.
//
// Output: {
//   inputPricePerMillion, outputPricePerMillion (canonical for creditMath),
//   inputUsdPerMillion, outputUsdPerMillion (spec aliases, same numbers),
//   priceVersion, costClass, isFree, capturedAtMs, modelKey
// }
//
// priceVersion = `v1:<input>x<output>` (exact STORED strings, not normalized
// numbers) so the pinned version identifies the catalog row that was live at
// reserve time. If either side is null/invalid -> throws INVALID_REQUEST
// (fail closed for individuals).
// Schools never call this (token quota ignores pricing).

const { costClassForPricing } = require("./creditMath");

const TOKENS_PER_MILLION = 1_000_000;
// Sanity ceiling on NORMALIZED USD/1M (above $10/$50 flagship + headroom).
const MAX_USD_PER_MILLION = 10000;

function perTokenToPerMillion(value, what) {
  const raw = typeof value === "string" ? Number(value) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    const err = new Error(`${what} must be a finite per-token number >= 0`);
    err.code = "INVALID_REQUEST";
    throw err;
  }
  // Float hygiene: 0.0000001 * 1e6 is 0.09999999999999999 in binary floating
  // point, not 0.1. Round the normalized USD/1M to 6 decimals (micro-dollar;
  // $0.000001/1M resolution) so catalog strings map to exact expected prices
  // and downstream milli math (floor) stays deterministic at boundaries.
  const perMillion = Math.round(raw * TOKENS_PER_MILLION * 1e6) / 1e6;
  if (!Number.isFinite(perMillion) || perMillion < 0 || perMillion > MAX_USD_PER_MILLION) {
    const err = new Error(`${what} out of range after per-token -> per-1M conversion`);
    err.code = "INVALID_REQUEST";
    throw err;
  }
  return perMillion;
}

function pinPricing({ pricing, modelKey } = {}) {
  const src = (pricing && typeof pricing === "object") ? pricing : {};
  // Single conversion point: stored per-token -> normalized USD/1M.
  const inP = perTokenToPerMillion(src.input, "pricing.input");
  const outP = perTokenToPerMillion(src.output, "pricing.output");
  const priceVersion = `v1:${String(src.input)}x${String(src.output)}`;
  const costClass = costClassForPricing(inP, outP);
  const isFree = inP === 0 && outP === 0;
  return {
    modelKey: String(modelKey || "").slice(0, 128),
    inputPricePerMillion: inP,
    outputPricePerMillion: outP,
    // Spec-preferred aliases (identical numbers, no second conversion).
    inputUsdPerMillion: inP,
    outputUsdPerMillion: outP,
    priceVersion: priceVersion.slice(0, 64),
    costClass,
    isFree,
    capturedAtMs: Date.now(),
  };
}

module.exports = { pinPricing, perTokenToPerMillion, TOKENS_PER_MILLION, MAX_USD_PER_MILLION };
