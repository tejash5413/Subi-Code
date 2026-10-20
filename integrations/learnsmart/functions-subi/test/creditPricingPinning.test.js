// functions-subi/test/creditPricingPinning.test.js — pricing-unit + pinning safety.
// Stored pricing is per-TOKEN strings (catalog/approved shape). pinPricing
// normalizes EXACTLY ONCE to USD/1M. Commit reuses the reservation snapshot.
const test = require("node:test");
const assert = require("node:assert/strict");

const { pinPricing } = require("../src/services/pricingSnapshot");
const math = require("../src/services/creditMath");
const quota = require("../src/services/individualCreditQuotaService");
const { writeDoc } = require("./orderingTx");

function fakeStore() {
  const state = {};
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      const ref = {
        _key: key,
        async get() {
          return { exists: key in state, data: () => state[key] };
        },
        collection: (sub) => coll(`${key}/${sub}`),
      };
      return ref;
    },
  });
  return {
    _state: state,
    collection: (name) => coll(name),
    async runTransaction(fn) {
      const tx = {
        set: (ref, data, options) => {
          state[ref._key] = writeDoc(state[ref._key], data, options);
        },
        get: async (ref) => {
          const key = ref._key;
          return { exists: key in state, data: () => state[key] };
        },
      };
      return fn(tx);
    },
  };
}

function seedAccount(store, uid, milli = 10_000_000) {
  store._state[`creditAccounts/${uid}`] = {
    uid,
    cycleId: "c1",
    cycleStartedAtMs: 1,
    cycleEndsAtMs: 2,
    monthlyGrantCreditsMilli: milli,
    monthlyRemainingCreditsMilli: milli,
    rolloverGrantedCreditsMilli: 0,
    rolloverRemainingCreditsMilli: 0,
    rolloverExpiresAtMs: null,
    topupRemainingCreditsMilli: 0,
    reservedCreditsMilli: 0,
    fxSnapshot: null,
    economicsSnapshot: null,
    subscriptionActive: true,
    updatedAtMs: 1,
  };
}

function endToEndMilli(storedPricing, inTokens, outTokens) {
  const snap = pinPricing({ pricing: storedPricing, modelKey: "mdl_t" });
  return {
    snap,
    milli: math.creditsMilliForUsage({
      inputTokens: inTokens,
      outputTokens: outTokens,
      inputPricePerMillion: snap.inputPricePerMillion,
      outputPricePerMillion: snap.outputPricePerMillion,
    }),
  };
}

test("vector A: stored 0.0000001/0.0000005 ($0.10/$0.50) 100k+20k -> 20 credits", () => {
  const { snap, milli } = endToEndMilli({ input: "0.0000001", output: "0.0000005" }, 100_000, 20_000);
  assert.equal(snap.inputPricePerMillion, 0.1);
  assert.equal(snap.outputPricePerMillion, 0.5);
  assert.equal(snap.inputUsdPerMillion, 0.1);
  assert.equal(snap.outputUsdPerMillion, 0.5);
  assert.equal(milli, 20_000);
  assert.equal(milli / 1000, 20);
});

test("vector B: stored 0.000002/0.000010 ($2/$10) same usage -> 400 credits", () => {
  const { snap, milli } = endToEndMilli({ input: "0.000002", output: "0.000010" }, 100_000, 20_000);
  assert.equal(snap.inputPricePerMillion, 2);
  assert.equal(snap.outputPricePerMillion, 10);
  assert.equal(milli, 400_000);
  assert.equal(milli / 1000, 400);
});

test("vector C: stored 0.000010/0.000050 ($10/$50) same usage -> 2000 credits", () => {
  const { snap, milli } = endToEndMilli({ input: "0.000010", output: "0.000050" }, 100_000, 20_000);
  assert.equal(snap.inputPricePerMillion, 10);
  assert.equal(snap.outputPricePerMillion, 50);
  assert.equal(milli, 2_000_000);
  assert.equal(milli / 1000, 2000);
});

test("free model: stored 0/0 pins isFree, zero burn pre-min", () => {
  const snap = pinPricing({ pricing: { input: "0", output: "0" }, modelKey: "mdl_f" });
  assert.equal(snap.isFree, true);
  assert.equal(snap.inputPricePerMillion, 0);
  assert.equal(snap.costClass, "free");
  const milli = math.creditsMilliForUsage({
    inputTokens: 5000, outputTokens: 5000,
    inputPricePerMillion: snap.inputPricePerMillion,
    outputPricePerMillion: snap.outputPricePerMillion,
  });
  assert.equal(milli, 0);
});

test("paid model is not free", () => {
  const snap = pinPricing({ pricing: { input: "0.000002", output: "0.000010" }, modelKey: "mdl_p" });
  assert.equal(snap.isFree, false);
});

test("reserve $2/$10 then catalog $3/$15 -> commit still $2/$10, version preserved", async () => {
  const store = fakeStore();
  seedAccount(store, "u1");
  const paid210 = { input: "0.000002", output: "0.000010" };
  const snapAtReserve = pinPricing({ pricing: paid210, modelKey: "mdl_m" });
  const r = await quota.reserveCredits({
    uid: "u1", requestId: "r-pin-1", estimateMilli: 500_000,
    pricing: paid210, modelKey: "mdl_m",
  }, { store });
  assert.equal(r.priceVersion, snapAtReserve.priceVersion);
  // Commit WITHOUT live pricing (route no longer passes it). Even if a caller
  // passes the moved $3/$15 catalog row, the pinned $2/$10 must win.
  const moved315 = { input: "0.000003", output: "0.000015" };
  const out = await quota.commitCredits({
    uid: "u1", requestId: "r-pin-1",
    actualInputTokens: 100_000, actualOutputTokens: 20_000,
    pricing: moved315, modelKey: "mdl_m",
  }, { store });
  // $2/$10 @ 100k/20k = 400,000 milli. $3/$15 would be 600,000.
  assert.equal(out.actualMilli, 400_000);
  const resDoc = store._state[`creditAccounts/u1/ledger/${quota.reservationDocId("u1", "r-pin-1")}`];
  assert.equal(resDoc.priceVersion, snapAtReserve.priceVersion);
  assert.equal(resDoc.inputPricePerMillion, 2);
  assert.equal(resDoc.outputPricePerMillion, 10);
  assert.ok(typeof resDoc.capturedAtMs === "number");
});

test("free at reserve stays free even if catalog becomes paid", async () => {
  const store = fakeStore();
  seedAccount(store, "u2");
  const free = { input: "0", output: "0" };
  await quota.reserveCredits({
    uid: "u2", requestId: "r-free-1", estimateMilli: 1000,
    pricing: free, modelKey: "mdl_f",
  }, { store });
  const paid = { input: "0.000002", output: "0.000010" };
  const out = await quota.commitCredits({
    uid: "u2", requestId: "r-free-1",
    actualInputTokens: 1000, actualOutputTokens: 1000,
    pricing: paid, modelKey: "mdl_f",
  }, { store });
  // Pinned free snapshot: zero burn regardless of later pricing.
  assert.equal(out.actualMilli, 0);
});

test("paid at reserve stays paid even if catalog becomes free", async () => {
  const store = fakeStore();
  seedAccount(store, "u3");
  const paid = { input: "0.000002", output: "0.000010" };
  await quota.reserveCredits({
    uid: "u3", requestId: "r-paid-1", estimateMilli: 500_000,
    pricing: paid, modelKey: "mdl_m",
  }, { store });
  const free = { input: "0", output: "0" };
  const out = await quota.commitCredits({
    uid: "u3", requestId: "r-paid-1",
    actualInputTokens: 100_000, actualOutputTokens: 20_000,
    pricing: free, modelKey: "mdl_m",
  }, { store });
  assert.equal(out.actualMilli, 400_000);
});

test("free successful chargeable request stays zero; empty stays 0", async () => {
  const store = fakeStore();
  seedAccount(store, "u4");
  const free = { input: "0", output: "0" };
  await quota.reserveCredits({
    uid: "u4", requestId: "r-min-1", estimateMilli: 1000,
    pricing: free, modelKey: "mdl_f",
  }, { store });
  const charged = await quota.commitCredits({
    uid: "u4", requestId: "r-min-1",
    actualInputTokens: 10, actualOutputTokens: 5, modelKey: "mdl_f",
  }, { store });
  assert.equal(charged.actualMilli, 0);

  await quota.reserveCredits({
    uid: "u4", requestId: "r-min-2", estimateMilli: 1000,
    pricing: free, modelKey: "mdl_f",
  }, { store });
  const empty = await quota.commitCredits({
    uid: "u4", requestId: "r-min-2",
    actualInputTokens: 0, actualOutputTokens: 0, modelKey: "mdl_f",
  }, { store });
  assert.equal(empty.actualMilli, 0);
});

test("paid tiny usage has the one-credit minimum", async () => {
  const store = fakeStore();
  seedAccount(store, "u5");
  const cheap = { input: "0.0000001", output: "0.0000005" }; // $0.10/$0.50
  await quota.reserveCredits({
    uid: "u5", requestId: "r-tiny-1", estimateMilli: 1000,
    pricing: cheap, modelKey: "mdl_c",
  }, { store });
  // 1 in + 1 out @ $0.10/$0.50 -> floor(0.1+0.5)=0 milli; successful paid => one-credit floor.
  const out = await quota.commitCredits({
    uid: "u5", requestId: "r-tiny-1",
    actualInputTokens: 1, actualOutputTokens: 1, modelKey: "mdl_c",
  }, { store });
  assert.equal(out.actualMilli, 1000);
});
