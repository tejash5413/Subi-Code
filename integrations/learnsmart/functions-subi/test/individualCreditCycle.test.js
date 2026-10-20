// functions-subi/test/individualCreditCycle.test.js — credit cycle + 80% rollover.
// Cycles map 1:1 to paid SUBI periods (never YYYY-MM). Deterministic cycleId.
// Rollover = pct of unused FRESH monthly only; old rollover expires; topup carries.
const test = require("node:test");
const assert = require("node:assert/strict");

const cycle = require("../src/services/individualCreditCycleService");
const { monthlyGrantCredits } = require("../src/services/individualCreditEconomics");
const { safeCode, statusFor } = require("../src/utils/redact");
const { orderingStore } = require("./orderingTx");
const creditQuota = require("../src/services/individualCreditQuotaService");

const DAY = 86_400_000;
const TIER_SUB = { subiCodeTier: "plus", renewalDateMs: Date.now() + 30 * DAY };

function individualCtx(over = {}) {
  return {
    uid: "u1",
    accountType: "individual",
    userSubscription: { ...TIER_SUB },
    ...over,
  };
}

function seedOldCycle(state, uid, over = {}) {
  state[`creditAccounts/${uid}`] = {
    uid,
    cycleId: "old-cycle",
    cycleStartedAtMs: 1,
    cycleEndsAtMs: 2,
    monthlyGrantCreditsMilli: 4_400_000,
    monthlyRemainingCreditsMilli: 1_400_000,
    rolloverGrantedCreditsMilli: 500_000,
    rolloverRemainingCreditsMilli: 500_000,
    rolloverExpiresAtMs: 2,
    topupRemainingCreditsMilli: 1_000_000,
    reservedCreditsMilli: 0,
    activeReservations: {},
    fxSnapshot: null,
    economicsSnapshot: null,
    subscriptionActive: true,
    updatedAtMs: 1,
    ...over,
  };
}

// ---------- Period resolver (single authoritative source) ----------

test("period resolver accepts paid bounds, rejects everything else", () => {
  const now = Date.now();
  const p = cycle.resolveCreditCyclePeriod({ paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + DAY });
  assert.equal(p.cycleStartedAtMs, now - 1000);
  assert.equal(p.cycleEndsAtMs, now + DAY);
  assert.throws(() => cycle.resolveCreditCyclePeriod({ paidPeriodStartMs: 0, paidPeriodEndMs: now }), /start/);
  assert.throws(() => cycle.resolveCreditCyclePeriod({ paidPeriodStartMs: now, paidPeriodEndMs: now }), /end > start/);
  assert.throws(() => cycle.resolveCreditCyclePeriod({ paidPeriodStartMs: now + DAY, paidPeriodEndMs: now }), /end > start/);
  assert.throws(() => cycle.resolveCreditCyclePeriod({}), /paid period/);
});

test("cycleId is deterministic per uid+period, never time/random", () => {
  const a = cycle.creditCycleIdFor("u1", 1000, 2000);
  assert.equal(a, cycle.creditCycleIdFor("u1", 1000, 2000));
  assert.equal(a, "u1:1000:2000");
  assert.notEqual(a, cycle.creditCycleIdFor("u1", 1000, 2001));
  assert.notEqual(a, cycle.creditCycleIdFor("u2", 1000, 2000));
});

// ---------- First grant ----------

test("first grant: frozen FX/economics, full monthly, no rollover, audited ledger", async () => {
  const store = orderingStore();
  const now = Date.now();
  const out = await cycle.ensureCurrentCreditCycle(individualCtx({
    paidPeriodStartMs: now - 1000,
    paidPeriodEndMs: now + 30 * DAY,
    fxRate: 96.25,
  }), { store });
  // 499-50=449 AI INR; per-credit 96.25*1.10*0.001=0.105875 -> raw 4240.85 -> grant 4200.
  const expected = monthlyGrantCredits({ fxRate: 96.25 });
  assert.equal(expected.monthlyGrant, 4200);
  assert.equal(out.monthlyGrantCreditsMilli, 4_200_000);
  assert.equal(out.monthlyRemainingCreditsMilli, 4_200_000);
  assert.equal(out.rolloverGrantedCreditsMilli, 0);
  assert.equal(out.rolloverRemainingCreditsMilli, 0);
  assert.equal(out.topupRemainingCreditsMilli, 0);
  assert.equal(out.subscriptionActive, true);
  assert.equal(out.alreadyGranted, false);
  assert.equal(out.cycleAdvanced, false);
  assert.equal(out.fxSnapshot.rate, 96.25);
  assert.equal(out.economicsSnapshot.priceINR, 499);
  assert.equal(out.cycleId, `u1:${now - 1000}:${now + 30 * DAY}`);
  // No calendar-month derivation: id carries exact paid bounds.
  assert.ok(!/^\d{4}-\d{2}$/.test(out.cycleId));
  const grantDoc = store.state[`creditAccounts/u1/ledger/grant-${out.cycleId}`];
  assert.equal(grantDoc.type, "subscription_grant");
  assert.equal(grantDoc.amountMilli, 4_200_000);
  assert.equal(grantDoc.cycleId, out.cycleId);
});

test("same paid period re-entry grants nothing (idempotent)", async () => {
  const store = orderingStore();
  const now = Date.now();
  const args = individualCtx({
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
  });
  const first = await cycle.ensureCurrentCreditCycle(args, { store });
  // Simulate spending, then re-enter (e.g. month boundary passes mid-cycle).
  store.state["creditAccounts/u1"].monthlyRemainingCreditsMilli = 3_000_000;
  const second = await cycle.ensureCurrentCreditCycle(args, { store });
  assert.equal(second.alreadyGranted, true);
  assert.equal(second.monthlyRemainingCreditsMilli, 3_000_000);
  assert.equal(second.cycleId, first.cycleId);
  assert.equal(second.monthlyGrantCreditsMilli, 4_200_000);
});

// ---------- Rollover engine (spec example) ----------

test("advance: 80% of fresh unused only; old rollover expires; topup carries", async () => {
  const store = orderingStore();
  seedOldCycle(store.state, "u1"); // fresh unused 1.4M, old rollover 0.5M, topup 1M
  const now = Date.now();
  // Adjacent monthly chain: previous end == new start (lazy-recovery rule).
  store.state["creditAccounts/u1"].cycleStartedAtMs = now - 1000 - 30 * DAY;
  store.state["creditAccounts/u1"].cycleEndsAtMs = now - 1000;
  const out = await cycle.ensureCurrentCreditCycle(individualCtx({
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
  }), { store });
  assert.equal(out.cycleAdvanced, true);
  assert.equal(out.previousCycleId, "old-cycle");
  // 1400 fresh unused * 0.8 = 1120 (spec example). Old 500 does NOT re-roll.
  assert.equal(out.rolloverGrantedCreditsMilli, 1_120_000);
  assert.equal(out.rolloverRemainingCreditsMilli, 1_120_000);
  assert.equal(out.rolloverExpiresAtMs, now + 30 * DAY);
  assert.equal(out.topupRemainingCreditsMilli, 1_000_000);
  assert.equal(out.monthlyRemainingCreditsMilli, 4_200_000);
  assert.equal(out.alreadyGranted, false);
  const rollDoc = store.state[`creditAccounts/u1/ledger/rollover-${out.cycleId}`];
  assert.equal(rollDoc.type, "rollover_grant");
  assert.equal(rollDoc.amountMilli, 1_120_000);
  assert.equal(rollDoc.freshUnusedMilli, 1_400_000);
});

test("fully spent monthly grants zero rollover and writes no rollover ledger", async () => {
  const store = orderingStore();
  seedOldCycle(store.state, "u1", { monthlyRemainingCreditsMilli: 0 });
  const now = Date.now();
  const out = await cycle.ensureCurrentCreditCycle(individualCtx({
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
  }), { store });
  assert.equal(out.rolloverGrantedCreditsMilli, 0);
  assert.equal(out.rolloverRemainingCreditsMilli, 0);
  assert.equal(out.rolloverExpiresAtMs, null);
  assert.equal(store.state[`creditAccounts/u1/ledger/rollover-${out.cycleId}`], undefined);
});

// ---------- In-flight settlement on advance ----------

test("advance settles holds: reserved releases into fresh base, risk forfeits", async () => {
  const store = orderingStore();
  seedOldCycle(store.state, "u1", {
    monthlyRemainingCreditsMilli: 1_000_000,
    reservedCreditsMilli: 300_000,
    activeReservations: {
      "hold-res": {
        amountMilli: 200_000, state: "reserved", expiresAtMs: 1, modelKey: "mdl_m",
        breakdown: { rolloverMilli: 0, monthlyMilli: 200_000, topupMilli: 0 }, createdAtMs: 1,
      },
      "hold-risk": {
        amountMilli: 100_000, state: "started", expiresAtMs: 1, modelKey: "mdl_m",
        breakdown: { rolloverMilli: 0, monthlyMilli: 100_000, topupMilli: 0 }, createdAtMs: 1,
      },
    },
  });
  const now = Date.now();
  store.state["creditAccounts/u1"].cycleStartedAtMs = now - 1000 - 30 * DAY;
  store.state["creditAccounts/u1"].cycleEndsAtMs = now - 1000;
  const out = await cycle.ensureCurrentCreditCycle(individualCtx({
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
  }), { store });
  // Fresh base = 1,000,000 + 200,000 released; risk 100,000 forfeited.
  // Rollover = floor(1,200,000 * 0.8) = 960,000.
  assert.equal(out.rolloverGrantedCreditsMilli, 960_000);
  assert.equal(out.settledHoldMilli, 300_000);
  assert.equal(out.reservedCreditsMilli, 0);
  assert.deepEqual(out.activeReservations, {});
});

// ---------- Fail-closed paths ----------

test("cycle advance restores reserved purchased credits and terminalizes late finalizers", async () => {
  const store = orderingStore();
  seedOldCycle(store.state, "u1", {
    monthlyRemainingCreditsMilli: 0, rolloverRemainingCreditsMilli: 0,
    topupRemainingCreditsMilli: 1_000_000,
  });
  await creditQuota.reserveCredits({
    uid: "u1", requestId: "old-hold", estimateMilli: 200_000,
    pricing: { input: "0.000001", output: "0.000001" }, modelKey: "mdl_m",
  }, { store });
  const now = Date.now();
  const out = await cycle.ensureCurrentCreditCycle(individualCtx({
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
  }), { store });
  assert.equal(out.topupRemainingCreditsMilli, 1_000_000);
  assert.deepEqual(store.state["creditAccounts/u1"].activeReservations || {}, {});
  const before = JSON.stringify(store.state["creditAccounts/u1"]);
  await creditQuota.releaseCredits({ uid: "u1", requestId: "old-hold" }, { store });
  await creditQuota.commitCredits({ uid: "u1", requestId: "old-hold", actualInputTokens: 100, actualOutputTokens: 100 }, { store });
  assert.equal(JSON.stringify(store.state["creditAccounts/u1"]), before);
});

test("cycle advance risk settlement prevents late release or commit changing renewed balances", async () => {
  const store = orderingStore();
  seedOldCycle(store.state, "u1");
  await creditQuota.reserveCredits({
    uid: "u1", requestId: "risk-hold", estimateMilli: 200_000,
    pricing: { input: "0.000001", output: "0.000001" }, modelKey: "mdl_m",
  }, { store });
  await creditQuota.markCreditDispatched({ uid: "u1", requestId: "risk-hold" }, { store });
  const now = Date.now();
  await cycle.ensureCurrentCreditCycle(individualCtx({
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
  }), { store });
  const before = JSON.stringify(store.state["creditAccounts/u1"]);
  await creditQuota.releaseCredits({ uid: "u1", requestId: "risk-hold" }, { store });
  await creditQuota.commitCredits({ uid: "u1", requestId: "risk-hold", actualInputTokens: 100, actualOutputTokens: 100 }, { store });
  assert.equal(JSON.stringify(store.state["creditAccounts/u1"]), before);
});

test("expired paid period fails closed with SUBI_PLAN_EXPIRED and writes nothing", async () => {
  const store = orderingStore();
  const now = Date.now();
  await assert.rejects(
    cycle.ensureCurrentCreditCycle(individualCtx({
      paidPeriodStartMs: now - 60 * DAY, paidPeriodEndMs: now - 30 * DAY, fxRate: 96.25,
    }), { store }),
    (e) => e.code === "SUBI_PLAN_EXPIRED");
  assert.equal(store.state["creditAccounts/u1"], undefined);
});

test("future paid period start fails closed", async () => {
  const store = orderingStore();
  const now = Date.now();
  await assert.rejects(
    cycle.ensureCurrentCreditCycle(individualCtx({
      paidPeriodStartMs: now + DAY, paidPeriodEndMs: now + 31 * DAY, fxRate: 96.25,
    }), { store }),
    (e) => e.code === "INVALID_REQUEST");
});

test("school accountType can never receive a credit cycle", async () => {
  const store = orderingStore();
  const now = Date.now();
  await assert.rejects(
    cycle.ensureCurrentCreditCycle(individualCtx({
      accountType: "school", paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
    }), { store }),
    (e) => e.code === "INVALID_REQUEST");
  assert.equal(store.state["creditAccounts/u1"], undefined);
});

test("missing subi tier fails closed with SUBI_CODE_REQUIRED", async () => {
  const store = orderingStore();
  const now = Date.now();
  await assert.rejects(
    cycle.ensureCurrentCreditCycle(individualCtx({
      userSubscription: { renewalDateMs: now + 30 * DAY },
      paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY, fxRate: 96.25,
    }), { store }),
    (e) => e.code === "SUBI_CODE_REQUIRED");
});

test("missing FX with no stored rate fails closed with FX_UNAVAILABLE", async () => {
  const store = orderingStore();
  const now = Date.now();
  await assert.rejects(
    cycle.ensureCurrentCreditCycle(individualCtx({
      paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY,
    }), { store }),
    (e) => e.code === "FX_UNAVAILABLE");
});

// ---------- Stored-config paths ----------

test("stored FX doc and stored economics config drive the grant", async () => {
  const store = orderingStore();
  store.state["fxRates/USD_INR"] = {
    pair: "USD_INR", rate: 90, source: "manual", fetchedAtMs: 111,
    snapshotId: "USD_INR-111-90", updatedAt: "t",
  };
  store.state["systemConfig/individualCreditEconomics"] = {
    priceINR: 499, bufferINR: 50, providerFundingMultiplier: 1.10,
    rolloverPct: 0.5, topupMarginPct: 0.25,
  };
  seedOldCycle(store.state, "u1");
  const now = Date.now();
  store.state["creditAccounts/u1"].cycleStartedAtMs = now - 1000 - 30 * DAY;
  store.state["creditAccounts/u1"].cycleEndsAtMs = now - 1000;
  const out = await cycle.ensureCurrentCreditCycle(individualCtx({
    paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * DAY,
  }), { store });
  assert.equal(out.fxSnapshot.rate, 90);
  assert.equal(out.fxSnapshot.snapshotId, "USD_INR-111-90");
  // Configured 50% rollover (not hardcoded 80%): 1.4M * 0.5 = 700k.
  assert.equal(out.rolloverGrantedCreditsMilli, 700_000);
  assert.equal(out.economicsSnapshot.rolloverPct, 0.5);
});

// ---------- Helpers + mapping ----------

test("isCycleActive follows paid end, never calendar month", () => {
  const now = Date.now();
  assert.equal(cycle.isCycleActive({ cycleEndsAtMs: now + 1000 }, now), true);
  assert.equal(cycle.isCycleActive({ cycleEndsAtMs: now - 1 }, now), false);
  assert.equal(cycle.isCycleActive({}, now), false);
});

test("cycle error codes map to controlled HTTP statuses", () => {
  assert.equal(safeCode("SUBI_CODE_REQUIRED"), "SUBI_CODE_REQUIRED");
  assert.equal(statusFor("SUBI_CODE_REQUIRED"), 403);
  assert.equal(safeCode("FX_UNAVAILABLE"), "FX_UNAVAILABLE");
  assert.equal(statusFor("FX_UNAVAILABLE"), 503);
});
