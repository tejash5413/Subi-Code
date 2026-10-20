// test/subiTopup.test.js — individual SUBI top-up packs (backend only).
// Pack validation, server quote math + freezing, tamper-proofing, active-only
// access, school refusal, idempotent grant, ledger, carry-forward, expiry
// retention, refund groundwork. Fakes only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DAY = 86_400_000;

function fakeDb(initial = {}) {
  const state = { ...initial };
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      return {
        _key: key,
        async get() {
          return { exists: key in state, data: () => state[key] };
        },
        async set(data, options) {
          if (options && options.merge && state[key] && typeof state[key] === "object") {
            state[key] = { ...state[key], ...data };
          } else {
            state[key] = data;
          }
        },
        collection: (sub) => coll(`${key}/${sub}`),
      };
    },
    limit: (n) => ({
      async get() {
        const docs = Object.entries(state)
          .filter(([k]) => k.startsWith(`${prefix}/`))
          .slice(0, n)
          .map(([k, v]) => ({ id: k.slice(prefix.length + 1), data: () => v }));
        return { docs };
      },
    }),
  });
  return {
    _state: state,
    collection: (name) => coll(name),
    async runTransaction(fn) {
      const tx = {
        set: (ref, data, options) => {
          if (options && options.merge && state[ref._key] && typeof state[ref._key] === "object") {
            state[ref._key] = { ...state[ref._key], ...data };
          } else {
            state[ref._key] = data;
          }
        },
        get: async (ref) => ({ exists: ref._key in state, data: () => state[ref._key] }),
      };
      return fn(tx);
    },
  };
}

const sharedDir = fakeDb();
const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { admin: {}, learnsmartDb: sharedDir, subiDb: fakeDb() },
};

const topup = require("../src/services/subiTopupService");
const economicsConfig = require('../src/services/individualCreditEconomicsConfig');
const billing = require("../src/services/subiBillingService");
const flags = require("../src/services/individualCreditFlags");
const { safeCode, statusFor } = require("../src/utils/redact");
const { topupQuoteCredits } = require("../src/services/individualCreditEconomics");
const { getUserProfile } = require("../src/services/learnsmartDirectoryService");

test('reconciliation cannot settle another user’s top-up order', async () => {
  const store = fakeDb({ 'subiTopupOrders/owned': { uid: 'owner', productType: 'subi_topup' } });
  let contacted = false;
  await assert.rejects(topup.reconcileOwnedTopupOrder({ uid: 'other', orderId: 'owned' }, { store, cashfree: { fetchCashfreeOrder: async () => { contacted = true; } } }), e => e.code === 'FORBIDDEN');
  assert.equal(contacted, false);
});

function seedActive(dirState, uid, sub = {}) {
  dirState[`users/${uid}`] = {
    uid, role: "student", accountType: "individual", schoolId: "",
    status: "active", email: `${uid}@test.dev`,
    phone: '9999999999', displayName: 'Buyer',
    subscription: {
      status: "active",
      renewalDateMs: Date.now() + 30 * DAY,
      subiCode: { enabled: true, renewalDateMs: Date.now() + 30 * DAY },
      ...sub,
    },
  };
}

function seedFx(subi, rate = 96.25) {
  subi._state["fxRates/USD_INR"] = {
    pair: "USD_INR", rate, source: "test", fetchedAtMs: 1,
    snapshotId: `USD_INR-1-${rate}`, updatedAt: new Date(1),
  };
}

function seedWallet(subi, uid, over = {}) {
  subi._state[`creditAccounts/${uid}`] = {
    uid, cycleId: "c1", cycleStartedAtMs: 1, cycleEndsAtMs: Date.now() + 30 * DAY,
    monthlyGrantCreditsMilli: 4_200_000, monthlyRemainingCreditsMilli: 4_200_000,
    rolloverGrantedCreditsMilli: 0, rolloverRemainingCreditsMilli: 0, rolloverExpiresAtMs: null,
    topupRemainingCreditsMilli: 0, reservedCreditsMilli: 0, activeReservations: {},
    fxSnapshot: null, economicsSnapshot: null, subscriptionActive: true, updatedAtMs: 1,
    ...over,
  };
}

function mockCashfree(over = {}) {
  return {
    verifyWebhookSignature: () => true,
    extractOrderId: (p) => (p && p.order_id) || null,
    extractPaymentId: () => "PAY-T1",
    isPaidStatus: (s) => String(s).toUpperCase() === "PAID",
    fetchCashfreeOrder: async () => ({ order_status: "PAID", order_amount: 0, order_tags: {} }),
    createCashfreeOrder: async () => ({ payment_session_id: "sess-t1" }),
    ...over,
  };
}

function buyerFor(uid) {
  return { name: "U", email: `${uid}@test.dev`, phone: "9999999999" };
}

async function fullTopupFlow(uid, pack, fxRate = 96.25, mockOver = {}) {
  const subi = fakeDb();
  seedFx(subi, fxRate);
  seedActive(sharedDir._state, uid);
  seedWallet(subi, uid);
  const base = { store: subi, directoryDb: sharedDir };
  const q = await topup.createTopupQuote({ uid, packPriceINR: pack }, base);
  const mock = mockCashfree(mockOver);
  const d = { ...base, cashfree: mock };
  const o = await topup.createTopupOrder({ uid, quoteId: q.quoteId, buyer: buyerFor(uid) }, d);
  // Server truth mirrors the stored order totals (as Cashfree would return).
  const stored = subi._state[`subiTopupOrders/${o.orderId}`];
  mock.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: stored.totalAmountINR, order_currency: "INR",
    order_tags: { productType: "subi_topup", quoteId: q.quoteId },
  });
  const body = (orderId) => ({ timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify({ order_id: orderId })) });
  const r = await billing.handleWebhook(body(o.orderId), d);
  return { subi, mock, d, quote: q, order: o, result: r, body };
}

// ---------- Pack validation ----------

test('configured packs apply to new quotes while disabled open quotes retain their frozen credits', async () => {
  const store = fakeDb(); seedFx(store); seedActive(sharedDir._state, 'pack-buyer');
  const values = { priceINR: 499, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: .8, topupMarginPct: .25, topupPacks: [{ packPriceINR: 399, enabled: true }] };
  await economicsConfig.setEconomicsConfig(values, { store });
  const q = await topup.createTopupQuote({ uid: 'pack-buyer', packPriceINR: 399 }, { store });
  await economicsConfig.setEconomicsConfig({ ...values, topupPacks: [{ packPriceINR: 399, enabled: false }], topupMarginPct: .5 }, { store });
  await assert.rejects(topup.createTopupQuote({ uid: 'pack-buyer', packPriceINR: 399 }, { store }), e => e.code === 'SUBI_TOPUP_PACK_INVALID');
  const open = await topup.requireValidTopupQuote({ uid: 'pack-buyer', quoteId: q.quoteId }, { store });
  assert.equal(open.creditsGranted, q.creditsGranted);
  assert.equal(open.configVersion, 2);
});

test("packs 199/499/999/1999 accepted; others rejected", async () => {
  const subi = fakeDb();
  seedFx(subi);
  seedActive(sharedDir._state, "tp1");
  const base = { store: subi, directoryDb: sharedDir };
  for (const pack of [199, 499, 999, 1999]) {
    const q = await topup.createTopupQuote({ uid: "tp1", packPriceINR: pack }, base);
    assert.equal(q.packPriceINR, pack);
    assert.equal(q.productType, "subi_topup");
  }
  for (const bad of [100, 200, 0, -5, "abc", null, undefined, 199.5, 5000]) {
    await assert.rejects(topup.createTopupQuote({ uid: "tp1", packPriceINR: bad }, base),
      (e) => e.code === "SUBI_TOPUP_PACK_INVALID", String(bad));
  }
});

// ---------- Quote math + GST ----------

test("quote math uses live FX/econ; GST integer-rupee convention", async () => {
  const subi = fakeDb();
  seedFx(subi, 96.25);
  seedActive(sharedDir._state, "tp2");
  const base = { store: subi, directoryDb: sharedDir };
  const cases = { 199: null, 499: null, 999: null, 1999: null };
  for (const pack of Object.keys(cases).map(Number)) {
    const q = await topup.createTopupQuote({ uid: "tp2", packPriceINR: pack }, base);
    const raw = topupQuoteCredits({ packINR: pack, fxRate: 96.25 });
    const expected = Math.floor(raw.credits / 50) * 50;
    assert.equal(q.creditsGranted, expected, `pack ${pack}`);
    assert.equal(q.creditsGrantedMilli, expected * 1000);
    assert.equal(q.gstAmountINR, Math.round(pack * 0.18), `pack ${pack} gst`);
    assert.equal(q.totalAmountINR, pack + Math.round(pack * 0.18));
    assert.equal(q.gstRate, 0.18);
    assert.equal(q.fxSnapshot.rate, 96.25);
    assert.ok(q.expiresAtMs > q.createdAtMs);
  }
  // Spec example: 199 @96.25/1.10/25% → raw 1409 → 1400.
  const q199 = await topup.createTopupQuote({ uid: "tp2", packPriceINR: 199 }, base);
  assert.equal(q199.creditsGranted, 1400);
});

test("expired quote rejected at order time", async () => {
  const subi = fakeDb();
  seedFx(subi);
  seedActive(sharedDir._state, "tp3");
  const base = { store: subi, directoryDb: sharedDir };
  const q = await topup.createTopupQuote({ uid: "tp3", packPriceINR: 199 }, base);
  subi._state[`subiTopupQuotes/${q.quoteId}`].expiresAtMs = Date.now() - 1000;
  await assert.rejects(
    topup.createTopupOrder({ uid: "tp3", quoteId: q.quoteId, buyer: buyerFor("tp3") }, { ...base, cashfree: mockCashfree() }),
    (e) => e.code === "SUBI_QUOTE_EXPIRED");
});

// ---------- Freezing + tampering ----------

test("FX change after quote/order still grants frozen credits", async () => {
  const { subi, order, result } = await fullTopupFlow("tp4", 199, 96.25);
  assert.equal(result.granted, true);
  // FX moves to 150 before webhook settlement would matter — grant is frozen.
  subi._state["fxRates/USD_INR"].rate = 150;
  const body = { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify({ order_id: order.orderId })) };
  const r2 = await billing.handleWebhook(body, { store: subi, directoryDb: sharedDir, cashfree: mockCashfree() });
  assert.equal(r2.duplicate, true);
  const acct = subi._state["creditAccounts/tp4"];
  assert.equal(acct.topupRemainingCreditsMilli, 1400 * 1000);
});

test("tampered price/credits/GST/FX/uid rejected or ignored", async () => {
  const subi = fakeDb();
  seedFx(subi);
  seedActive(sharedDir._state, "tp5");
  seedActive(sharedDir._state, "tp5b");
  const base = { store: subi, directoryDb: sharedDir };
  const q = await topup.createTopupQuote({ uid: "tp5", packPriceINR: 199 }, base);
  const doc = subi._state[`subiTopupQuotes/${q.quoteId}`];
  // Tampered price total.
  doc.totalAmountINR = 1;
  await assert.rejects(
    topup.createTopupOrder({ uid: "tp5", quoteId: q.quoteId, buyer: buyerFor("tp5") }, { ...base, cashfree: mockCashfree() }),
    (e) => e.code === "SUBI_QUOTE_INVALID");
  doc.totalAmountINR = 199 + Math.round(199 * 0.18);
  // Tampered credits (frozen grant must match quote math, not stored value).
  doc.creditsGrantedMilli = 999_999_000;
  await assert.rejects(
    topup.createTopupOrder({ uid: "tp5", quoteId: q.quoteId, buyer: buyerFor("tp5") }, { ...base, cashfree: mockCashfree() }),
    (e) => e.code === "SUBI_QUOTE_INVALID");
  // Wrong uid cannot use another user's quote.
  await assert.rejects(
    topup.createTopupOrder({ uid: "tp5b", quoteId: q.quoteId, buyer: buyerFor("tp5b") }, { ...base, cashfree: mockCashfree() }),
    (e) => e.code === "SUBI_QUOTE_INVALID");
});

// ---------- Access control ----------

test("inactive SUBI: quote unavailable (expired vs missing)", async () => {
  const subi = fakeDb();
  seedFx(subi);
  const past = Date.now() - DAY;
  sharedDir._state["users/tp6"] = {
    uid: "tp6", role: "student", accountType: "individual", schoolId: "", status: "active",
    subscription: { status: "active", renewalDateMs: past, subiCode: { enabled: true, renewalDateMs: past } },
  };
  sharedDir._state["users/tp6b"] = {
    uid: "tp6b", role: "student", accountType: "individual", schoolId: "", status: "active",
    subscription: null,
  };
  const base = { store: subi, directoryDb: sharedDir };
  await assert.rejects(topup.createTopupQuote({ uid: "tp6", packPriceINR: 199 }, base),
    (e) => e.code === "SUBI_PLAN_EXPIRED");
  await assert.rejects(topup.createTopupQuote({ uid: "tp6b", packPriceINR: 199 }, base),
    (e) => e.code === "SUBI_CODE_REQUIRED");
});

test("school: no quote, no order, no grant", async () => {
  const subi = fakeDb();
  seedFx(subi);
  sharedDir._state["users/sch9"] = { uid: "sch9", role: "student", accountType: "school", schoolId: "s1" };
  const base = { store: subi, directoryDb: sharedDir };
  await assert.rejects(topup.createTopupQuote({ uid: "sch9", packPriceINR: 199 }, base),
    (e) => e.code === "SUBI_WRONG_ACCOUNT_TYPE");
  // Seeded hostile order for a school user → webhook blocks, no wallet.
  subi._state["subiTopupOrders/SUBIT-x"] = {
    orderId: "SUBIT-x", quoteId: "q", uid: "sch9", product: "subi_topup",
    productType: "subi_topup", packPriceINR: 199, gstRate: 0.18, gstAmountINR: 36,
    totalAmountINR: 235, currency: "INR", creditsGranted: 1400, creditsGrantedMilli: 1400_000,
    fxSnapshot: { rate: 96.25 }, economicsSnapshot: {}, status: "created",
  };
  subi._state["subiTopupQuotes/q"] = {
    quoteId: "q", uid: "sch9", product: "subi_topup", productType: "subi_topup",
    packPriceINR: 199, gstRate: 0.18, gstAmountINR: 36, totalAmountINR: 235, currency: "INR",
    creditsGranted: 1400, creditsGrantedMilli: 1400_000, fxSnapshot: {}, economicsSnapshot: {},
    status: "consumed", createdAtMs: 1, expiresAtMs: Date.now() + DAY, consumedOrderId: "SUBIT-x",
  };
  const mock = mockCashfree();
  mock.fetchCashfreeOrder = async () => ({
    order_status: "PAID", order_amount: 235,
    order_tags: { productType: "subi_topup", quoteId: "q" },
  });
  const r = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify({ order_id: "SUBIT-x" })) },
    { ...base, cashfree: mock });
  assert.equal(r.granted || false, false);
  assert.equal(subi._state["creditAccounts/sch9"], undefined);
});

// ---------- Success path: wallet + ledger ----------

test("successful payment increases only topup bucket + immutable ledger", async () => {
  const { subi, order, result } = await fullTopupFlow("tp7", 499);
  assert.equal(result.granted, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.creditsGrantedMilli, result.creditsGranted * 1000);
  const acct = subi._state["creditAccounts/tp7"];
  assert.equal(acct.topupRemainingCreditsMilli, result.creditsGrantedMilli);
  assert.equal(acct.monthlyRemainingCreditsMilli, 4_200_000, "monthly untouched");
  assert.equal(acct.rolloverRemainingCreditsMilli, 0, "rollover untouched");
  const ledgerId = `creditAccounts/tp7/ledger/topup-${order.orderId}`;
  const entry = subi._state[ledgerId];
  assert.equal(entry.type, "topup_purchase");
  assert.equal(entry.orderId, order.orderId);
  assert.equal(entry.amountMilli, result.creditsGrantedMilli);
  assert.equal(entry.balanceAfterMilli, result.creditsGrantedMilli);
  assert.ok(entry.fxSnapshot && entry.economicsSnapshot);
  assert.equal(subi._state[`subiTopupOrders/${order.orderId}`].status, "granted");
});

test("duplicate webhook x5: one grant, one increment, one ledger", async () => {
  const { subi, order, result, body, d } = await fullTopupFlow("tp8", 199);
  assert.equal(result.granted, true);
  const before = subi._state["creditAccounts/tp8"].topupRemainingCreditsMilli;
  for (let i = 0; i < 5; i += 1) {
    const r = await billing.handleWebhook(body(order.orderId), d);
    assert.equal(r.duplicate, true);
  }
  const after = subi._state["creditAccounts/tp8"].topupRemainingCreditsMilli;
  assert.equal(after, before, "no additional increments");
  const topupLedgers = Object.keys(subi._state).filter((k) => k.includes(`/ledger/topup-${order.orderId}`));
  assert.deepEqual(topupLedgers, [`creditAccounts/tp8/ledger/topup-${order.orderId}`]);
});

// ---------- Carry-forward + expiry ----------

test("next monthly cycle preserves full purchased balance (no 80%)", async () => {
  const { subi } = await fullTopupFlow("tp9", 199);
  const before = subi._state["creditAccounts/tp9"].topupRemainingCreditsMilli;
  assert.ok(before > 0);
  // Advance the monthly cycle via the real cycle engine with a new period.
  const cycle = require("../src/services/individualCreditCycleService");
  const now = Date.now();
  const out = await cycle.ensureCurrentCreditCycle({
    uid: "tp9",
    accountType: "individual",
    userSubscription: { subiCodeActive: true, renewalDateMs: now + 60 * DAY },
    paidPeriodStartMs: now - 1000,
    paidPeriodEndMs: now + 30 * DAY,
    fxRate: 96.25,
  }, { store: subi });
  assert.equal(out.alreadyGranted, false);
  const after = subi._state["creditAccounts/tp9"].topupRemainingCreditsMilli;
  assert.equal(after, before, "100% carry, never multiplied by 80%");
});

test("expired subscription retains topup balance; usage blocked; renewal reuses", async () => {
  const { subi } = await fullTopupFlow("tp10", 199);
  const kept = subi._state["creditAccounts/tp10"].topupRemainingCreditsMilli;
  assert.ok(kept > 0);
  // Expire the SUBI subscription (wallet untouched).
  const raw = sharedDir._state["users/tp10"];
  const past = Date.now() - DAY;
  raw.subscription.subiCode.renewalDateMs = past;
  raw.subscription.renewalDateMs = past;
  const profile = await getUserProfile("tp10");
  const ent = require("../src/services/subiCodeEntitlementService");
  const decision = ent.evaluateSubiCodeEntitlement({
    accountType: "individual", userSubscription: profile.subscription, schoolSubscription: null,
  });
  assert.equal(decision.allowed, false, "usage blocked while expired");
  assert.equal(decision.code, "SUBI_PLAN_EXPIRED");
  assert.equal(subi._state["creditAccounts/tp10"].topupRemainingCreditsMilli, kept, "balance retained, nothing erased");
  // Top-up quote unavailable while expired.
  await assert.rejects(
    topup.createTopupQuote({ uid: "tp10", packPriceINR: 199 }, { store: subi, directoryDb: sharedDir }),
    (e) => e.code === "SUBI_PLAN_EXPIRED");
});

// ---------- Negative paths ----------

test("wrong amount / wrong product / failed payment: no grant", async () => {
  const subi = fakeDb();
  seedFx(subi);
  seedActive(sharedDir._state, "tp11");
  seedWallet(subi, "tp11");
  const base = { store: subi, directoryDb: sharedDir };
  async function paidFlow(uid, pack, mutateFetch) {
    const q = await topup.createTopupQuote({ uid, packPriceINR: pack }, base);
    const mock = mockCashfree();
    const d = { ...base, cashfree: mock };
    const o = await topup.createTopupOrder({ uid, quoteId: q.quoteId, buyer: buyerFor(uid) }, d);
    const stored = subi._state[`subiTopupOrders/${o.orderId}`];
    mock.fetchCashfreeOrder = async (orderId) => mutateFetch(orderId, stored, q);
    const r = await billing.handleWebhook(
      { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify({ order_id: o.orderId })) }, d);
    return { order: o, result: r };
  }
  const wrongAmt = await paidFlow("tp11", 199, (orderId, stored, q) => ({
    order_id: orderId, order_status: "PAID", order_amount: stored.totalAmountINR + 1,
    order_tags: { productType: "subi_topup", quoteId: q.quoteId },
  }));
  assert.equal(wrongAmt.result.granted || false, false);
  const wrongProd = await paidFlow("tp11", 499, (orderId, stored, q) => ({
    order_id: orderId, order_status: "PAID", order_amount: stored.totalAmountINR,
    order_tags: { productType: "subi_subscription", quoteId: q.quoteId },
  }));
  assert.equal(wrongProd.result.granted || false, false);
  const failed = await paidFlow("tp11", 999, (orderId) => ({
    order_id: orderId, order_status: "FAILED", order_amount: 0, order_tags: {},
  }));
  assert.equal(failed.result.granted || false, false);
  assert.equal(subi._state["creditAccounts/tp11"].topupRemainingCreditsMilli, 0, "no credits from bad payments");
});

// ---------- Refund groundwork ----------

test("refund: full-unused reverses deterministically; partial needs review; no negatives", async () => {
  const { subi } = await fullTopupFlow("tp12", 199);
  const orderId = Object.keys(subi._state)
    .find((k) => k.startsWith("subiTopupOrders/"))
    .slice("subiTopupOrders/".length);
  const granted = subi._state[`subiTopupOrders/${orderId}`].creditsGrantedMilli;
  // Full unused → reversal.
  const r1 = await topup.refundTopup({ uid: "tp12", orderId }, { store: subi });
  assert.equal(r1.refunded, true);
  assert.equal(subi._state["creditAccounts/tp12"].topupRemainingCreditsMilli, 0);
  assert.equal(subi._state[`subiTopupOrders/${orderId}`].status, "refunded");
  const reversal = subi._state[`creditAccounts/tp12/ledger/topup-refund-${orderId}`];
  assert.equal(reversal.type, "topup_reversal");
  assert.equal(reversal.amountMilli, -granted);
  // Original purchase ledger untouched.
  assert.equal(subi._state[`creditAccounts/tp12/ledger/topup-${orderId}`].type, "topup_purchase");
  // Idempotent repeat.
  const r1b = await topup.refundTopup({ uid: "tp12", orderId }, { store: subi });
  assert.equal(r1b.duplicate, true);

  // Partially consumed → review, no deduction, no negative.
  const f2 = await fullTopupFlow("tp13", 199);
  const oid2 = f2.order.orderId;
  f2.subi._state["creditAccounts/tp13"].topupRemainingCreditsMilli = 100_000; // spent most
  const r2 = await topup.refundTopup({ uid: "tp13", orderId: oid2 }, { store: f2.subi });
  assert.equal(r2.refunded, false);
  assert.equal(r2.reason, "TOPUP_REFUND_REVIEW_REQUIRED");
  assert.equal(r2.review, true);
  assert.equal(f2.subi._state["creditAccounts/tp13"].topupRemainingCreditsMilli, 100_000);
  assert.equal(f2.subi._state[`subiTopupOrders/${oid2}`].status, "refund_review");
});

// ---------- Flags + routes ----------

test("topupsEnabled defaults false; topup routes gate on it", () => {
  assert.equal(flags.DEFAULTS.topupsEnabled, false);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "billing.js"), "utf8");
  const quoteIdx = source.indexOf("/subi/topups/quote");
  const orderIdx = source.indexOf("/subi/topups/order\"");
  assert.ok(quoteIdx > 0 && orderIdx > 0);
  assert.match(source.slice(quoteIdx, quoteIdx + 400), /topupsEnabled/);
  assert.match(source.slice(orderIdx, orderIdx + 400), /topupsEnabled/);
  // Webhook settles regardless of flag (money moved) — no flag check on webhook path.
  const webhookIdx = source.indexOf("/subi/billing/webhook");
  assert.doesNotMatch(source.slice(webhookIdx, webhookIdx + 600), /topupsEnabled|billingEnabled/);
});

test("new topup codes map to controlled statuses", () => {
  assert.equal(statusFor("SUBI_TOPUP_PACK_INVALID"), 400);
  assert.equal(statusFor("SUBI_TOPUP_QUOTE_FAILED"), 503);
  assert.equal(safeCode("SUBI_TOPUP_PACK_INVALID"), "SUBI_TOPUP_PACK_INVALID");
  assert.equal(safeCode("SUBI_TOPUP_QUOTE_FAILED"), "SUBI_TOPUP_QUOTE_FAILED");
});
