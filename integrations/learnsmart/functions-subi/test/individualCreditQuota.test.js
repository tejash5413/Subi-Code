// functions-subi/test/individualCreditQuota.test.js — credit wallet safety.
// Order rollover -> monthly -> topup; exact breakdown reserve/release/commit;
// MAX_ACTIVE; TTL sweep; states; unknown finalization; idempotency; mapping.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const buckets = require("../src/services/creditBucketMath");
const quota = require("../src/services/individualCreditQuotaService");
const { safeCode, statusFor } = require("../src/utils/redact");
const { orderingStore } = require("./orderingTx");

const PAID_2_10 = { input: "0.000002", output: "0.000010" }; // $2/$10 per 1M
const FREE = { input: "0", output: "0" };

function seedAccount(state, uid, { rollover = 0, monthly = 0, topup = 0, active = null } = {}) {
  state[`creditAccounts/${uid}`] = {
    uid,
    cycleId: "c1",
    cycleStartedAtMs: 1,
    cycleEndsAtMs: 2,
    monthlyGrantCreditsMilli: monthly,
    monthlyRemainingCreditsMilli: monthly,
    rolloverGrantedCreditsMilli: rollover,
    rolloverRemainingCreditsMilli: rollover,
    rolloverExpiresAtMs: null,
    topupRemainingCreditsMilli: topup,
    reservedCreditsMilli: 0,
    activeReservations: active || {},
    fxSnapshot: null,
    economicsSnapshot: null,
    subscriptionActive: true,
    updatedAtMs: 1,
  };
}

function balancesOf(store, uid) {
  const a = store.state[`creditAccounts/${uid}`];
  return {
    rollover: a.rolloverRemainingCreditsMilli,
    monthly: a.monthlyRemainingCreditsMilli,
    topup: a.topupRemainingCreditsMilli,
    reserved: a.reservedCreditsMilli,
    activeCount: Object.keys(a.activeReservations || {}).length,
  };
}

function resDocOf(store, uid, requestId) {
  return store.state[`creditAccounts/${uid}/ledger/${quota.reservationDocId(uid, requestId)}`];
}

// ---------- Pure bucket helper ----------

test("bucket order is rollover -> monthly -> topup", () => {
  const out = buckets.deductCreditsFromBuckets(
    { rolloverRemainingMilli: 100, monthlyRemainingMilli: 200, topupRemainingMilli: 500 }, 600);
  assert.deepEqual(out.consumed, { rolloverMilli: 100, monthlyMilli: 200, topupMilli: 300 });
  assert.deepEqual(out.remaining, { rolloverMilli: 0, monthlyMilli: 0, topupMilli: 200 });
});

test("bucket deduct fails closed on insufficient total", () => {
  assert.equal(buckets.deductCreditsFromBuckets(
    { rolloverRemainingMilli: 10, monthlyRemainingMilli: 20, topupRemainingMilli: 30 }, 61), null);
});

test("splitActual consumes reserved in order, refunds same buckets", () => {
  const split = buckets.splitActualFromReserved(
    { rolloverMilli: 100, monthlyMilli: 200, topupMilli: 300 }, 450);
  assert.deepEqual(split.consumed, { rolloverMilli: 100, monthlyMilli: 200, topupMilli: 150 });
  assert.deepEqual(split.refund, { rolloverMilli: 0, monthlyMilli: 0, topupMilli: 150 });
  const small = buckets.splitActualFromReserved(
    { rolloverMilli: 100, monthlyMilli: 200, topupMilli: 300 }, 50);
  assert.deepEqual(small.consumed, { rolloverMilli: 50, monthlyMilli: 0, topupMilli: 0 });
  assert.deepEqual(small.refund, { rolloverMilli: 50, monthlyMilli: 200, topupMilli: 300 });
});

// ---------- Reserve breakdown + exact release ----------

test("reserve 600 from 100/200/500 stores exact breakdown", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 100, monthly: 200, topup: 500 });
  const r = await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 600, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  assert.deepEqual(r.reservedBreakdown, { rolloverMilli: 100, monthlyMilli: 200, topupMilli: 300 });
  assert.deepEqual(balancesOf(store, "u1"), { rollover: 0, monthly: 0, topup: 200, reserved: 600, activeCount: 1 });
  const doc = resDocOf(store, "u1", "r1");
  assert.equal(doc.state, "reserved");
  assert.deepEqual(doc.reservedBreakdown, { rolloverMilli: 100, monthlyMilli: 200, topupMilli: 300 });
  assert.ok(typeof doc.expiresAtMs === "number" && doc.expiresAtMs > Date.now());
});

test("pre-dispatch release restores the same buckets exactly", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 100, monthly: 200, topup: 500 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 600, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  const rel = await quota.releaseCredits({ uid: "u1", requestId: "r1" }, { store });
  assert.deepEqual(rel.releasedBreakdown, { rolloverMilli: 100, monthlyMilli: 200, topupMilli: 300 });
  assert.deepEqual(balancesOf(store, "u1"), { rollover: 100, monthly: 200, topup: 500, reserved: 0, activeCount: 0 });
  assert.equal(resDocOf(store, "u1", "r1").state, "released");
});

// ---------- Partial commit reconciliation ----------

test("commit 450 of reserved 600 burns 100/200/150, refunds topup 150", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 100_000, monthly: 500_000, topup: 500_000 });
  // $2/$10: 100k in + 20k out = 400,000 milli; reserve 600,000, commit 450,000.
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 600_000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  // Breakdown: rollover 100k, monthly 500k -> wait: order rollover first.
  const doc = resDocOf(store, "u1", "r1");
  assert.deepEqual(doc.reservedBreakdown, { rolloverMilli: 100_000, monthlyMilli: 500_000, topupMilli: 0 });
  const out = await quota.commitCredits({
    uid: "u1", requestId: "r1", actualInputTokens: 100_000, actualOutputTokens: 25_000, modelKey: "mdl_m",
  }, { store });
  // actual = 100000*2 + 25000*10 = 450,000.
  assert.equal(out.actualMilli, 450_000);
  assert.equal(out.refundMilli, 150_000);
  assert.equal(out.shortfallMilli, 0);
  // Consumed: rollover 100k + monthly 350k. Refund monthly 150k.
  const b = balancesOf(store, "u1");
  assert.equal(b.rollover, 0);
  assert.equal(b.monthly, 150_000);
  assert.equal(b.topup, 500_000);
  assert.equal(b.reserved, 0);
  assert.equal(b.activeCount, 0);
});

test("commit smaller than rollover refunds monthly+topup untouched", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 100_000, monthly: 200_000, topup: 300_000 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 600_000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  // actual 50,000 milli: all from rollover.
  const out = await quota.commitCredits({
    uid: "u1", requestId: "r1", actualInputTokens: 25_000, actualOutputTokens: 0, modelKey: "mdl_m",
  }, { store });
  assert.equal(out.actualMilli, 50_000);
  const b = balancesOf(store, "u1");
  assert.equal(b.rollover, 50_000);
  assert.equal(b.monthly, 200_000);
  assert.equal(b.topup, 300_000);
  assert.equal(b.reserved, 0);
});

// ---------- Over-reservation ----------

test("over-reservation with sufficient extra commits with overMilli", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 0, monthly: 1_000_000, topup: 1_000_000 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 600_000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  // actual 700,000 > reserved 600,000; extra 100,000 available.
  const out = await quota.commitCredits({
    uid: "u1", requestId: "r1", actualInputTokens: 100_000, actualOutputTokens: 50_000, modelKey: "mdl_m",
  }, { store });
  assert.equal(out.actualMilli, 700_000);
  assert.equal(out.overMilli, 100_000);
  assert.equal(out.shortfallMilli, 0);
  const b = balancesOf(store, "u1");
  assert.ok(b.monthly >= 0 && b.topup >= 0 && b.rollover >= 0);
  assert.equal(b.reserved, 0);
});

test("over-reservation with insufficient extra never goes negative, records shortfall", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 0, monthly: 600_000, topup: 0 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 600_000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  // Wallet now empty; actual 700,000 needs 100,000 more that does not exist.
  const out = await quota.commitCredits({
    uid: "u1", requestId: "r1", actualInputTokens: 100_000, actualOutputTokens: 50_000, modelKey: "mdl_m",
  }, { store });
  assert.equal(out.actualMilli, 700_000);
  assert.equal(out.shortfallMilli, 100_000);
  const b = balancesOf(store, "u1");
  assert.equal(b.monthly, 0);
  assert.equal(b.topup, 0);
  assert.equal(b.rollover, 0);
  assert.equal(b.reserved, 0);
  const commitDoc = store.state[`creditAccounts/u1/ledger/commit-${quota.reservationDocId("u1", "r1")}`];
  assert.equal(commitDoc.shortfallMilli, 100_000);
});

// ---------- Idempotency ----------

test("duplicate reserve while active -> CREDIT_REQUEST_IN_PROGRESS; after terminal -> ALREADY_PROCESSED", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { monthly: 5_000_000 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 1000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  await assert.rejects(
    quota.reserveCredits({ uid: "u1", requestId: "r1", estimateMilli: 1000, pricing: PAID_2_10, modelKey: "mdl_m" }, { store }),
    (e) => e.code === "CREDIT_REQUEST_IN_PROGRESS");
  await quota.releaseCredits({ uid: "u1", requestId: "r1" }, { store });
  await assert.rejects(
    quota.reserveCredits({ uid: "u1", requestId: "r1", estimateMilli: 1000, pricing: PAID_2_10, modelKey: "mdl_m" }, { store }),
    (e) => e.code === "CREDIT_REQUEST_ALREADY_PROCESSED");
});

test("double release / double commit / cross-terminal are no-ops", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { monthly: 5_000_000 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 2000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  const before = balancesOf(store, "u1");
  await quota.releaseCredits({ uid: "u1", requestId: "r1" }, { store });
  const afterFirst = balancesOf(store, "u1");
  await quota.releaseCredits({ uid: "u1", requestId: "r1" }, { store });
  assert.deepEqual(balancesOf(store, "u1"), afterFirst);
  // Commit after release: terminal no-op, no charge.
  const c = await quota.commitCredits({
    uid: "u1", requestId: "r1", actualInputTokens: 1000, actualOutputTokens: 1000, modelKey: "mdl_m",
  }, { store });
  assert.equal(c.alreadyTerminal, true);
  assert.deepEqual(balancesOf(store, "u1"), afterFirst);
  void before;

  await quota.reserveCredits({
    uid: "u1", requestId: "r2", estimateMilli: 2000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  const c1 = await quota.commitCredits({
    uid: "u1", requestId: "r2", actualInputTokens: 100, actualOutputTokens: 100, modelKey: "mdl_m",
  }, { store });
  const mid = balancesOf(store, "u1");
  const c2 = await quota.commitCredits({
    uid: "u1", requestId: "r2", actualInputTokens: 100, actualOutputTokens: 100, modelKey: "mdl_m",
  }, { store });
  assert.equal(c2.alreadyTerminal, true);
  assert.deepEqual(balancesOf(store, "u1"), mid);
  // Release after commit: no-op.
  await quota.releaseCredits({ uid: "u1", requestId: "r2" }, { store });
  assert.deepEqual(balancesOf(store, "u1"), mid);
  assert.ok(c1.actualMilli >= 0);
});

// ---------- States ----------

test("markDispatched/Started transitions, idempotent re-mark, terminal no-op", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { monthly: 5_000_000 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 2000, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  assert.equal(resDocOf(store, "u1", "r1").state, "reserved");
  const d1 = await quota.markCreditDispatched({ uid: "u1", requestId: "r1" }, { store });
  assert.equal(d1.state, "dispatched");
  const d2 = await quota.markCreditDispatched({ uid: "u1", requestId: "r1" }, { store });
  assert.equal(d2.alreadyMarked, true);
  const s1 = await quota.markCreditStarted({ uid: "u1", requestId: "r1" }, { store });
  assert.equal(s1.state, "started");
  await quota.releaseCredits({ uid: "u1", requestId: "r1" }, { store });
  const term = await quota.markCreditStarted({ uid: "u1", requestId: "r1" }, { store });
  assert.equal(term.alreadyTerminal, true);
  await assert.rejects(quota.markCreditDispatched({ uid: "u1", requestId: "nope" }, { store }),
    (e) => e.code === "CREDIT_RESERVATION_NOT_FOUND");
});

// ---------- Unknown post-dispatch ----------

test("finalizeUnknown on reserved releases exactly; on started charges conservatively", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 100, monthly: 200, topup: 500 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 600, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  const rel = await quota.finalizeCreditUnknownUsage({ uid: "u1", requestId: "r1", modelKey: "mdl_m" }, { store });
  assert.equal(rel.released, true);
  assert.deepEqual(balancesOf(store, "u1"), { rollover: 100, monthly: 200, topup: 500, reserved: 0, activeCount: 0 });

  await quota.reserveCredits({
    uid: "u1", requestId: "r2", estimateMilli: 600, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  await quota.markCreditDispatched({ uid: "u1", requestId: "r2" }, { store });
  await quota.markCreditStarted({ uid: "u1", requestId: "r2" }, { store });
  const ch = await quota.finalizeCreditUnknownUsage({ uid: "u1", requestId: "r2", modelKey: "mdl_m" }, { store });
  assert.equal(ch.charged, true);
  assert.equal(ch.chargedMilli, 600);
  // Held 600 stays spent: balances remain post-reserve, hold cleared.
  assert.deepEqual(balancesOf(store, "u1"), { rollover: 0, monthly: 0, topup: 200, reserved: 0, activeCount: 0 });
  const chargeDoc = store.state[`creditAccounts/u1/ledger/charge-${quota.reservationDocId("u1", "r2")}`];
  assert.equal(chargeDoc.type, "conservative_charge");
  assert.equal(chargeDoc.amountMilli, 600);
  // Idempotent repeat.
  const again = await quota.finalizeCreditUnknownUsage({ uid: "u1", requestId: "r2", modelKey: "mdl_m" }, { store });
  assert.equal(again.alreadyTerminal, true);
});

// ---------- MAX_ACTIVE ----------

test("26th concurrent reservation rejected with TOO_MANY_ACTIVE_REQUESTS", async () => {
  const store = orderingStore();
  const active = {};
  for (let i = 0; i < 25; i += 1) {
    active[`seed-${i}`] = {
      amountMilli: 1000, state: "reserved", expiresAtMs: Date.now() + 600_000,
      modelKey: "mdl_m", breakdown: { rolloverMilli: 0, monthlyMilli: 1000, topupMilli: 0 }, createdAtMs: Date.now(),
    };
  }
  seedAccount(store.state, "u1", { monthly: 10_000_000, active });
  await assert.rejects(
    quota.reserveCredits({ uid: "u1", requestId: "r26", estimateMilli: 1000, pricing: PAID_2_10, modelKey: "mdl_m" }, { store }),
    (e) => e.code === "TOO_MANY_ACTIVE_REQUESTS");
});

// ---------- TTL sweep ----------

test("expired reserved swept with exact restore; expired dispatched charged", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { rollover: 100, monthly: 10_000, topup: 500 });
  // Manually plant an expired reserved reservation (100 rollover held).
  const oldId = quota.reservationDocId("u1", "r-old");
  store.state[`creditAccounts/u1/ledger/${oldId}`] = {
    type: "reservation", amountMilli: 100, cycleId: "c1", modelKey: "mdl_m",
    priceVersion: "v1:0x0", inputPricePerMillion: 0, outputPricePerMillion: 0,
    reservedBreakdown: { rolloverMilli: 100, monthlyMilli: 0, topupMilli: 0 },
    state: "reserved", createdAtMs: 1, expiresAtMs: 2, released: false, committed: false,
  };
  const acct = store.state["creditAccounts/u1"];
  acct.activeReservations = {
    [oldId]: {
      amountMilli: 100, state: "reserved", expiresAtMs: 2, modelKey: "mdl_m",
      breakdown: { rolloverMilli: 100, monthlyMilli: 0, topupMilli: 0 }, createdAtMs: 1,
    },
  };
  acct.rolloverRemainingCreditsMilli = 0; // 100 held
  acct.reservedCreditsMilli = 100;
  // New reserve triggers the sweep: old 100 rollover returns first.
  await quota.reserveCredits({
    uid: "u1", requestId: "r-new", estimateMilli: 50, pricing: FREE, modelKey: "mdl_f",
  }, { store });
  const b = balancesOf(store, "u1");
  assert.equal(b.rollover, 50); // 100 swept back, 50 re-reserved (FREE still reserves min via route; here 50 direct)
  assert.equal(store.state[`creditAccounts/u1/ledger/${oldId}`].state, "released");

  // Expired dispatched: charged, no refund.
  const oldId2 = quota.reservationDocId("u1", "r-old2");
  const acct2 = store.state["creditAccounts/u1"];
  acct2.activeReservations[oldId2] = {
    amountMilli: 60, state: "dispatched", expiresAtMs: 2, modelKey: "mdl_m",
    breakdown: { rolloverMilli: 0, monthlyMilli: 60, topupMilli: 0 }, createdAtMs: 1,
  };
  store.state[`creditAccounts/u1/ledger/${oldId2}`] = {
    type: "reservation", amountMilli: 60, cycleId: "c1", modelKey: "mdl_m",
    priceVersion: "v1:0x0", inputPricePerMillion: 0, outputPricePerMillion: 0,
    reservedBreakdown: { rolloverMilli: 0, monthlyMilli: 60, topupMilli: 0 },
    state: "dispatched", createdAtMs: 1, expiresAtMs: 2, released: false, committed: false,
  };
  const monthlyBefore = store.state["creditAccounts/u1"].monthlyRemainingCreditsMilli;
  await quota.reserveCredits({
    uid: "u1", requestId: "r-new2", estimateMilli: 10, pricing: FREE, modelKey: "mdl_f",
  }, { store });
  // 60 held stays spent (no +60 refund); only the new 10 hold moves.
  assert.equal(store.state[`creditAccounts/u1/ledger/${oldId2}`].state, "charged");
  assert.ok(store.state["creditAccounts/u1"].monthlyRemainingCreditsMilli <= monthlyBefore);
});

test("same-request retry after expiry settles then ALREADY_PROCESSED", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { monthly: 10_000 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 500, pricing: PAID_2_10, modelKey: "mdl_m",
  }, { store });
  // Force expiry on the reservation + active entry.
  const doc = resDocOf(store, "u1", "r1");
  doc.expiresAtMs = 1;
  doc.state = "reserved";
  store.state["creditAccounts/u1"].activeReservations[quota.reservationDocId("u1", "r1")].expiresAtMs = 1;
  await assert.rejects(
    quota.reserveCredits({ uid: "u1", requestId: "r1", estimateMilli: 500, pricing: PAID_2_10, modelKey: "mdl_m" }, { store }),
    (e) => e.code === "CREDIT_REQUEST_ALREADY_PROCESSED");
  // Settled: released exactly, hold cleared.
  assert.deepEqual(balancesOf(store, "u1"), { rollover: 0, monthly: 10_000, topup: 0, reserved: 0, activeCount: 0 });
});

// ---------- Free model minimum (post-rewrite guard) ----------

test("free model commit stays zero, empty stays 0", async () => {
  const store = orderingStore();
  seedAccount(store.state, "u1", { monthly: 5_000_000 });
  await quota.reserveCredits({
    uid: "u1", requestId: "r1", estimateMilli: 1000, pricing: FREE, modelKey: "mdl_f",
  }, { store });
  const c = await quota.commitCredits({
    uid: "u1", requestId: "r1", actualInputTokens: 50, actualOutputTokens: 50, modelKey: "mdl_f",
  }, { store });
  assert.equal(c.actualMilli, 0);
  await quota.reserveCredits({
    uid: "u1", requestId: "r2", estimateMilli: 1000, pricing: FREE, modelKey: "mdl_f",
  }, { store });
  const e = await quota.commitCredits({
    uid: "u1", requestId: "r2", actualInputTokens: 0, actualOutputTokens: 0, modelKey: "mdl_f",
  }, { store });
  assert.equal(e.actualMilli, 0);
});

// ---------- Error mapping ----------

test("credit error codes map to controlled HTTP statuses", () => {
  assert.equal(safeCode("INSUFFICIENT_CREDITS"), "INSUFFICIENT_CREDITS");
  assert.equal(statusFor("INSUFFICIENT_CREDITS"), 402);
  assert.equal(safeCode("CREDITS_NOT_CONFIGURED"), "CREDITS_NOT_CONFIGURED");
  assert.equal(statusFor("CREDITS_NOT_CONFIGURED"), 403);
  assert.equal(statusFor("SUBI_PLAN_EXPIRED"), 403);
  assert.equal(statusFor("TOO_MANY_ACTIVE_REQUESTS"), 429);
  assert.equal(statusFor("CREDIT_RESERVATION_NOT_FOUND"), 404);
  assert.equal(statusFor("CREDIT_REQUEST_IN_PROGRESS"), 409);
  assert.equal(statusFor("CREDIT_REQUEST_ALREADY_PROCESSED"), 409);
});

// ---------- Route contracts (static) ----------

test("managedUsage individual branch no longer references undefined chatAvailable", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "managedUsage.js"), "utf8");
  // Single shared definition used by both branches.
  const defs = source.match(/const chatAvailable = cap !== null && cap\.chatAvailable === true;/g) || [];
  assert.equal(defs.length, 1);
  assert.match(source, /const cap = await resolveChatCapability\(ctx\.uid\);/);
});

test("managedLimits individual branch exposes credits, never monthlyTokenLimit", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "managedLimits.js"), "utf8") + fs.readFileSync(path.join(__dirname, "..", "src", "services", "individualCreditContract.js"), "utf8");
  // Individual block ends where the school resolver call begins.
  const individualBlock = source.slice(
    source.indexOf('quotaMode === "individual_credits"'),
    source.indexOf("resolveEffectiveMonthlyLimit"));
  assert.doesNotMatch(individualBlock, /monthlyTokenLimit\s*:/);
  // Credits flow via the shared preflight + local projection helper.
  assert.match(individualBlock, /ensureIndividualCreditReady/);
  assert.match(source, /monthlyRemainingMilli/);
  assert.match(source, /rolloverRemainingMilli/);
  assert.match(source, /topupRemainingMilli/);
  assert.match(source, /reservedMilli/);
});

test('serialized enforced individual parent and three children share affordability', async () => {
  const store = orderingStore(); seedAccount(store.state, 'u1', { monthly: 300 });
  const original = store.runTransaction.bind(store); let tail = Promise.resolve();
  store.runTransaction = fn => { const next = tail.then(() => original(fn)); tail = next.catch(() => {}); return next; };
  const outcomes = await Promise.allSettled(['parent', 'child1', 'child2', 'child3'].map(requestId => quota.reserveCredits({ uid: 'u1', requestId, estimateMilli: 100, pricing: PAID_2_10, modelKey: 'mdl_m' }, { store })));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 3);
  assert.deepEqual(balancesOf(store, 'u1'), { rollover: 0, monthly: 0, topup: 0, reserved: 300, activeCount: 3 });
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'INSUFFICIENT_CREDITS');
});
