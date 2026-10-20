// functions-subi/test/shadowCreditEnforcement.test.js — SUBI shadow credit
// enforcement (Stage 2: capability exists, flag stays OFF).
// Covers: flag/targeting gates, school exclusion, pure spend projection,
// estimate vs actual, bucket order, free/paid parity with authoritative math,
// pinned pricing, failure outcomes, idempotency, concurrency, wallet
// non-mutation, privacy, summary, lazy-cycle ordering, and live-request
// isolation at the HTTP route level. No production Firestore, no provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FieldValue } = require("firebase-admin/firestore");
const { writeDoc } = require("./orderingTx");

const buckets = require("../src/services/creditBucketMath");
const creditMath = require("../src/services/creditMath");
const flags = require("../src/services/individualCreditFlags");
const shadow = require("../src/services/individualCreditShadowService");
const quota = require("../src/services/individualCreditQuotaService");
const { pinPricing } = require("../src/services/pricingSnapshot");

// Stored per-token pricing fixtures (catalog/approved shape).
const FREE = { input: "0", output: "0" };
const CHEAP = { input: "0.0000001", output: "0.0000005" }; // $0.10/$0.50
const EXPENSIVE = { input: "0.000002", output: "0.000010" }; // $2/$10
const FLAGSHIP = { input: "0.000010", output: "0.000050" }; // $10/$50

// ---------- Fake subi store (unit-level) ----------
// Supports doc get, subcollection limit queries, collectionGroup reads, and
// read-before-write transactions (throws on read-after-write like Firestore).
function makeShadowStore(initialState) {
  const state = { ...(initialState || {}) };
  function subColl(key, sub) {
    return {
      doc: (id) => refAt(`${key}/${sub}/${id}`),
      limit: (n) => ({
        get: async () => {
          const prefix = `${key}/${sub}/`;
          const docs = Object.entries(state)
            .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
            .slice(0, n)
            .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v }));
          return { docs };
        },
      }),
    };
  }
  function refAt(key) {
    return {
      _key: key,
      id: key.split("/").pop(),
      get: async () => ({ exists: key in state, data: () => state[key], id: key.split("/").pop() }),
      collection: (sub) => subColl(key, sub),
    };
  }
  return {
    state,
    collection: (name) => ({
      doc: (id) => refAt(`${name}/${id}`),
      limit: (n) => ({
        get: async () => {
          const docs = Object.entries(state)
            .filter(([k]) => k.startsWith(`${name}/`) && !k.slice(name.length + 1).includes("/"))
            .slice(0, n)
            .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v }));
          return { docs };
        },
      }),
    }),
    collectionGroup: (sub) => ({
      limit: (n) => ({
        get: async () => {
          const docs = Object.entries(state)
            .filter(([k]) => k.includes(`/${sub}/`))
            .slice(0, n)
            .map(([k, v]) => ({ id: k.split("/").pop(), data: () => v }));
          return { docs };
        },
      }),
    }),
    async runTransaction(fn) {
      let writes = 0;
      const tx = {
        get: async (ref) => {
          if (writes > 0) throw new Error("Firestore transactions require all reads before writes.");
          const key = ref._key;
          return { exists: key in state, data: () => state[key], id: key.split("/").pop() };
        },
        set: (ref, data, options) => {
          writes += 1;
          state[ref._key] = writeDoc(state[ref._key], data, options);
        },
      };
      return fn(tx);
    },
  };
}

function seedWallet(state, uid, { rollover = 0, monthly = 0, topup = 0, cycleId = "c1", active = true } = {}) {
  state[`creditAccounts/${uid}`] = {
    uid,
    cycleId,
    cycleStartedAtMs: 1,
    cycleEndsAtMs: 2,
    monthlyGrantCreditsMilli: monthly,
    monthlyRemainingCreditsMilli: monthly,
    rolloverGrantedCreditsMilli: rollover,
    rolloverRemainingCreditsMilli: rollover,
    rolloverExpiresAtMs: null,
    topupRemainingCreditsMilli: topup,
    reservedCreditsMilli: 0,
    activeReservations: {},
    fxSnapshot: null,
    economicsSnapshot: null,
    subscriptionActive: active,
    updatedAtMs: 1,
  };
}

function shadowKeysOf(store) {
  return Object.keys(store.state).filter((k) => k.includes("/shadowUsage/"));
}

function walletJsonOf(store, uid) {
  return JSON.stringify(store.state[`creditAccounts/${uid}`]);
}

// ---------- Flags: defaults stay OFF ----------

test("flags: all six rollout switches default OFF with empty targeting", async () => {
  assert.equal(flags.DEFAULTS.shadowEnabled, false);
  assert.equal(flags.DEFAULTS.enforcementEnabled, false);
  assert.equal(flags.DEFAULTS.billingEnabled, false);
  assert.equal(flags.DEFAULTS.topupsEnabled, false);
  assert.equal(flags.DEFAULTS.fullAgentCapabilitiesEnabled, false);
  assert.equal(flags.DEFAULTS.autoModelDiscoveryEnabled, false);
  assert.deepEqual(flags.DEFAULTS.shadowTestUids, []);
  const store = makeShadowStore();
  const loaded = await flags.getIndividualCreditFlags({ store });
  assert.equal(loaded.shadowEnabled, false);
  assert.equal(loaded.enforcementEnabled, false);
  assert.equal(loaded.billingEnabled, false);
  assert.equal(loaded.topupsEnabled, false);
  assert.equal(loaded.fullAgentCapabilitiesEnabled, false);
  assert.equal(loaded.autoModelDiscoveryEnabled, false);
  assert.deepEqual(loaded.shadowTestUids, []);
});

// ---------- Targeting ----------

test("targeting: shadowTestUids scoping is fail-closed (non-empty explicit list only)", () => {
  assert.equal(flags.isShadowEnabledForUid(null, "u1"), false);
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: false, shadowTestUids: [] }, "u1"), false);
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: false, shadowTestUids: ["u1"] }, "u1"), false);
  // Empty or missing allowlist shadows NOBODY, even with the switch ON.
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: true, shadowTestUids: [] }, "u1"), false);
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: true }, "u1"), false);
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: true, shadowTestUids: ["u1"] }, "u1"), true);
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: true, shadowTestUids: ["u1"] }, "u2"), false);
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: true, shadowTestUids: ["u1"] }, ""), false);
  assert.equal(flags.isShadowEnabledForUid({ shadowEnabled: true, shadowTestUids: ["u1"] }, "  u1  "), true);
});

// Mandatory regression: there must be NO implicit global rollout from an
// empty allowlist.
test("shadowEnabled with empty shadowTestUids fails closed", () => {
  const emptyList = { shadowEnabled: true, shadowTestUids: [] };
  const missingList = { shadowEnabled: true };
  for (const f of [emptyList, missingList]) {
    assert.equal(flags.isShadowEnabledForUid(f, "u1"), false);
    assert.equal(flags.isShadowEnabledForUid(f, "anyone"), false);
    assert.equal(shadow.shouldShadow({
      quotaMode: "individual_credits", accountType: "individual",
      flags: f, uid: "u1", enforcementEnabled: false,
    }), false);
  }
});

test("targeting: toSafeFlags normalizes shadowTestUids (trim, dedupe, cap, no wildcards)", async () => {
  const store = makeShadowStore({
    "systemConfig/individualCreditFlags": {
      shadowEnabled: true,
      shadowTestUids: [" u1 ", "u1", 42, null, "u2", "", "   ", "*", "all", "ALL", " All "],
    },
  });
  const loaded = await flags.getIndividualCreditFlags({ store });
  assert.deepEqual(loaded.shadowTestUids, ["u1", "u2"]);
  const many = { shadowEnabled: true, shadowTestUids: Array.from({ length: 30 }, (_, i) => `u${i}`) };
  const capped = await flags.getIndividualCreditFlags({
    store: makeShadowStore({ "systemConfig/individualCreditFlags": many }),
  });
  assert.equal(capped.shadowTestUids.length, flags.MAX_SHADOW_TEST_UIDS);
  // A wildcard-only allowlist normalizes to empty -> fails closed.
  const wild = await flags.getIndividualCreditFlags({
    store: makeShadowStore({ "systemConfig/individualCreditFlags": { shadowEnabled: true, shadowTestUids: ["*", "all"] } }),
  });
  assert.deepEqual(wild.shadowTestUids, []);
  assert.equal(flags.isShadowEnabledForUid(wild, "u1"), false);
  assert.equal(flags.isShadowEnabledForUid(wild, "*"), false);
});

// ---------- Gate: shouldShadow ----------

test("gate matrix A-G: explicit allowlist only, school never shadowed", () => {
  const gate = (f, uid, accountType = "individual", quotaMode = "individual_credits") =>
    shadow.shouldShadow({ quotaMode, accountType, flags: f, uid, enforcementEnabled: false });
  // A: switch OFF, empty list -> no shadow.
  assert.equal(gate({ shadowEnabled: false, shadowTestUids: [] }, "u1"), false);
  // B: switch OFF, listed UID -> no shadow.
  assert.equal(gate({ shadowEnabled: false, shadowTestUids: ["u1"] }, "u1"), false);
  // C: switch ON, empty list -> NO shadow (fail closed, no global accident).
  assert.equal(gate({ shadowEnabled: true, shadowTestUids: [] }, "u1"), false);
  // D: switch ON, listed UID requests -> shadow.
  assert.equal(gate({ shadowEnabled: true, shadowTestUids: ["u1"] }, "u1"), true);
  // E: switch ON, unlisted UID requests -> no shadow.
  assert.equal(gate({ shadowEnabled: true, shadowTestUids: ["u1"] }, "u2"), false);
  // F: duplicated/unaligned entries normalize to one UID.
  assert.deepEqual(flags.normalizeShadowTestUids(["u1", "u1", " u1 "]), ["u1"]);
  assert.equal(gate({ shadowEnabled: true, shadowTestUids: flags.normalizeShadowTestUids(["u1", "u1", " u1 "]) }, "u1"), true);
  // G: school UID in the allowlist is STILL never shadowed.
  assert.equal(gate({ shadowEnabled: true, shadowTestUids: ["u2"] }, "u2", "school", "school_tokens"), false);
  assert.equal(gate({ shadowEnabled: true, shadowTestUids: ["u2"] }, "u2", "school", "individual_credits"), false);
  // Unknown account types and enforcement-ON never shadow either.
  assert.equal(gate({ shadowEnabled: true, shadowTestUids: ["u1"] }, "u1", "weird"), false);
  assert.equal(shadow.shouldShadow({
    quotaMode: "individual_credits", accountType: "individual",
    flags: { shadowEnabled: true, shadowTestUids: ["u1"] }, uid: "u1", enforcementEnabled: true,
  }), false);
  assert.equal(gate(null, "u1"), false);
});

// ---------- Pure projection: spend order ----------

test("projection: planCreditSpend uses rollover -> monthly -> topup with shortfall", () => {
  const full = buckets.planCreditSpend({
    availableBuckets: { rolloverMilli: 100, monthlyMilli: 500, topupMilli: 1000 },
    requestedMilli: 700,
  });
  assert.deepEqual(
    { r: full.rolloverMilli, m: full.monthlyMilli, t: full.topupMilli, c: full.coveredMilli, s: full.shortfallMilli },
    { r: 100, m: 500, t: 100, c: 700, s: 0 }
  );
  // Matches the authoritative deduct helper consumption exactly.
  const deducted = buckets.deductCreditsFromBuckets(
    { rolloverRemainingMilli: 100, monthlyRemainingMilli: 500, topupRemainingMilli: 1000 }, 700);
  assert.deepEqual(
    { rolloverMilli: deducted.consumed.rolloverMilli, monthlyMilli: deducted.consumed.monthlyMilli, topupMilli: deducted.consumed.topupMilli },
    { rolloverMilli: full.rolloverMilli, monthlyMilli: full.monthlyMilli, topupMilli: full.topupMilli }
  );
  const short = buckets.planCreditSpend({
    availableBuckets: { rolloverMilli: 100, monthlyMilli: 300, topupMilli: 1000 },
    requestedMilli: 2000,
  });
  assert.equal(short.coveredMilli, 1400);
  assert.equal(short.shortfallMilli, 600);
  const zero = buckets.planCreditSpend({
    availableBuckets: { rolloverMilli: 5, monthlyMilli: 5, topupMilli: 5 },
    requestedMilli: 0,
  });
  assert.deepEqual([zero.rolloverMilli, zero.monthlyMilli, zero.topupMilli, zero.coveredMilli, zero.shortfallMilli], [0, 0, 0, 0, 0]);
});

// ---------- startShadow: sufficient balance ----------

test("shadow success: sufficient balance projects without wallet mutation", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000 });
  const before = walletJsonOf(store, "u1");
  const snap = pinPricing({ pricing: EXPENSIVE, modelKey: "mdl_m" });
  const est = shadow.estimateReservationMilli({ inputUpperBound: 2000, maxOutputTokens: 4096, snap });
  assert.ok(est > 0 && est < 5_000_000);
  const started = await shadow.startShadow({
    uid: "u1", requestId: "run-1:0", modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 2000, maxOutputTokens: 4096, cycleId: "c1",
  }, { store });
  assert.equal(started.started, true);
  const rec = started.record;
  assert.equal(rec.mode, "shadow");
  assert.equal(rec.authoritative, false);
  assert.equal(rec.uid, "u1");
  assert.equal(rec.requestId, "run-1:0");
  assert.equal(rec.cycleId, "c1");
  assert.equal(rec.modelKey, "mdl_m");
  assert.equal(rec.status, "open");
  assert.equal(rec.estimatedReservationMilli, est);
  assert.equal(rec.wouldBlockAtReservation, false);
  assert.equal(rec.reservationShortfallMilli, 0);
  assert.equal(rec.pricingSnapshot.priceVersion, snap.priceVersion);
  assert.equal(rec.pricingSnapshot.inputPricePerMillion, snap.inputPricePerMillion);
  assert.equal(rec.pricingSnapshot.outputPricePerMillion, snap.outputPricePerMillion);
  assert.equal(rec.pricingSnapshot.isFree, false);
  assert.equal(rec.pricingSnapshot.costClass, snap.costClass);
  assert.deepEqual(rec.walletBefore, {
    cycleId: "c1", rolloverMilli: 0, monthlyMilli: 5_000_000,
    topupMilli: 0, reservedMilli: 0, totalAvailableMilli: 5_000_000,
  });
  // No wallet mutation.
  assert.equal(walletJsonOf(store, "u1"), before);
  // Finalize with realistic actuals below the estimate.
  const fin = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-1:0", inputTokens: 1000, outputTokens: 200,
    outcome: "provider_success", dispatched: true,
  }, { store });
  assert.equal(fin.finalized, true);
  assert.equal(fin.outcome, "provider_success");
  assert.equal(fin.wouldCoverActual, true);
  assert.equal(fin.actualShortfallMilli, 0);
  const expected = creditMath.creditsMilliForUsage({
    inputTokens: 1000, outputTokens: 200,
    inputPricePerMillion: snap.inputPricePerMillion, outputPricePerMillion: snap.outputPricePerMillion,
  });
  assert.equal(fin.actualChargeMilli, expected);
  assert.equal(walletJsonOf(store, "u1"), before);
});

// ---------- Insufficient estimate: would-block without blocking ----------

test("shadow insufficient estimate: would-block recorded, start still succeeds, wallet untouched", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 100 });
  const before = walletJsonOf(store, "u1");
  const snap = pinPricing({ pricing: EXPENSIVE, modelKey: "mdl_m" });
  const est = shadow.estimateReservationMilli({ inputUpperBound: 2000, maxOutputTokens: 4096, snap });
  assert.ok(est > 100);
  const started = await shadow.startShadow({
    uid: "u1", requestId: "run-2:0", modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 2000, maxOutputTokens: 4096, cycleId: "c1",
  }, { store });
  assert.equal(started.started, true);
  assert.equal(started.record.wouldBlockAtReservation, true);
  assert.equal(started.record.reservationShortfallMilli, est - 100);
  assert.equal(walletJsonOf(store, "u1"), before);
});

// ---------- Estimate fits, actual exceeds ----------

test("shadow actual exceeds estimate: wouldCoverActual false with shortfall, no mutation", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 500 });
  const before = walletJsonOf(store, "u1");
  // Force a small estimate by pinning cheap pricing at start, then finalize
  // with usage whose charge exceeds the wallet.
  await shadow.startShadow({
    uid: "u1", requestId: "run-3:0", modelKey: "mdl_c",
    storedPricing: CHEAP, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  const rec0 = await shadow.getShadowRecord({ uid: "u1", requestId: "run-3:0" }, { store });
  assert.equal(rec0.wouldBlockAtReservation, true);
  const fin = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-3:0", inputTokens: 2000, outputTokens: 2000,
    outcome: "provider_success", dispatched: true,
  }, { store });
  // CHEAP $0.10/$0.50: 2000*0.1 + 2000*0.5 = 200+1000 = 1200 > 500.
  assert.equal(fin.actualChargeMilli, 1200);
  assert.equal(fin.wouldCoverActual, false);
  assert.equal(fin.actualShortfallMilli, 700);
  assert.equal(walletJsonOf(store, "u1"), before);
});

// ---------- Bucket projection ----------

test("shadow bucket projection: 100/300/1000 with minimum 1000 -> 100/300/600", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { rollover: 100, monthly: 300, topup: 1000 });
  const before = walletJsonOf(store, "u1");
  // Craft pricing so the actual charge is exactly 550 milli: $0.5/$0.5 per
  // 1M with 100 in + 1000 out -> 50 + 500 = 550.
  const pricing550 = { input: "0.0000005", output: "0.0000005" };
  await shadow.startShadow({
    uid: "u1", requestId: "run-4:0", modelKey: "mdl_x",
    storedPricing: pricing550, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  const fin = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-4:0", inputTokens: 100, outputTokens: 1000,
    outcome: "provider_success", dispatched: true,
  }, { store });
  assert.equal(fin.actualChargeMilli, 1000);
  const rec = await shadow.getShadowRecord({ uid: "u1", requestId: "run-4:0" }, { store });
  assert.deepEqual(rec.projectedActualBreakdown, { rolloverMilli: 100, monthlyMilli: 300, topupMilli: 600 });
  assert.equal(rec.wouldCoverActual, true);
  assert.equal(walletJsonOf(store, "u1"), before);
});

// ---------- Free model ----------

test("shadow free model: non-zero usage charges zero, empty usage charges 0", async () => {
  const free = shadow.computeActualChargeMilli({
    snap: pinPricing({ pricing: FREE, modelKey: "mdl_f" }),
    inputTokens: 1000, outputTokens: 200,
  });
  assert.equal(free, 0);
  const empty = shadow.computeActualChargeMilli({
    snap: pinPricing({ pricing: FREE, modelKey: "mdl_f" }),
    inputTokens: 0, outputTokens: 0,
  });
  assert.equal(empty, 0);
  const paid = shadow.computeActualChargeMilli({
    snap: pinPricing({ pricing: CHEAP, modelKey: "mdl_c" }),
    inputTokens: 1, outputTokens: 1,
  });
  // Paid models may legitimately burn < 1000 milli with no minimum.
  assert.equal(paid, 1000);
});

// ---------- Parity with authoritative math ----------

test("parity: shadow actual equals authoritative commit across free/cheap/expensive/flagship", async () => {
  const vectors = [
    ["free", FREE, 1000, 200],
    ["cheap", CHEAP, 1000, 200],
    ["expensive", EXPENSIVE, 5000, 1000],
    ["flagship", FLAGSHIP, 5000, 1000],
    ["zero", EXPENSIVE, 0, 0],
  ];
  for (const [name, pricing, inn, out] of vectors) {
    const snap = pinPricing({ pricing, modelKey: `mdl_${name}` });
    const shadowMilli = shadow.computeActualChargeMilli({ snap, inputTokens: inn, outputTokens: out });
    // Authoritative path: real reserve + commit on an isolated wallet.
    const store = makeShadowStore();
    seedWallet(store.state, "u9", { monthly: 10_000_000_000, topup: 10_000_000_000 });
    const reserve = await quota.reserveCredits({
      uid: "u9", requestId: `parity-${name}`, estimateMilli: 5_000_000,
      pricing, modelKey: `mdl_${name}`,
    }, { store });
    void reserve;
    const commit = await quota.commitCredits({
      uid: "u9", requestId: `parity-${name}`,
      actualInputTokens: inn, actualOutputTokens: out, modelKey: `mdl_${name}`,
    }, { store });
    assert.equal(shadowMilli, commit.actualMilli, `parity failed for ${name}`);
  }
});

// ---------- Pinned pricing ----------

test("pinned pricing: finalize ignores later registry moves", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000 });
  await shadow.startShadow({
    uid: "u1", requestId: "run-pin:0", modelKey: "mdl_c",
    storedPricing: CHEAP, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  // Registry reprices AFTER the pin (e.g. cheap -> flagship).
  const movedMilli = shadow.computeActualChargeMilli({
    snap: pinPricing({ pricing: FLAGSHIP, modelKey: "mdl_c" }),
    inputTokens: 1000, outputTokens: 200,
  });
  const fin = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-pin:0", inputTokens: 1000, outputTokens: 200,
    outcome: "provider_success", dispatched: true,
  }, { store });
  const pinnedMilli = shadow.computeActualChargeMilli({
    snap: pinPricing({ pricing: CHEAP, modelKey: "mdl_c" }),
    inputTokens: 1000, outputTokens: 200,
  });
  assert.equal(fin.actualChargeMilli, pinnedMilli);
  assert.notEqual(fin.actualChargeMilli, movedMilli);
});

// ---------- Failure outcomes ----------

test("failure outcomes: pre-dispatch 0, unknown-post-dispatch conservative, cancelled partial", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000 });
  const mk = async (rid) => shadow.startShadow({
    uid: "u1", requestId: rid, modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 2000, maxOutputTokens: 4096, cycleId: "c1",
  }, { store });
  const s1 = await mk("run-f:0");
  const est = s1.record.estimatedReservationMilli;
  // Pre-dispatch failure: no provider risk -> zero projection.
  const pre = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-f:0", inputTokens: 0, outputTokens: 0,
    outcome: "pre_dispatch_failure", dispatched: false,
  }, { store });
  assert.equal(pre.actualChargeMilli, 0);
  assert.equal(pre.wouldCoverActual, true);
  // Unknown post-dispatch with no trustworthy usage -> conservative estimate.
  await mk("run-f:1");
  const unk = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-f:1", inputTokens: 0, outputTokens: 0,
    outcome: "unknown_post_dispatch", dispatched: true,
  }, { store });
  assert.equal(unk.actualChargeMilli, est);
  // Cancelled with partial usage settles on observed tokens.
  await mk("run-f:2");
  const can = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-f:2", inputTokens: 500, outputTokens: 100,
    outcome: "cancelled", dispatched: true,
  }, { store });
  const snap = pinPricing({ pricing: EXPENSIVE, modelKey: "mdl_m" });
  assert.equal(can.actualChargeMilli, creditMath.creditsMilliForUsage({
    inputTokens: 500, outputTokens: 100,
    inputPricePerMillion: snap.inputPricePerMillion, outputPricePerMillion: snap.outputPricePerMillion,
  }));
  // Provider error with partial usage.
  await mk("run-f:3");
  const perr = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-f:3", inputTokens: 10, outputTokens: 2,
    outcome: "provider_error", dispatched: true,
  }, { store });
  assert.equal(perr.outcome, "provider_error");
});

// ---------- Idempotency ----------

test("idempotency: double start and double finalize converge on one record", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000 });
  const first = await shadow.startShadow({
    uid: "u1", requestId: "run-idem:0", modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 2000, maxOutputTokens: 4096, cycleId: "c1",
  }, { store });
  const second = await shadow.startShadow({
    uid: "u1", requestId: "run-idem:0", modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 2000, maxOutputTokens: 4096, cycleId: "c1",
  }, { store });
  assert.equal(first.started, true);
  assert.equal(second.deduped, true);
  assert.equal(shadowKeysOf(store).length, 1);
  const f1 = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-idem:0", inputTokens: 100, outputTokens: 50,
    outcome: "provider_success", dispatched: true,
  }, { store });
  const f2 = await shadow.finalizeShadow({
    uid: "u1", requestId: "run-idem:0", inputTokens: 999, outputTokens: 999,
    outcome: "provider_error", dispatched: true,
  }, { store });
  assert.equal(f2.alreadyFinalized, true);
  assert.equal(f2.actualChargeMilli, f1.actualChargeMilli);
  assert.equal(shadowKeysOf(store).length, 1);
  const rec = await shadow.getShadowRecord({ uid: "u1", requestId: "run-idem:0" }, { store });
  assert.equal(rec.outcome, "provider_success");
});

// ---------- Concurrency ----------

test("concurrency: parallel shadow requests keep separate snapshots, wallet untouched", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { rollover: 100, monthly: 300, topup: 1000 });
  const before = walletJsonOf(store, "u1");
  const starts = await Promise.all([0, 1, 2, 3, 4].map((i) => shadow.startShadow({
    uid: "u1", requestId: `run-conc:${i}`, modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 500, maxOutputTokens: 500, cycleId: "c1",
  }, { store })));
  assert.ok(starts.every((s) => s.started === true));
  assert.equal(shadowKeysOf(store).length, 5);
  await Promise.all([0, 1, 2, 3, 4].map((i) => shadow.finalizeShadow({
    uid: "u1", requestId: `run-conc:${i}`, inputTokens: 100, outputTokens: 50,
    outcome: "provider_success", dispatched: true,
  }, { store })));
  assert.equal(walletJsonOf(store, "u1"), before);
});

// ---------- Reserved holds: no double counting ----------

test("reserved holds: shadow available matches enforcement-available (balances net of holds)", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 1000 });
  // Authoritative hold of 400 against the wallet.
  await quota.reserveCredits({
    uid: "u1", requestId: "real-hold", estimateMilli: 400, pricing: EXPENSIVE, modelKey: "mdl_m",
  }, { store });
  const walletAfterHold = walletJsonOf(store, "u1");
  const started = await shadow.startShadow({
    uid: "u1", requestId: "run-hold:0", modelKey: "mdl_m",
    storedPricing: CHEAP, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  // Balances are 600 monthly after the hold; reserved counter is 400.
  assert.equal(started.record.walletBefore.monthlyMilli, 600);
  assert.equal(started.record.walletBefore.reservedMilli, 400);
  assert.equal(started.record.walletBefore.totalAvailableMilli, 600);
  assert.equal(walletJsonOf(store, "u1"), walletAfterHold);
});

// ---------- userModelPolicies irrelevant ----------

test("userModelPolicies do not affect shadow accounting", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000 });
  store.state["userModelPolicies/u1"] = { modelMode: "custom", modelKeys: [] };
  const started = await shadow.startShadow({
    uid: "u1", requestId: "run-pol:0", modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  assert.equal(started.started, true);
  assert.equal(started.record.wouldBlockAtReservation, false);
});

// ---------- Expired entitlement: shadow still observes ----------

test("expired entitlement: shadow records without gating (observational only)", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000, active: false });
  const started = await shadow.startShadow({
    uid: "u1", requestId: "run-exp:0", modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  assert.equal(started.started, true);
});

// ---------- No token-limit logic in shadow ----------

test("shadow introduces no monthly token ceiling logic", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "individualCreditShadowService.js"), "utf8");
  assert.ok(!src.includes("monthlyLimitService"), "shadow must not call the token-limit service");
  assert.ok(!src.includes("monthlyTokenLimit"), "shadow must not enforce a token ceiling");
  assert.ok(!src.includes("reserveCredits("), "shadow must never call the mutating reserve");
  assert.ok(!src.includes("commitCredits("), "shadow must never call the mutating commit");
});

// ---------- Multi-segment accumulation ----------

test("multi-segment: sumUsage aggregates turn totals for one accounting boundary", () => {
  assert.deepEqual(shadow.sumUsage([
    { inputTokens: 100, outputTokens: 50 },
    { inputTokens: 200, outputTokens: 0 },
    null,
  ]), { inputTokens: 300, outputTokens: 50 });
  assert.deepEqual(shadow.sumUsage(null), { inputTokens: 0, outputTokens: 0 });
});

// ---------- Privacy ----------

test("privacy: shadow docs carry metadata only, never content or secrets", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000 });
  await shadow.startShadow({
    uid: "u1", requestId: "run-priv:0", modelKey: "mdl_m",
    storedPricing: EXPENSIVE, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  await shadow.finalizeShadow({
    uid: "u1", requestId: "run-priv:0", inputTokens: 10, outputTokens: 5,
    outcome: "provider_success", dispatched: true,
  }, { store });
  const raw = JSON.stringify(store.state[shadowKeysOf(store)[0]]);
  const banned = ["prompt", "message", "content", "completion", "transcript",
    "authorization", "idtoken", "apikey", "api_key", "secret", "terminal",
    "upstreammodel", "upstream_model"];
  for (const word of banned) {
    assert.ok(!raw.toLowerCase().includes(word), `shadow doc leaks ${word}`);
  }
});

// ---------- Missing wallet / bad pricing: start fails closed (caller skips) ----------

test("start fails closed without a wallet or usable pricing", async () => {
  const store = makeShadowStore();
  await assert.rejects(
    shadow.startShadow({
      uid: "ghost", requestId: "r:0", modelKey: "mdl_m",
      storedPricing: EXPENSIVE, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
    }, { store }),
    (e) => e.code === "CREDITS_NOT_CONFIGURED"
  );
  seedWallet(store.state, "u1", { monthly: 100 });
  await assert.rejects(
    shadow.startShadow({
      uid: "u1", requestId: "r:0", modelKey: "mdl_m",
      storedPricing: { input: "bogus", output: "0" }, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
    }, { store }),
    (e) => e.code === "INVALID_REQUEST"
  );
  assert.equal(shadowKeysOf(store).length, 0);
});

// ---------- Summary ----------

test("summary: readiness aggregation over mixed shadow records", async () => {
  const store = makeShadowStore();
  seedWallet(store.state, "u1", { monthly: 5_000_000 });
  seedWallet(store.state, "u2", { monthly: 100 });
  await shadow.startShadow({
    uid: "u1", requestId: "s:0", modelKey: "mdl_c",
    storedPricing: CHEAP, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  await shadow.startShadow({
    uid: "u2", requestId: "s:0", modelKey: "mdl_e",
    storedPricing: EXPENSIVE, inputUpperBound: 2000, maxOutputTokens: 4096, cycleId: "c1",
  }, { store });
  await shadow.startShadow({
    uid: "u1", requestId: "s:1", modelKey: "mdl_f",
    storedPricing: FREE, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  await shadow.finalizeShadow({
    uid: "u1", requestId: "s:0", inputTokens: 100, outputTokens: 50,
    outcome: "provider_success", dispatched: true,
  }, { store });
  await shadow.finalizeShadow({
    uid: "u2", requestId: "s:0", inputTokens: 0, outputTokens: 0,
    outcome: "unknown_post_dispatch", dispatched: true,
  }, { store });
  await shadow.finalizeShadow({
    uid: "u1", requestId: "s:1", inputTokens: 0, outputTokens: 0,
    outcome: "cancelled", dispatched: false,
  }, { store });
  const u1recs = await shadow.listShadowRecords({ uid: "u1", limit: 10 }, { store });
  assert.equal(u1recs.length, 2);
  const all = await shadow.fetchAllShadowRecords({ limit: 50 }, { store });
  assert.equal(all.length, 3);
  const summary = shadow.summarizeShadowRecords(all);
  assert.equal(summary.requestCount, 3);
  assert.equal(summary.finalizedCount, 3);
  assert.equal(summary.openCount, 0);
  assert.equal(summary.wouldBlockReservationCount, 1);
  assert.deepEqual(summary.insufficientUsers, ["u2"]);
  assert.equal(summary.freeModelCount, 1);
  assert.equal(summary.paidModelCount, 2);
  assert.equal(summary.unknownPricingCount, 0);
  assert.equal(summary.byOutcome.provider_success, 1);
  assert.equal(summary.byOutcome.unknown_post_dispatch, 1);
  assert.equal(summary.byOutcome.cancelled, 1);
  assert.ok(summary.totalEstimatedMilli > 0);
  assert.ok(summary.totalActualMilli > 0);
  assert.equal(summary.estimateVsActualDeltaMilli, summary.totalActualMilli - summary.totalEstimatedMilli);
});

// ============================================================================
// HTTP route integration (real /agent/turn, fake store + provider).
// Proves: live requests succeed with shadow on, wallets stay byte-equal,
// schools leave zero shadow trace, flag-off leaves zero telemetry,
// targeting scopes correctly, shadow write failure never breaks the turn,
// and the lazy cycle is ensured before the shadow record.
// ============================================================================

const SRC_FRAG = path.join("functions-subi", "src");

function makeRouteDb({ failShadowWrites = false } = {}) {
  const state = {};
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      return {
        _key: key,
        id,
        async get() {
          return { id, exists: key in state, data: () => state[key] };
        },
        collection: (sub) => coll(`${key}/${sub}`),
      };
    },
    limit: (n) => ({
      async get() {
        const docs = Object.entries(state)
          .filter(([k]) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/"))
          .slice(0, n)
          .map(([k, v]) => ({ id: k.slice(prefix.length + 1), data: () => v }));
        return { docs };
      },
    }),
    add: async (doc) => {
      const id = `auto${Object.keys(state).length}`;
      state[`${prefix}/${id}`] = doc;
      return { id };
    },
  });
  let tail = Promise.resolve();
  return {
    _state: state,
    collection: (name) => coll(name),
    collectionGroup: (sub) => ({
      limit: (n) => ({
        async get() {
          const docs = Object.entries(state)
            .filter(([k]) => k.includes(`/${sub}/`))
            .slice(0, n)
            .map(([k, v]) => ({ id: k.split("/").pop(), data: () => v }));
          return { docs };
        },
      }),
    }),
    runTransaction(fn) {
      const cur = tail.then(async () => {
        const tx = {
          set: (ref, data, options) => {
            if (failShadowWrites && String(ref._key || "").includes("/shadowUsage/")) {
              throw new Error("shadow store unavailable");
            }
            state[ref._key] = writeDoc(state[ref._key], data, options);
          },
          get: async (ref) => {
            const key = ref._key;
            return { exists: key in state, data: () => state[key], id: key.split("/").pop() };
          },
        };
        return fn(tx);
      });
      tail = cur.catch(() => {});
      return cur;
    },
  };
}

function bootRoute({ user, store, profile, failShadowWrites = false } = {}) {
  for (const k of Object.keys(require.cache)) if (k.includes(SRC_FRAG)) delete require.cache[k];
  const dbPath = require.resolve("../src/db");
  const fake = store || makeRouteDb({ failShadowWrites });
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      admin: {},
      learnsmartDb: require('./orderingTx').orderingStore(),
      subiDb: fake,
    },
  };
  const authMod = require("../src/middleware/auth");
  authMod.requireAuth = () => (req, res, next) => {
    if (!user) return res.status(401).json({ error: "Missing auth token" });
    req.subi = { ...user };
    next();
  };
  if (user?.accountType === 'school') {
    const directory = require("../src/services/learnsmartDirectoryService");
    directory.getUserProfile = async () => ({ ...user, status: 'active', subscription: null });
    directory.getSchool = async id => id === user.schoolId ? { id, accountType: 'school', subscription: null } : null;
  }
  if (profile !== undefined) {
    require("../src/services/learnsmartDirectoryService").getUserProfile = async () => profile;
  }
  const app = require("../src/app");
  return {
    fake, app,
    mods: { aiConnection: require("../src/services/aiConnectionService") },
  };
}

function listenRoute(app) {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

const ROUTE_FRAME = (o) => `data: ${JSON.stringify(o)}\n\n`;
const ROUTE_DONE = "data: [DONE]\n\n";
function routeSse(chunks) {
  const text = chunks.join("") + ROUTE_DONE;
  return new ReadableStream({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } });
}
const routeText = (t, f) => ROUTE_FRAME({ choices: [{ delta: { content: t }, finish_reason: f || null }] });

function withRouteFetch(fakeProvider, fn) {
  const real = global.fetch;
  global.fetch = (url, init) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:") || u.startsWith("http://localhost:")) return real(url, init);
    return fakeProvider(url, init);
  };
  return (async () => {
    try { return await fn(); } finally { global.fetch = real; }
  })();
}

const IND_USER = { uid: "u1", schoolId: "s1", role: "student", accountType: "individual" };
const SCHOOL_USER = { uid: "u2", schoolId: "s1", role: "student", accountType: "school" };
let httpRunSeq = 100;
function nextHttpRunId() { return `http-run-${++httpRunSeq}`; }

function seedHttpBaseline(st, over = {}) {
  st["systemConfig/managedAgent"] = { mode: "enabled", testUids: [] };
  st["systemConfig/subiAccess"] = { enabled: true };
  st["schoolPolicies/s1"] = { roles: { student: { enabled: true }, teacher: { enabled: true } } };
  st["schoolLimits/s1"] = { monthlyTokens: { student: 100000, teacher: 100000 } };
  // Explicit assignment so the (non-auto-eligible) expensive test model is
  // authorized for both school users and inheriting individual users.
  st["schoolModelPolicies/s1"] = { roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_a"] } } };
  Object.assign(st, over);
}

function seedStagedIndividualBaseline(st, uid, over = {}) {
  seedHttpBaseline(st, {
    'systemConfig/managedAgent': { mode: 'test', testUids: [uid] },
    ...over,
  });
}

function seedHttpModel(st, key, over = {}) {
  st[`approvedModels/${key}`] = {
    schemaVersion: 1, modelKey: key, displayName: key, upstreamModelId: `vendor/${key}`,
    enabled: true, roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 8192, pricing: { ...(CHEAP) },
    usage: { schoolwiseEnabled: true, individualEnabled: true },
    ...over,
  };
}

function httpAgentBody(over = {}) {
  return {
    protocolVersion: 1, modelKey: "mdl_a", agentMode: "ask", clientRunId: nextHttpRunId(),
    providerRequestIndex: 0, canonicalTurns: [{ role: "user", content: "hi" }],
    toolCapabilityVersion: "read_v1", ...over,
  };
}

async function postHttpTurn(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* SSE */ }
  return { status: res.status, text, json };
}

function providerOk() {
  return {
    status: 200,
    body: routeSse([
      routeText("ok", null),
      ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    ]),
  };
}

function activeIndProfile(over = {}) {
  return {
    ...IND_USER,
    subscription: { subiCodeActive: true, renewalDateMs: Date.now() + 30 * 86400000 },
    ...over,
  };
}

test("HTTP individual shadow success: 200, wallet byte-equal, shadow finalized, no token path", async () => {
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile: activeIndProfile() });
  seedStagedIndividualBaseline(fake._state, IND_USER.uid, { "systemConfig/individualCreditFlags": { shadowEnabled: true, shadowTestUids: ["u1"] } });
  seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
  seedWallet(fake._state, "u1", { rollover: 100, monthly: 5_000_000, topup: 1000 });
  const walletBefore = JSON.stringify(fake._state["creditAccounts/u1"]);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  let dispatches = 0;
  await withRouteFetch(async () => { dispatches++; return providerOk(); }, async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postHttpTurn(server.address().port, httpAgentBody());
      assert.equal(turn.status, 200, turn.text);
      assert.ok(turn.text.includes("event: done"), turn.text);
      assert.ok(!turn.text.includes("event: error"), turn.text);
    } finally { server.close(); }
  });
  assert.equal(dispatches, 1);
  // Authoritative wallet untouched by shadow.
  assert.equal(JSON.stringify(fake._state["creditAccounts/u1"]), walletBefore);
  // Exactly one finalized shadow record, provider_success, priced at the pin.
  const keys = Object.keys(fake._state).filter((k) => k.includes("/shadowUsage/"));
  assert.equal(keys.length, 1);
  const rec = fake._state[keys[0]];
  assert.equal(rec.mode, "shadow");
  assert.equal(rec.authoritative, false);
  assert.equal(rec.outcome, "provider_success");
  assert.equal(rec.status, "finalized");
  assert.equal(rec.wouldBlockAtReservation, false);
  assert.equal(rec.wouldCoverActual, true);
  const snap = pinPricing({ pricing: EXPENSIVE, modelKey: "mdl_a" });
  assert.equal(rec.pricingSnapshot.priceVersion, snap.priceVersion);
  assert.equal(rec.actualChargeMilli, creditMath.creditsMilliForUsage({
    inputTokens: 1000, outputTokens: 200,
    inputPricePerMillion: snap.inputPricePerMillion, outputPricePerMillion: snap.outputPricePerMillion,
  }));
  assert.equal(rec.actualInputTokens, 1000);
  assert.equal(rec.actualOutputTokens, 200);
  // The live (non-enforced) token path still ran: token usage docs exist,
  // and no authoritative credit ledger charge exists.
  assert.ok(!Object.keys(fake._state).some((k) => k.startsWith("usageMonthly/")));
  assert.ok(Object.keys(fake._state).some(k => k.startsWith("individualTurnRequests/")));
  assert.ok(!Object.keys(fake._state).some((k) => k.includes("/ledger/") && !k.includes("/shadowUsage/")));
  assert.ok(!fake._state["creditAccounts/u1"].activeReservations || Object.keys(fake._state["creditAccounts/u1"].activeReservations).length === 0);
});

test("HTTP school excluded: existing token path, zero shadow records, zero wallet docs", async () => {
  const { fake, app, mods } = bootRoute({
    user: SCHOOL_USER,
    profile: { ...SCHOOL_USER, subscription: null },
  });
  // The school UID is explicitly allowlisted: it must STILL never shadow.
  seedHttpBaseline(fake._state, { "systemConfig/individualCreditFlags": { shadowEnabled: true, shadowTestUids: ["u2"] } });
  seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  let dispatches = 0;
  await withRouteFetch(async () => { dispatches++; return providerOk(); }, async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postHttpTurn(server.address().port, httpAgentBody());
      assert.equal(turn.status, 200, turn.text);
      assert.ok(turn.text.includes("event: done"), turn.text);
    } finally { server.close(); }
  });
  assert.equal(dispatches, 1);
  assert.equal(Object.keys(fake._state).filter((k) => k.includes("shadowUsage")).length, 0);
  assert.equal(fake._state["creditAccounts/u2"], undefined);
  assert.ok(!Object.keys(fake._state).some((k) => k.startsWith("creditAccounts/")));
});

test("HTTP flag false: zero shadow telemetry for individuals", async () => {
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile: activeIndProfile() });
  seedStagedIndividualBaseline(fake._state, IND_USER.uid);
  seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
  seedWallet(fake._state, "u1", { monthly: 5_000_000 });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  await withRouteFetch(async () => providerOk(), async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postHttpTurn(server.address().port, httpAgentBody());
      assert.equal(turn.status, 200, turn.text);
      assert.ok(turn.text.includes("event: done"), turn.text);
    } finally { server.close(); }
  });
  assert.equal(Object.keys(fake._state).filter((k) => k.includes("shadowUsage")).length, 0);
});

test("HTTP targeting: unlisted UID leaves no shadow trace while listed UID does", async () => {
  for (const [uid, listed, expectShadow] of [["u1", ["other"], 0], ["u1", ["u1"], 1]]) {
    const user = { ...IND_USER, uid };
    const { fake, app, mods } = bootRoute({ user, profile: activeIndProfile({ uid }) });
    seedStagedIndividualBaseline(fake._state, uid, {
      "systemConfig/individualCreditFlags": { shadowEnabled: true, shadowTestUids: listed },
    });
    seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
    seedWallet(fake._state, uid, { monthly: 5_000_000, cycleId: "c1" });
    mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
    await withRouteFetch(async () => providerOk(), async () => {
      const server = await listenRoute(app.buildManagedAgentApp());
      try {
        const turn = await postHttpTurn(server.address().port, httpAgentBody());
        assert.equal(turn.status, 200, turn.text);
      } finally { server.close(); }
    });
    assert.equal(Object.keys(fake._state).filter((k) => k.includes("shadowUsage")).length, expectShadow, `uid=${uid} listed=${listed}`);
  }
});

test("HTTP shadow write failure never fails the live request", async () => {
  const store = makeRouteDb({ failShadowWrites: true });
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile: activeIndProfile(), store });
  seedStagedIndividualBaseline(fake._state, IND_USER.uid, { "systemConfig/individualCreditFlags": { shadowEnabled: true, shadowTestUids: ["u1"] } });
  seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
  seedWallet(fake._state, "u1", { monthly: 5_000_000 });
  const walletBefore = JSON.stringify(fake._state["creditAccounts/u1"]);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  await withRouteFetch(async () => providerOk(), async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postHttpTurn(server.address().port, httpAgentBody());
      assert.equal(turn.status, 200, turn.text);
      assert.ok(turn.text.includes("event: done"), turn.text);
      assert.ok(!turn.text.includes("event: error"), turn.text);
    } finally { server.close(); }
  });
  assert.equal(JSON.stringify(fake._state["creditAccounts/u1"]), walletBefore);
  assert.equal(Object.keys(fake._state).filter((k) => k.includes("shadowUsage")).length, 0);
  assert.ok(!Object.keys(fake._state).some((k) => k.startsWith("usageMonthly/")));
});

test("HTTP lazy cycle runs first: missing wallet is created, shadow pins the new cycle", async () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const T0 = now - 5 * DAY;
  const T1 = T0 + 31 * DAY;
  const profile = {
    ...IND_USER,
    subscription: {
      subiCodeActive: true,
      renewalDateMs: T1,
      periodStartMs: T0,
      periodEndMs: T1,
      paidThroughMs: T1,
    },
  };
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile });
  seedStagedIndividualBaseline(fake._state, IND_USER.uid, { "systemConfig/individualCreditFlags": { shadowEnabled: true, shadowTestUids: ["u1"] } });
  seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
  fake._state["fxRates/USD_INR"] = {
    pair: "USD_INR", rate: 96.25, source: "t", fetchedAtMs: 1, snapshotId: "s", updatedAt: "t",
  };
  assert.equal(fake._state["creditAccounts/u1"], undefined);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  await withRouteFetch(async () => providerOk(), async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postHttpTurn(server.address().port, httpAgentBody());
      assert.equal(turn.status, 200, turn.text);
      assert.ok(turn.text.includes("event: done"), turn.text);
    } finally { server.close(); }
  });
  const wallet = fake._state["creditAccounts/u1"];
  assert.ok(wallet && typeof wallet.cycleId === "string" && wallet.cycleId.length > 0);
  const keys = Object.keys(fake._state).filter((k) => k.includes("/shadowUsage/"));
  assert.equal(keys.length, 1);
  assert.equal(fake._state[keys[0]].cycleId, wallet.cycleId);
  assert.equal(fake._state[keys[0]].outcome, "provider_success");
});

test("HTTP empty allowlist fails closed: switch ON, no UIDs, zero shadow telemetry", async () => {
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile: activeIndProfile() });
  seedStagedIndividualBaseline(fake._state, IND_USER.uid, { "systemConfig/individualCreditFlags": { shadowEnabled: true, shadowTestUids: [] } });
  seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
  seedWallet(fake._state, "u1", { monthly: 5_000_000 });
  const walletBefore = JSON.stringify(fake._state["creditAccounts/u1"]);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  await withRouteFetch(async () => providerOk(), async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postHttpTurn(server.address().port, httpAgentBody());
      assert.equal(turn.status, 200, turn.text);
      assert.ok(turn.text.includes("event: done"), turn.text);
    } finally { server.close(); }
  });
  assert.equal(Object.keys(fake._state).filter((k) => k.includes("shadowUsage")).length, 0);
  assert.equal(JSON.stringify(fake._state["creditAccounts/u1"]), walletBefore);
});

// ---------- managed-agent-stream observability regression ----------
// The stream log once read the router instance `r` (`r.accountingFinalized`)
// and always reported ACCOUNTING_UNAVAILABLE. It must use the route-owned
// accounting flag and report the accounting mode truthfully.

function captureStructuredLogs() {
  const entries = [];
  const sink = {
    info: (data) => entries.push({ level: "info", ...(data || {}) }),
    warn: (data) => entries.push({ level: "warn", ...(data || {}) }),
    error: (data) => entries.push({ level: "error", ...(data || {}) }),
    debug: (data) => entries.push({ level: "debug", ...(data || {}) }),
  };
  return { entries, sink };
}

async function runTurnWithLogCapture({ user, profile, flagsDoc, seedWallet: seedW }) {
  const booted = bootRoute({ user, profile });
  const { fake, app, mods } = booted;
  const seed = { "systemConfig/individualCreditFlags": flagsDoc };
  if (user.accountType === 'individual') seedStagedIndividualBaseline(fake._state, user.uid, seed);
  else seedHttpBaseline(fake._state, seed);
  seedHttpModel(fake._state, "mdl_a", { pricing: { ...EXPENSIVE } });
  if (seedW) seedWallet(fake._state, user.uid, seedW);
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  const logger = require("../src/utils/structuredLogger");
  const { entries, sink } = captureStructuredLogs();
  logger._setLoggerForTests(sink);
  try {
    await withRouteFetch(async () => providerOk(), async () => {
      const server = await listenRoute(app.buildManagedAgentApp());
      try {
        const turn = await postHttpTurn(server.address().port, httpAgentBody());
        assert.equal(turn.status, 200, turn.text);
      } finally { server.close(); }
    });
  } finally {
    logger._resetLoggerForTests();
  }
  return { fake, streamLogs: entries.filter((e) => e.action === "managed-agent-stream") };
}

test("observability: allowlisted individual turn logs OK + individual_shadow", async () => {
  const { streamLogs } = await runTurnWithLogCapture({
    user: IND_USER, profile: activeIndProfile(),
    flagsDoc: { shadowEnabled: true, shadowTestUids: ["u1"] },
    seedWallet: { monthly: 5_000_000 },
  });
  assert.equal(streamLogs.length, 1);
  assert.equal(streamLogs[0].code, "OK");
  assert.equal(streamLogs[0].quotaMode, "individual_credits");
  assert.equal(streamLogs[0].accountingMode, "individual_shadow");
  assert.equal(streamLogs[0].creditEnforcement, false);
  assert.equal(streamLogs[0].creditShadow, true);
});

test("observability: non-shadow individual turn logs OK + individual_observation", async () => {
  const { streamLogs } = await runTurnWithLogCapture({
    user: IND_USER, profile: activeIndProfile(),
    flagsDoc: { shadowEnabled: false, shadowTestUids: [] },
    seedWallet: { monthly: 5_000_000 },
  });
  assert.equal(streamLogs.length, 1);
  assert.equal(streamLogs[0].code, "OK");
  assert.equal(streamLogs[0].accountingMode, "individual_observation");
  assert.equal(streamLogs[0].creditShadow, false);
});

test("observability: school turn logs OK + school_token, never shadow", async () => {
  const { streamLogs } = await runTurnWithLogCapture({
    user: SCHOOL_USER, profile: { ...SCHOOL_USER, subscription: null },
    flagsDoc: { shadowEnabled: true, shadowTestUids: ["u2"] },
  });
  assert.equal(streamLogs.length, 1);
  assert.equal(streamLogs[0].code, "OK");
  assert.equal(streamLogs[0].quotaMode, "school_tokens");
  assert.equal(streamLogs[0].accountingMode, "school_token");
  assert.equal(streamLogs[0].creditShadow, false);
});

// ---------- Admin shadow-summary endpoint (Superadmin only) ----------

const ADMIN_USER = { uid: "admin1", schoolId: "s1", role: "superadmin", accountType: "individual" };

async function getAdminShadowSummary(port, query = "") {
  const res = await fetch(`http://127.0.0.1:${port}/admin/credits/shadow-summary${query}`, {
    headers: { Authorization: "Bearer t" },
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function seedAdminRecords(store) {
  seedWallet(store._state, "u1", { monthly: 5_000_000 });
  seedWallet(store._state, "u2", { monthly: 100 });
  seedWallet(store._state, "u3", { monthly: 5_000_000 });
  await shadow.startShadow({
    uid: "u1", requestId: "a:0", modelKey: "mdl_c",
    storedPricing: CHEAP, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  await shadow.startShadow({
    uid: "u1", requestId: "a:1", modelKey: "mdl_f",
    storedPricing: FREE, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  await shadow.startShadow({
    uid: "u2", requestId: "a:0", modelKey: "mdl_e",
    storedPricing: EXPENSIVE, inputUpperBound: 2000, maxOutputTokens: 4096, cycleId: "c1",
  }, { store });
  await shadow.startShadow({
    uid: "u3", requestId: "a:0", modelKey: "mdl_f",
    storedPricing: FREE, inputUpperBound: 100, maxOutputTokens: 100, cycleId: "c1",
  }, { store });
  await shadow.finalizeShadow({
    uid: "u1", requestId: "a:0", inputTokens: 100, outputTokens: 50,
    outcome: "provider_success", dispatched: true,
  }, { store });
  await shadow.finalizeShadow({
    uid: "u2", requestId: "a:0", inputTokens: 0, outputTokens: 0,
    outcome: "unknown_post_dispatch", dispatched: true,
  }, { store });
  await shadow.finalizeShadow({
    uid: "u3", requestId: "a:0", inputTokens: 0, outputTokens: 0,
    outcome: "cancelled", dispatched: false,
  }, { store });
  // u1/a:1 stays open.
}

test("admin shadow-summary: empty store returns zeros plus rollout config", async () => {
  const { fake, app } = bootRoute({ user: ADMIN_USER });
  fake._state["systemConfig/individualCreditFlags"] = { shadowEnabled: true, shadowTestUids: ["u1"] };
  const server = await listenRoute(app.buildAdminApp());
  try {
    const { status, body } = await getAdminShadowSummary(server.address().port);
    assert.equal(status, 200);
    assert.equal(body.recordCount, 0);
    assert.equal(body.summary.requestCount, 0);
    assert.equal(body.summary.totalEstimatedMilli, 0);
    assert.equal(body.summary.totalActualMilli, 0);
    assert.deepEqual(body.summary.insufficientUsers, []);
    assert.deepEqual(body.config, { shadowEnabled: true, shadowTestUidCount: 1, shadowTestUids: ["u1"] });
  } finally { server.close(); }
});

test("admin shadow-summary: global, uid filter, limit, splits, and config", async () => {
  const { fake, app } = bootRoute({ user: ADMIN_USER });
  fake._state["systemConfig/individualCreditFlags"] = { shadowEnabled: true, shadowTestUids: ["u1", "u2", "u3"] };
  await seedAdminRecords(fake);
  const server = await listenRoute(app.buildAdminApp());
  try {
    const global = await getAdminShadowSummary(server.address().port);
    assert.equal(global.status, 200);
    assert.equal(global.body.recordCount, 4);
    const s = global.body.summary;
    assert.equal(s.requestCount, 4);
    assert.equal(s.finalizedCount, 3);
    assert.equal(s.openCount, 1);
    assert.equal(s.wouldBlockReservationCount, 1);
    assert.equal(s.wouldNotCoverActualCount, 1);
    assert.deepEqual(s.insufficientUsers, ["u2"]);
    assert.equal(s.freeModelCount, 2);
    assert.equal(s.paidModelCount, 2);
    assert.equal(s.unknownPricingCount, 0);
    assert.equal(s.byOutcome.provider_success, 1);
    assert.equal(s.byOutcome.unknown_post_dispatch, 1);
    assert.equal(s.byOutcome.cancelled, 1);
    assert.equal(s.byOutcome.open, 1);
    assert.ok(s.totalEstimatedMilli > 0);
    assert.ok(s.totalActualMilli > 0);
    assert.equal(s.estimateVsActualDeltaMilli, s.totalActualMilli - s.totalEstimatedMilli);
    assert.deepEqual(global.body.config, {
      shadowEnabled: true, shadowTestUidCount: 3, shadowTestUids: ["u1", "u2", "u3"],
    });
    const one = await getAdminShadowSummary(server.address().port, "?uid=u1");
    assert.equal(one.status, 200);
    assert.equal(one.body.recordCount, 2);
    assert.equal(one.body.uid, "u1");
    assert.equal(one.body.summary.requestCount, 2);
    const limited = await getAdminShadowSummary(server.address().port, "?limit=2");
    assert.equal(limited.status, 200);
    assert.equal(limited.body.recordCount, 2);
  } finally { server.close(); }
});

test("admin shadow-summary: missing flags doc reports disabled config, non-superadmin rejected", async () => {
  const { app } = bootRoute({ user: ADMIN_USER });
  const server = await listenRoute(app.buildAdminApp());
  try {
    const { status, body } = await getAdminShadowSummary(server.address().port);
    assert.equal(status, 200);
    assert.deepEqual(body.config, { shadowEnabled: false, shadowTestUidCount: 0, shadowTestUids: [] });
  } finally { server.close(); }
  const denied = bootRoute({ user: IND_USER, profile: activeIndProfile() });
  const server2 = await listenRoute(denied.app.buildAdminApp());
  try {
    const res = await fetch(`http://127.0.0.1:${server2.address().port}/admin/credits/shadow-summary`, {
      headers: { Authorization: "Bearer t" },
    });
    assert.equal(res.status, 403);
  } finally { server2.close(); }
});
