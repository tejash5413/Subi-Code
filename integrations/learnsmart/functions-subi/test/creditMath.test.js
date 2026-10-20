// functions-subi/test/creditMath.test.js — Phase 1 pure math (fakes only).
const test = require("node:test");
const assert = require("node:assert/strict");
const math = require("../src/services/creditMath");
const econ = require("../src/services/individualCreditEconomics");
const quotaMode = require("../src/services/quotaModeService");
const pricingSnap = require("../src/services/pricingSnapshot");

test("credits = (in+out cost)/0.001, floored milli", () => {
  // 1M in @ $2 + 1M out @ $10 = $12 -> 12,000 credits -> 12,000,000 milli
  assert.equal(math.creditsMilliForUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, inputPricePerMillion: 2, outputPricePerMillion: 10 }), 12_000_000);
  // Astra 1k in + 1k out @ $10/$50 = $0.06 -> 60 credits
  assert.equal(math.creditsForUsage({ inputTokens: 1000, outputTokens: 1000, inputPricePerMillion: 10, outputPricePerMillion: 50 }), 60);
  // free = 0
  assert.equal(math.creditsMilliForUsage({ inputTokens: 5000, outputTokens: 5000, inputPricePerMillion: 0, outputPricePerMillion: 0 }), 0);
});

test("cost classes for UI only", () => {
  assert.equal(math.costClassForPricing(0, 0), "free");
  assert.equal(math.costClassForPricing(0.3, 0.9), "economy");
  assert.equal(math.costClassForPricing(2, 10), "advanced");
  assert.equal(math.costClassForPricing(10, 50), "flagship");
});

test("monthly grant dynamic, rounded to 50, never hard-coded", () => {
  const a = econ.monthlyGrantCredits({ fxRate: 90 });
  const b = econ.monthlyGrantCredits({ fxRate: 83 });
  assert.ok(a.monthlyGrant % 50 === 0 && b.monthlyGrant % 50 === 0);
  assert.ok(b.monthlyGrant > a.monthlyGrant); // stronger INR -> more credits
  assert.ok(a.monthlyGrant >= 500);
});

test("topup quote locked math + rollover 80% fresh only", () => {
  const q = econ.topupQuoteCredits({ packINR: 499, fxRate: 90 });
  assert.ok(q.credits > 0);
  assert.equal(econ.rolloverCredits({ monthlyGrant: 4400, freshUsed: 3000 }), 1120);
  assert.throws(() => econ.rolloverCredits({ monthlyGrant: 100, freshUsed: 200 }), (e) => e.code === "INVALID_REQUEST");
});

test("quota routing fail-closed, school vs individual", () => {
  assert.equal(quotaMode.resolveQuotaMode({ accountType: "school" }), "school_tokens");
  assert.equal(quotaMode.resolveQuotaMode({ accountType: "individual" }), "individual_credits");
  assert.throws(() => quotaMode.resolveQuotaMode({ accountType: "admin" }), (e) => e.code === "ACCOUNT_TYPE_UNSUPPORTED");
  assert.throws(() => quotaMode.resolveQuotaMode({}), (e) => e.code === "ACCOUNT_TYPE_UNSUPPORTED");
  assert.throws(() => quotaMode.resolveQuotaMode({ accountType: null }), (e) => e.code === "ACCOUNT_TYPE_UNSUPPORTED");
  assert.throws(() => quotaMode.resolveQuotaMode({ accountType: "" }), (e) => e.code === "ACCOUNT_TYPE_UNSUPPORTED");
});

test("pricing snapshot normalizes per-token -> USD/1M once, pins version, rejects missing", () => {
  // Stored per-token "0.000002"/"0.000010" == $2/$10 per 1M.
  const s = pricingSnap.pinPricing({ pricing: { input: "0.000002", output: "0.000010" }, modelKey: "mdl_x" });
  assert.equal(s.inputPricePerMillion, 2);
  assert.equal(s.outputPricePerMillion, 10);
  assert.equal(s.inputUsdPerMillion, 2);
  assert.equal(s.outputUsdPerMillion, 10);
  assert.equal(s.priceVersion, "v1:0.000002x0.000010");
  assert.equal(s.costClass, "advanced");
  assert.equal(s.isFree, false);
  assert.ok(typeof s.capturedAtMs === "number");
  assert.throws(() => pricingSnap.pinPricing({ pricing: { input: null, output: "0.000010" } }), (e) => e.code === "INVALID_REQUEST");
});
