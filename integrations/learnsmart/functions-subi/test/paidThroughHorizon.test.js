// test/paidThroughHorizon.test.js — authoritative paid-through horizon.
//
// Covers: resolvePaidThroughMs max() selection; individual entitlement using
// the latest instant across periodEndMs/paidThroughMs/renewalDateMs; lazy
// credit readiness surviving a stale periodEndMs while paid-through coverage
// continues (the Nov-6-vs-Nov-30 bug). One monthly sub-period at a time is
// still enforced by resolveCurrentCycleBounds (no Oct->Nov30 monster grant).
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateSubiCodeEntitlement,
  resolvePaidThroughMs,
} = require("../src/services/subiCodeEntitlementService");
const periodSvc = require("../src/services/subiBillingPeriodService");
const ready = require("../src/services/individualCreditReadyService");
const { orderingStore } = require("./orderingTx");

const DAY = 86_400_000;
const REAL_NOW = Date.now();
const T0 = REAL_NOW - 5 * DAY;
const T1 = periodSvc.addCalendarMonths(T0, 1);

function seedFx(store, rate = 96.25) {
  store.state["fxRates/USD_INR"] = {
    pair: "USD_INR", rate, source: "t", fetchedAtMs: 1, snapshotId: "s", updatedAt: "t",
  };
}

// ---------- resolvePaidThroughMs ----------

test("horizon is the max valid instant across all three fields", () => {
  assert.equal(resolvePaidThroughMs({ periodEndMs: 100, paidThroughMs: 300, renewalDateMs: 200 }), 300);
  assert.equal(resolvePaidThroughMs({ periodEndMs: 500, paidThroughMs: 300, renewalDateMs: 200 }), 500);
  assert.equal(resolvePaidThroughMs({ renewalDateMs: 200 }), 200);
});

test("horizon ignores non-numeric and non-positive values", () => {
  assert.equal(resolvePaidThroughMs({ periodEndMs: "2030-01-01", paidThroughMs: 300, renewalDateMs: 0 }), 300);
  assert.equal(resolvePaidThroughMs({ periodEndMs: -5, paidThroughMs: NaN, renewalDateMs: Infinity }), null);
  assert.equal(resolvePaidThroughMs(null), null);
  assert.equal(resolvePaidThroughMs({}), null);
});

// ---------- entitlement ----------

function individualSub(over = {}) {
  return {
    subiCodeActive: true,
    subiCodeTier: null,
    renewalDateMs: null,
    periodStartMs: null,
    periodEndMs: null,
    paidThroughMs: null,
    ...over,
  };
}

test("stale periodEndMs with future paidThroughMs stays allowed", () => {
  const out = evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: individualSub({ periodEndMs: REAL_NOW - DAY, paidThroughMs: REAL_NOW + 20 * DAY }),
    schoolSubscription: null,
  });
  assert.equal(out.allowed, true);
});

test("all horizons past is expired", () => {
  const out = evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: individualSub({ periodEndMs: REAL_NOW - 2 * DAY, paidThroughMs: REAL_NOW - DAY, renewalDateMs: REAL_NOW - DAY }),
    schoolSubscription: null,
  });
  assert.equal(out.allowed, false);
  assert.equal(out.code, "SUBI_PLAN_EXPIRED");
});

test("renewalDateMs-only future still allowed (unchanged behavior)", () => {
  const out = evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: individualSub({ renewalDateMs: REAL_NOW + 10 * DAY }),
    schoolSubscription: null,
  });
  assert.equal(out.allowed, true);
});

test("school branch still uses expiry-only renewalDateMs", () => {
  const allowed = evaluateSubiCodeEntitlement({
    accountType: "school",
    userSubscription: null,
    schoolSubscription: { renewalDateMs: REAL_NOW + 10 * DAY },
  });
  assert.equal(allowed.allowed, true);
  const expired = evaluateSubiCodeEntitlement({
    accountType: "school",
    userSubscription: null,
    schoolSubscription: { renewalDateMs: REAL_NOW - DAY },
  });
  assert.equal(expired.code, "SUBI_PLAN_EXPIRED");
});

// ---------- lazy readiness with divergent fields ----------

test("ready: stale periodEndMs does not expire paid-through coverage", async () => {
  const store = orderingStore();
  seedFx(store);
  const profile = {
    uid: "u1",
    accountType: "individual",
    subscription: {
      subiCodeActive: true,
      subiCodeTier: null,
      renewalDateMs: REAL_NOW + 25 * DAY,
      periodStartMs: T0,
      periodEndMs: REAL_NOW - DAY, // stale: old ?? chain would expire here
      paidThroughMs: REAL_NOW + 25 * DAY,
    },
  };
  const out = await ready.ensureIndividualCreditReady(
    { uid: "u1", accountType: "individual" },
    { store, directoryDb: orderingStore(), getProfile: async () => profile, nowMs: REAL_NOW }
  );
  // Bounds come from the authoritative resolver (final sub-period truncated
  // to paid-through coverage, never a monster cycle).
  const bounds = periodSvc.resolveCurrentCycleBounds({
    periodStartMs: T0,
    paidThroughMs: REAL_NOW + 25 * DAY,
    nowMs: REAL_NOW,
  });
  assert.equal(out.cycleId, `u1:${bounds.paidPeriodStartMs}:${bounds.paidPeriodEndMs}`);
  assert.ok(out.monthlyGrantCreditsMilli > 0);
});

test("ready: all horizons past still expires", async () => {
  const store = orderingStore();
  seedFx(store);
  const profile = {
    uid: "u1",
    accountType: "individual",
    subscription: {
      subiCodeActive: true,
      subiCodeTier: null,
      renewalDateMs: REAL_NOW - DAY,
      periodStartMs: T0 - 60 * DAY,
      periodEndMs: REAL_NOW - 2 * DAY,
      paidThroughMs: REAL_NOW - DAY,
    },
  };
  await assert.rejects(
    ready.ensureIndividualCreditReady(
      { uid: "u1", accountType: "individual" },
      { store, getProfile: async () => profile, nowMs: REAL_NOW }
    ),
    (e) => e.code === "SUBI_PLAN_EXPIRED"
  );
});
