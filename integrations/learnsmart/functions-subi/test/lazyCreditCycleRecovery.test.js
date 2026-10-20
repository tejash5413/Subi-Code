// test/lazyCreditCycleRecovery.test.js — SUBI lazy credit-cycle recovery.
// Covers: same-cycle idempotency, adjacent 80% rollover, early renewal,
// multiple prepaid months, missed cycles (no stacking), concurrency,
// expired, FX failure, webhook recovery, school isolation, top-up preservation.
//
// Time model: real Date.now() is the entitlement clock (isExpiredMs). All
// paidThrough values are FUTURE vs real now. Injected nowMs (helper DI)
// simulates boundary crossings (including future instants) without waiting.
const test = require("node:test");
const assert = require("node:assert/strict");

const periodSvc = require("../src/services/subiBillingPeriodService");
const cycle = require("../src/services/individualCreditCycleService");
const ready = require("../src/services/individualCreditReadyService");
const { orderingStore } = require("./orderingTx");

const DAY = 86_400_000;
const REAL_NOW = Date.now();
// Anchor 5 days ago so [T0,T1) contains REAL_NOW; T1..T3 are future.
const T0 = REAL_NOW - 5 * DAY;
const T1 = periodSvc.addCalendarMonths(T0, 1);
const T2 = periodSvc.addCalendarMonths(T0, 2);
const T3 = periodSvc.addCalendarMonths(T0, 3);
const T1P1D = T1 + DAY;
const T2P1D = T2 + DAY;
const T0M1D = T0 - DAY;

function profileFor(start, paidThrough) {
  return {
    uid: "u1",
    accountType: "individual",
    subscription: {
      subiCodeActive: true,
      subiCodeTier: null,
      renewalDateMs: paidThrough,
      periodStartMs: start,
      periodEndMs: paidThrough,
      paidThroughMs: paidThrough,
    },
  };
}

function seedCycle(state, uid, over = {}) {
  state[`creditAccounts/${uid}`] = {
    uid,
    cycleId: `${uid}:${T0}:${T1}`,
    cycleStartedAtMs: T0,
    cycleEndsAtMs: T1,
    monthlyGrantCreditsMilli: 4_200_000,
    monthlyRemainingCreditsMilli: 1_000_000,
    rolloverGrantedCreditsMilli: 500_000,
    rolloverRemainingCreditsMilli: 500_000,
    rolloverExpiresAtMs: T1,
    topupRemainingCreditsMilli: 700_000,
    reservedCreditsMilli: 0,
    activeReservations: {},
    fxSnapshot: { pair: "USD_INR", rate: 96.25, source: "test", fetchedAtMs: 1, snapshotId: "s" },
    economicsSnapshot: {
      priceINR: 499, bufferINR: 50, providerFundingMultiplier: 1.1,
      rolloverPct: 0.8, grantCredits: 4200, computedAtMs: 1,
    },
    subscriptionActive: true,
    updatedAtMs: 1,
    ...over,
  };
}

function readyDeps(store, profile, nowMs) {
  return { store, getProfile: async () => profile, nowMs, readFundingWindow: async () => ({ current: null, nextStartMs: null }) };
}

function seedFx(store, rate = 96.25) {
  store.state["fxRates/USD_INR"] = {
    pair: "USD_INR", rate, source: "t", fetchedAtMs: 1, snapshotId: "s", updatedAt: "t",
  };
}

// ---------- Period resolver: current monthly sub-period ----------

test("resolver: current sub-period inside coverage (no monster cycles)", () => {
  // Coverage T0 -> T2, now inside [T0,T1) => current is [T0,T1).
  const b1 = periodSvc.resolveCurrentCycleBounds({ periodStartMs: T0, paidThroughMs: T2, nowMs: REAL_NOW });
  assert.deepEqual(b1, { paidPeriodStartMs: T0, paidPeriodEndMs: T1 });
  // Same coverage, now T1+1d => [T1,T2) (NOT [T1,T3), NOT [T0,T2)).
  const b2 = periodSvc.resolveCurrentCycleBounds({ periodStartMs: T0, paidThroughMs: T2, nowMs: T1P1D });
  assert.deepEqual(b2, { paidPeriodStartMs: T1, paidPeriodEndMs: T2 });
});

test("resolver: multiple prepaid months grant only the current month", () => {
  const b1 = periodSvc.resolveCurrentCycleBounds({ periodStartMs: T0, paidThroughMs: T3, nowMs: T1P1D });
  assert.deepEqual(b1, { paidPeriodStartMs: T1, paidPeriodEndMs: T2 });
  const b2 = periodSvc.resolveCurrentCycleBounds({ periodStartMs: T0, paidThroughMs: T3, nowMs: T2P1D });
  assert.deepEqual(b2, { paidPeriodStartMs: T2, paidPeriodEndMs: T3 });
});

test("resolver: expired and future fail closed", () => {
  assert.throws(
    () => periodSvc.resolveCurrentCycleBounds({ periodStartMs: T0, paidThroughMs: T1, nowMs: T1 }),
    (e) => e.code === "SUBI_PLAN_EXPIRED");
  assert.throws(
    () => periodSvc.resolveCurrentCycleBounds({ periodStartMs: T1, paidThroughMs: T2, nowMs: T0 }),
    (e) => e.code === "INVALID_REQUEST");
});

// ---------- Same-cycle idempotency ----------

test("same cycle: multiple ensures, one grant, no wallet mutation", async () => {
  const store = orderingStore();
  seedFx(store);
  const prof = profileFor(T0, T1);
  const d = readyDeps(store, prof, REAL_NOW);
  const first = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, d);
  const midMonthly = first.monthlyRemainingCreditsMilli;
  store.state["creditAccounts/u1"].monthlyRemainingCreditsMilli = midMonthly - 100_000;
  const second = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, d);
  assert.equal(second.cycleId, first.cycleId);
  assert.equal(second.alreadyGranted, true);
  assert.equal(second.monthlyRemainingCreditsMilli, midMonthly - 100_000);
  const grants = Object.keys(store.state).filter((k) => k.includes("/ledger/grant-"));
  assert.equal(grants.length, 1);
  const rolls = Object.keys(store.state).filter((k) => k.includes("/ledger/rollover-"));
  assert.equal(rolls.length, 0);
});

// ---------- Adjacent cycle: 80% fresh only ----------

test("adjacent cycle: 80% fresh-monthly rollover, old rollover expires, top-up preserved", async () => {
  const store = orderingStore();
  seedFx(store);
  seedCycle(store.state, "u1"); // fresh 1M, old rollover 0.5M, topup 0.7M
  const prof = profileFor(T0, T2);
  const out = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D));
  assert.equal(out.cycleId, `u1:${T1}:${T2}`);
  assert.equal(out.cycleAdvanced, true);
  assert.equal(out.gapFromPrevious !== true, true);
  assert.equal(out.rolloverGrantedCreditsMilli, 800_000);
  assert.equal(out.rolloverRemainingCreditsMilli, 800_000);
  assert.equal(out.topupRemainingCreditsMilli, 700_000);
  assert.equal(out.monthlyRemainingCreditsMilli, 4_200_000);
  const rollDoc = store.state[`creditAccounts/u1/ledger/rollover-${out.cycleId}`];
  assert.equal(rollDoc.amountMilli, 800_000);
  assert.equal(rollDoc.freshUnusedMilli, 1_000_000);
});

// ---------- Early renewal ----------

test("early renewal: no second grant before boundary, next cycle after boundary", async () => {
  const store = orderingStore();
  seedFx(store);
  const firstProf = profileFor(T0, T1);
  const first = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, firstProf, REAL_NOW));
  store.state["creditAccounts/u1"].monthlyRemainingCreditsMilli = 3_000_000;
  // Early renewal: entitlement now through T2, but still inside [T0,T1).
  const renewed = profileFor(T0, T2);
  const same = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, renewed, REAL_NOW));
  assert.equal(same.cycleId, first.cycleId, "current cycle unchanged on early renewal");
  assert.equal(same.monthlyRemainingCreditsMilli, 3_000_000, "no extra grant");
  assert.equal(same.alreadyGranted, true);
  // First request after T1 creates exactly [T1,T2).
  const next = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, renewed, T1P1D));
  assert.equal(next.cycleId, `u1:${T1}:${T2}`);
  assert.equal(next.cycleAdvanced, true);
  assert.equal(next.rolloverGrantedCreditsMilli, 2_400_000);
});

// ---------- Multiple prepaid months ----------

test("multiple prepaid months: only current monthly sub-period granted", async () => {
  const store = orderingStore();
  seedFx(store);
  seedCycle(store.state, "u1");
  const prof = profileFor(T0, T3);
  const second = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D));
  assert.equal(second.cycleId, `u1:${T1}:${T2}`, "NOT T1 -> T3");
  const third = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T2P1D));
  assert.equal(third.cycleId, `u1:${T2}:${T3}`);
});

// ---------- Missed cycles: no stacking ----------

test("missed cycles: no historical stacking, no compounded rollover, top-up survives", async () => {
  const store = orderingStore();
  seedFx(store);
  seedCycle(store.state, "u1", {
    monthlyRemainingCreditsMilli: 2_000_000,
    rolloverRemainingCreditsMilli: 400_000,
    topupRemainingCreditsMilli: 1_700_000,
  });
  // Return at T2+1d with entitlement through T3: current is [T2,T3), skipping [T1,T2).
  const prof = profileFor(T0, T3);
  const out = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T2P1D));
  assert.equal(out.cycleId, `u1:${T2}:${T3}`);
  assert.equal(out.gapFromPrevious, true);
  assert.equal(out.rolloverGrantedCreditsMilli, 0, "no compounded rollover across skipped months");
  assert.equal(out.rolloverRemainingCreditsMilli, 0);
  assert.equal(out.topupRemainingCreditsMilli, 1_700_000, "top-up carries 100%");
  assert.equal(out.monthlyRemainingCreditsMilli, 4_200_000);
  const grants = Object.keys(store.state).filter((k) => k.includes("/ledger/grant-"));
  assert.equal(grants.length, 1, "only the current period granted");
});

// ---------- Top-up preservation ----------

test("top-up preservation across lazy cycle creation", async () => {
  const store = orderingStore();
  seedFx(store);
  seedCycle(store.state, "u1", {
    monthlyRemainingCreditsMilli: 1_000_000,
    rolloverRemainingCreditsMilli: 500_000,
    topupRemainingCreditsMilli: 1_700_000,
  });
  const prof = profileFor(T0, T2);
  const out = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D));
  assert.equal(out.topupRemainingCreditsMilli, 1_700_000);
});

// ---------- Concurrency: one cycle/grant ----------

test("concurrency: 20 simultaneous first requests converge to one cycle/grant", async () => {
  const store = orderingStore();
  seedFx(store);
  seedCycle(store.state, "u1");
  const prof = profileFor(T0, T2);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D))));
  const ids = new Set(results.map((r) => r.cycleId));
  assert.equal(ids.size, 1);
  assert.equal([...ids][0], `u1:${T1}:${T2}`);
  const grants = Object.keys(store.state).filter((k) => k.includes("/ledger/grant-"));
  assert.equal(grants.length, 1);
  const rolls = Object.keys(store.state).filter((k) => k.includes("/ledger/rollover-"));
  assert.equal(rolls.length, 1);
});

// ---------- Expired subscription ----------

test("expired: no cycle, no grant, purchased balance preserved", async () => {
  const store = orderingStore();
  seedFx(store);
  seedCycle(store.state, "u1", { topupRemainingCreditsMilli: 1_700_000 });
  const before = JSON.stringify(store.state["creditAccounts/u1"]);
  // paidThrough T1 is future vs REAL_NOW? T1 is ~25d future, so not expired at
  // REAL_NOW. Simulate expiry by injecting nowMs past T1.
  const prof = profileFor(T0, T1);
  await assert.rejects(
    ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D)),
    (e) => e.code === "SUBI_PLAN_EXPIRED");
  assert.equal(JSON.stringify(store.state["creditAccounts/u1"]), before, "no wallet mutation");
  assert.equal(store.state["creditAccounts/u1"].topupRemainingCreditsMilli, 1_700_000);
});

// ---------- FX failure ----------

test("FX failure: no partial cycle, no fake grant, retry possible", async () => {
  const store = orderingStore(); // no fxRates doc
  seedCycle(store.state, "u1");
  const prof = profileFor(T0, T2);
  await assert.rejects(
    ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D)),
    (e) => e.code === "FX_UNAVAILABLE");
  assert.equal(store.state["creditAccounts/u1"].cycleId, `u1:${T0}:${T1}`);
  assert.equal(Object.keys(store.state).filter((k) => k.includes("/ledger/grant-")).length, 0);
  seedFx(store);
  const out = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D));
  assert.equal(out.cycleId, `u1:${T1}:${T2}`);
  const again = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D));
  assert.equal(again.alreadyGranted, true);
});

// ---------- Webhook recovery ----------

test("webhook recovery: extended subscription + missing grant recovers once", async () => {
  const store = orderingStore();
  seedFx(store);
  // Payment established [T1,T2) but the grant never ran (no account doc).
  // Profile renewal is T2 (future vs REAL_NOW) so entitlement passes.
  const prof = profileFor(T1, T2);
  const out = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D));
  assert.equal(out.cycleId, `u1:${T1}:${T2}`);
  assert.equal(out.monthlyRemainingCreditsMilli, 4_200_000);
  const grants = Object.keys(store.state).filter((k) => k.includes("/ledger/grant-"));
  assert.equal(grants.length, 1);
});

// ---------- Future-paid ----------

test("future-paid period creates nothing", async () => {
  const store = orderingStore();
  seedFx(store);
  const prof = profileFor(T2, T3);
  await assert.rejects(
    ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D)),
    (e) => e.code === "INVALID_REQUEST");
  assert.equal(store.state["creditAccounts/u1"], undefined);
});

// ---------- School isolation ----------

test("school never creates credit cycles", async () => {
  const store = orderingStore();
  const schoolProfile = { uid: "s1", accountType: "school", subscription: null };
  await assert.rejects(
    ready.ensureIndividualCreditReady({ uid: "s1", accountType: "school" }, readyDeps(store, schoolProfile, REAL_NOW)),
    (e) => e.code === "ACCOUNT_TYPE_UNSUPPORTED");
  assert.equal(store.state["creditAccounts/s1"], undefined);
  await assert.rejects(
    cycle.ensureCurrentCreditCycle({
      uid: "s1", accountType: "school",
      userSubscription: { subiCodeActive: true, renewalDateMs: T2 },
      paidPeriodStartMs: T1, paidPeriodEndMs: T2, fxRate: 96.25,
    }, { store }),
    (e) => e.code === "INVALID_REQUEST");
});

// ---------- Deterministic cycle ID ----------

test("deterministic cycle identity (uid + bounds, no randomness)", () => {
  assert.equal(cycle.creditCycleIdFor("u1", T1, T2), `u1:${T1}:${T2}`);
  assert.equal(cycle.creditCycleIdFor("u1", T1, T2), cycle.creditCycleIdFor("u1", T1, T2));
  assert.notEqual(cycle.creditCycleIdFor("u1", T1, T2), cycle.creditCycleIdFor("u1", T1, T3));
});

// ---------- Reservation safety at boundary ----------

test("old-cycle reserved holds release, dispatched holds forfeit on advance", async () => {
  const store = orderingStore();
  seedFx(store);
  seedCycle(store.state, "u1", {
    monthlyRemainingCreditsMilli: 1_000_000,
    rolloverRemainingCreditsMilli: 0,
    topupRemainingCreditsMilli: 700_000,
    reservedCreditsMilli: 300_000,
    activeReservations: {
      "hold-res": {
        amountMilli: 200_000, state: "reserved", expiresAtMs: 1, modelKey: "mdl",
        breakdown: { rolloverMilli: 0, monthlyMilli: 200_000, topupMilli: 0 }, createdAtMs: 1,
      },
      "hold-risk": {
        amountMilli: 100_000, state: "started", expiresAtMs: 1, modelKey: "mdl",
        breakdown: { rolloverMilli: 0, monthlyMilli: 100_000, topupMilli: 0 }, createdAtMs: 1,
      },
    },
  });
  store.state[`creditAccounts/u1/ledger/hold-res`] = {
    type: "reservation", amountMilli: 200_000, state: "reserved",
    reservedBreakdown: { rolloverMilli: 0, monthlyMilli: 200_000, topupMilli: 0 },
    createdAtMs: 1, expiresAtMs: 9999999999999, released: false, committed: false,
  };
  store.state[`creditAccounts/u1/ledger/hold-risk`] = {
    type: "reservation", amountMilli: 100_000, state: "started",
    reservedBreakdown: { rolloverMilli: 0, monthlyMilli: 100_000, topupMilli: 0 },
    createdAtMs: 1, expiresAtMs: 9999999999999, released: false, committed: false,
  };
  const prof = profileFor(T0, T2);
  const out = await ready.ensureIndividualCreditReady({ uid: "u1", accountType: "individual" }, readyDeps(store, prof, T1P1D));
  assert.equal(out.rolloverGrantedCreditsMilli, 960_000);
  assert.equal(out.topupRemainingCreditsMilli, 700_000);
  assert.equal(out.reservedCreditsMilli, 0);
});

// ---------- Route wiring (static) ----------

test("routes call the shared preflight; school path never touches cycles", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const f of ["managedUsage.js", "managedLimits.js", "managedAgent.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", f), "utf8");
    assert.match(src, /ensureIndividualCreditReady/, f);
    assert.match(src, /ACCOUNT_TYPE_UNSUPPORTED/, `${f} fail-closed routing`);
  }
  const agent = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "managedAgent.js"), "utf8");
  const idxEnsure = agent.indexOf("ensureIndividualCreditReady");
  const idxReserve = agent.indexOf("reserveCredits");
  assert.ok(idxEnsure > 0 && idxReserve > 0 && idxEnsure < idxReserve, "cycle before reservation");
  // School isolation: ensure block is gated on individual_credits only.
  assert.match(agent, /quotaMode === "individual_credits"/);
  // managedUsage/managedLimits keep explicit school_tokens branches.
  for (const f of ["managedUsage.js", "managedLimits.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", f), "utf8");
    assert.ok(src.indexOf("school_tokens") >= 0, `${f} keeps school path`);
  }
});
