// test/subiBilling.test.js — individual ₹499 SUBI billing (single plan).
// Quote math, tamper-proofing, webhook verify + idempotency, early/expired
// renewal, FX-failure separation, legacy compat, school refusal. Fakes only.
const test = require("node:test");
const assert = require("node:assert/strict");

const DAY = 86_400_000;

// ---- Fake Firestore (shared state for directory + subi reads/writes) ----
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
    where: (field, op, value) => query(prefix, [[field, op, value]]),
    orderBy: (field, direction) => query(prefix, [], field, direction),
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
  function query(prefix, filters = [], field, direction = 'asc', count = 100) {
    return {
      where: (key, op, value) => query(prefix, [...filters, [key, op, value]], field, direction, count),
      orderBy: (key, dir) => query(prefix, filters, key, dir, count),
      limit: n => query(prefix, filters, field, direction, n),
      get: async () => ({ docs: Object.entries(state).filter(([key, data]) => key.startsWith(prefix + '/') && !key.slice(prefix.length + 1).includes('/') && filters.every(([f, op, v]) => op === '<=' ? data[f] <= v : op === '>' ? data[f] > v : data[f] === v)).sort((a, b) => (a[1][field] - b[1][field]) * (direction === 'desc' ? -1 : 1)).slice(0, count).map(([key, data]) => ({ id: key.slice(prefix.length + 1), data: () => data })) }),
    };
  }
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

// Install shared fake BEFORE requiring services (directory has no DI).
const sharedDir = fakeDb();
const dbPath = require.resolve("../src/db");
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { admin: {}, learnsmartDb: sharedDir, subiDb: fakeDb() },
};

const billingConfig = require("../src/services/subiBillingConfig");
const periodSvc = require("../src/services/subiBillingPeriodService");
const quoteSvc = require("../src/services/subiPurchaseQuoteService");
const billing = require("../src/services/subiBillingService");
const economicsConfig = require("../src/services/individualCreditEconomicsConfig");

test('commercial price edits preserve open subscription quotes and version their funding', async () => {
  const store = fakeDb();
  const values = { priceINR: 699, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: 0.8, topupMarginPct: 0.25, adminUid: 'admin' };
  const first = await economicsConfig.setEconomicsConfig(values, { store });
  assert.equal(first.configVersion, 2);
  seedIndividual(sharedDir._state, 'version-buyer');
  const q = await billing.createQuote({ uid: 'version-buyer' }, { store });
  assert.equal(q.baseAmountINR, 699);
  assert.equal(q.totalAmountINR, 825);
  assert.equal(q.configVersion, 2);
  await economicsConfig.setEconomicsConfig({ ...values, priceINR: 899, expectedConfigVersion: 2 }, { store });
  const existing = await quoteSvc.requireValidQuote({ uid: 'version-buyer', quoteId: q.quoteId }, { store });
  assert.equal(existing.baseAmountINR, 699);
  assert.equal(existing.economicsSnapshot.priceINR, 699);
  await assert.rejects(economicsConfig.setEconomicsConfig({ ...values, expectedConfigVersion: 2 }, { store }), e => e.code === 'INVALID_REQUEST');
});

test('paid SUBI uses quoted funding after a price edit and keeps education expiry independent', async () => {
  const store = fakeDb(); seedFx(store); seedIndividual(sharedDir._state, 'frozen-buyer');
  const educationEnd = new Date(Date.now() + DAY * 10);
  sharedDir._state['users/frozen-buyer'].subscription.renewalDate = educationEnd;
  sharedDir._state['users/frozen-buyer'].renewalDate = educationEnd;
  const q = await billing.createQuote({ uid: 'frozen-buyer' }, { store });
  await economicsConfig.setEconomicsConfig({ priceINR: 999, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: .8, topupMarginPct: .25 }, { store });
  const cf = mockCashfree({ quoteId: q.quoteId });
  const deps = depsFor(store, cf);
  const order = await billing.createOrder({ uid: 'frozen-buyer', quoteId: q.quoteId }, deps);
  assert.equal(order.amounts.baseAmountINR, 499);
  await billing.handleWebhook({ timestamp: 't', signature: 's', rawBody: Buffer.from(JSON.stringify({ order_id: order.orderId })) }, deps);
  assert.equal(store._state['creditAccounts/frozen-buyer'].monthlyGrantCreditsMilli, 4200000);
  assert.equal(sharedDir._state['users/frozen-buyer'].subscription.renewalDate, educationEnd);
  assert.equal(sharedDir._state['users/frozen-buyer'].renewalDate, educationEnd);
});

test('checkout retries after an ambiguous provider timeout reuse one durable order intent', async () => {
  const store = fakeDb(); seedIndividual(sharedDir._state, 'intent-buyer');
  const q = await billing.createQuote({ uid: 'intent-buyer' }, { store });
  const ids = [];
  const cf = mockCashfree({ createCashfreeOrder: async ({ orderId }) => {
    ids.push(orderId);
    if (ids.length === 1) throw Object.assign(new Error('timeout'), { code: 'SUBI_BILLING_UNAVAILABLE' });
    return { payment_session_id: 'recovered-session' };
  } });
  const args = { uid: 'intent-buyer', quoteId: q.quoteId };
  await assert.rejects(billing.createOrder(args, depsFor(store, cf)));
  const recovered = await billing.createOrder(args, depsFor(store, cf));
  assert.equal(recovered.paymentSessionId, 'recovered-session');
  assert.equal(new Set(ids).size, 1);
  assert.equal(Object.keys(store._state).filter(k => k.startsWith('subiBillingOrders/')).length, 1);
  assert.equal(store._state[`subiBillingQuotes/${q.quoteId}`].consumedOrderId, recovered.orderId);
});

test('older payment replay after a later renewal never extends paid coverage again', async () => {
  const { activateSubiSubscription } = require('../src/services/subiSubscriptionWriter');
  seedIndividual(sharedDir._state, 'old-callback');
  const args = { uid: 'old-callback', billingMonths: 1, nowMs: Date.now() };
  const first = await activateSubiSubscription({ ...args, orderId: 'first' }, { directoryDb: sharedDir });
  const second = await activateSubiSubscription({ ...args, orderId: 'second' }, { directoryDb: sharedDir });
  const again = await activateSubiSubscription({ ...args, orderId: 'first' }, { directoryDb: sharedDir });
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.appliedPeriod, first.appliedPeriod);
  assert.equal(sharedDir._state['users/old-callback'].subscription.subiCode.paidThroughMs, second.appliedPeriod.paidThroughMs);
});

test('early renewal freezes next-cycle funding while current credits stay unchanged', async () => {
  const { subi, d } = await runFirstPayment('future-funding');
  const firstCycle = { ...subi._state['creditAccounts/future-funding'] };
  await economicsConfig.setEconomicsConfig({ priceINR: 699, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: .8, topupMarginPct: .25 }, { store: subi });
  const q = await billing.createQuote({ uid: 'future-funding' }, { store: subi });
  const cf = mockCashfree({ fetchCashfreeOrder: async () => ({ order_status: 'PAID', order_amount: 825, order_currency: 'INR', order_tags: { productType: 'subi_subscription', quoteId: q.quoteId } }) });
  const order = await billing.createOrder({ uid: 'future-funding', quoteId: q.quoteId }, { ...d, cashfree: cf });
  await billing.handleWebhook({ timestamp: 't', signature: 's', rawBody: Buffer.from(JSON.stringify({ order_id: order.orderId })) }, { ...d, cashfree: cf });
  assert.equal(subi._state['creditAccounts/future-funding'].cycleId, firstCycle.cycleId);
  assert.equal(subi._state['creditAccounts/future-funding'].monthlyGrantCreditsMilli, 4200000);
  await economicsConfig.setEconomicsConfig({ priceINR: 999, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: .8, topupMarginPct: .25 }, { store: subi });
  const advanced = await billing.ensureCurrentCreditCycleFromSubscription('future-funding', { ...d, nowMs: firstCycle.cycleEndsAtMs + 1 });
  assert.equal(advanced.monthlyGrantCreditsMilli, 6100000);
  assert.equal(advanced.economicsSnapshot.priceINR, 699);
});
test('the production readiness path grants the paid snapshot after a later admin price edit', async () => {
  const { ensureIndividualCreditReady } = require('../src/services/individualCreditReadyService');
  const { subi, d } = await runFirstPayment('ready-funding');
  const first = { ...subi._state['creditAccounts/ready-funding'] };
  await economicsConfig.setEconomicsConfig({ priceINR: 699, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: .8, topupMarginPct: .25 }, { store: subi });
  const q = await billing.createQuote({ uid: 'ready-funding' }, { store: subi });
  const cf = mockCashfree({ fetchCashfreeOrder: async () => ({ order_status: 'PAID', order_amount: 825, order_currency: 'INR', order_tags: { productType: 'subi_subscription', quoteId: q.quoteId } }) });
  const order = await billing.createOrder({ uid: 'ready-funding', quoteId: q.quoteId }, { ...d, cashfree: cf });
  await billing.handleWebhook({ timestamp: 't', signature: 's', rawBody: Buffer.from(JSON.stringify({ order_id: order.orderId })) }, { ...d, cashfree: cf });
  await economicsConfig.setEconomicsConfig({ priceINR: 999, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: .8, topupMarginPct: .25 }, { store: subi });
  const advanced = await ensureIndividualCreditReady({ uid: 'ready-funding', accountType: 'individual' }, { ...d, nowMs: first.cycleEndsAtMs + 1 });
  assert.equal(advanced.economicsSnapshot.priceINR, 699);
  assert.equal(advanced.monthlyGrantCreditsMilli, 6100000);
});
test('legacy renewal preserves wallet bounds on refresh and uses funding at the actual paid extension', async () => {
  const uid = 'legacy-wallet', store = fakeDb(); seedFx(store);
  const nowMs = Date.now(), start = nowMs - 5 * DAY, end = periodSvc.addCalendarMonths(start, 1), legacyEnd = nowMs + 90 * DAY;
  seedIndividual(sharedDir._state, uid, { subiCode: { enabled: true, renewalDateMs: legacyEnd } });
  const cycle = require('../src/services/individualCreditCycleService');
  await cycle.ensureCurrentCreditCycle({ uid, accountType: 'individual', userSubscription: { subiCodeActive: true, renewalDateMs: legacyEnd }, paidPeriodStartMs: start, paidPeriodEndMs: end, nowMs }, { store });
  const before = { ...store._state[`creditAccounts/${uid}`] };
  const q = await billing.createQuote({ uid }, { store }); const cf = mockCashfree({ quoteId: q.quoteId }); const d = depsFor(store, cf);
  const order = await billing.createOrder({ uid, quoteId: q.quoteId }, d);
  await billing.handleWebhook({ timestamp: 't', signature: 's', rawBody: Buffer.from(JSON.stringify({ order_id: order.orderId })) }, d);
  const refreshed = await billing.ensureCurrentCreditCycleFromSubscription(uid, { ...d, nowMs });
  assert.equal(refreshed.cycleId, before.cycleId);
  assert.equal(sharedDir._state[`users/${uid}`].subscription.subiCode.periodStartMs, start);
  await economicsConfig.setEconomicsConfig({ priceINR: 999, bufferINR: 50, providerFundingMultiplier: 1.1, rolloverPct: .8, topupMarginPct: .25 }, { store });
  const next = await billing.ensureCurrentCreditCycleFromSubscription(uid, { ...d, nowMs: legacyEnd + 1 });
  assert.equal(next.cycleStartedAtMs, legacyEnd);
  assert.equal(next.economicsSnapshot.priceINR, 499);
});
const cashfreeReal = require("../src/services/subiCashfreeService");
test('Cashfree retries send one valid deterministic UUID per payment order', async () => {
  const keys = [];
  const d = { clientId: 'test-client', clientSecret: 'test-secret', fetchImpl: async (_url, options) => { keys.push(options.headers['x-idempotency-key']); return { ok: true, json: async () => ({ payment_session_id: 'test-session' }) }; } };
  const quote = { uid: 'buyer', quoteId: 'q', productType: 'subi_subscription', billingMonths: 1, baseAmountINR: 499, gstRate: .18, gstAmountINR: 90, totalAmountINR: 589, currency: 'INR' };
  for (const orderId of ['SUBI-order-one', 'SUBI-order-one', 'SUBI-order-two']) await cashfreeReal.createCashfreeOrder({ orderId, quote, buyer: { name: 'Buyer', email: 'buyer@test.dev', phone: '9999999999' } }, d);
  assert.equal(keys[0], keys[1]); assert.notEqual(keys[0], keys[2]);
  for (const key of keys) assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
const flags = require("../src/services/individualCreditFlags");
const { safeCode, statusFor } = require("../src/utils/redact");
const { getUserProfile } = require("../src/services/learnsmartDirectoryService");

function seedIndividual(dirState, uid, sub = {}) {
  dirState[`users/${uid}`] = {
    uid, role: "student", accountType: "individual", schoolId: "",
    status: "active", email: `${uid}@test.dev`,
    phone: '9999999999', displayName: 'Buyer',
    subscription: { status: "active", ...sub },
  };
}

function seedFx(subi, rate = 96.25) {
  subi._state["fxRates/USD_INR"] = {
    pair: "USD_INR", rate, source: "test", fetchedAtMs: 1,
    snapshotId: `USD_INR-1-${rate}`, updatedAt: new Date(1),
  };
}

function mockCashfree(over = {}) {
  return {
    verifyWebhookSignature: () => true,
    extractOrderId: (p) => (p && p.order_id) || null,
    extractPaymentId: () => "PAY-1",
    isPaidStatus: (s) => String(s).toUpperCase() === "PAID",
    fetchCashfreeOrder: async (orderId) => ({
      order_id: orderId, order_status: "PAID", order_amount: 589, order_currency: "INR",
      order_tags: { productType: "subi_subscription", quoteId: over.quoteId || "q" },
    }),
    createCashfreeOrder: async () => ({ payment_session_id: "sess-1", order_id: "x" }),
    ...over,
  };
}

function depsFor(subi, mock) {
  return { store: subi, directoryDb: sharedDir, cashfree: mock || mockCashfree() };
}

function webhookBody(orderId, extra = {}) {
  return { order_id: orderId, ...extra };
}

// ---------- Quote math + GST ----------

test("quote: 499 base, 18% GST, Math.round rupees total 589", async () => {
  const amounts = billingConfig.buildSubiQuoteAmounts({});
  assert.equal(amounts.baseAmountINR, 499);
  assert.equal(amounts.gstRate, 0.18);
  assert.equal(amounts.gstAmountINR, 90); // round(89.82), project convention
  assert.equal(amounts.totalAmountINR, 589);
  assert.equal(amounts.billingMonths, 1);
  assert.equal(amounts.productType, "subi_subscription");
});

test("quote creation is server-side; tampered stored quote rejected", async () => {
  const subi = fakeDb();
  seedIndividual(sharedDir._state, "u1");
  const q = await billing.createQuote({ uid: "u1" }, { store: subi, directoryDb: sharedDir });
  assert.equal(q.totalAmountINR, 589);
  assert.equal(q.status, "created");
  // Tamper the stored doc (simulates client/DB meddling with price).
  subi._state[`subiBillingQuotes/${q.quoteId}`].totalAmountINR = 1;
  await assert.rejects(
    billing.createOrder({
      uid: "u1", quoteId: q.quoteId,
      buyer: { name: "A", email: "u1@test.dev", phone: "9999999999" },
    }, depsFor(subi)),
    (e) => e.code === "SUBI_QUOTE_INVALID");
});

test("school user cannot get a quote", async () => {
  const subi = fakeDb();
  sharedDir._state["users/s1"] = { uid: "s1", role: "student", accountType: "school", schoolId: "sch" };
  await assert.rejects(billing.createQuote({ uid: "s1" }, { store: subi, directoryDb: sharedDir }),
    (e) => e.code === "SUBI_WRONG_ACCOUNT_TYPE");
});

// ---------- Billing period resolver ----------

test("period resolver: fresh, early extension, malformed", () => {
  const now = Date.now();
  const fresh = periodSvc.resolveSubiPaidPeriod({ existing: null, nowMs: now, billingMonths: 1 });
  assert.equal(fresh.periodStartMs, Math.floor(now));
  assert.ok(fresh.periodEndMs > now);
  assert.equal(fresh.extended, false);
  const prev = { periodStartMs: now - 20 * DAY, paidThroughMs: now + 10 * DAY };
  const ext = periodSvc.resolveSubiPaidPeriod({ existing: prev, nowMs: now, billingMonths: 1 });
  assert.equal(ext.extended, true);
  assert.equal(ext.periodStartMs, prev.periodStartMs); // anchor preserved
  assert.ok(ext.periodEndMs > prev.paidThroughMs); // no overlap
  const bounds = periodSvc.resolveCycleBoundsForNow({
    previous: { ...prev, periodEndMs: prev.paidThroughMs }, coverage: ext, nowMs: now,
  });
  assert.deepEqual(bounds, { paidPeriodStartMs: prev.periodStartMs, paidPeriodEndMs: prev.paidThroughMs });
  assert.throws(() => periodSvc.resolveSubiPaidPeriod({ existing: null, nowMs: 0 }), /nowMs/);
  // Malformed-but-active coverage fails closed; expired malformed is ignored (fresh start).
  assert.throws(() => periodSvc.resolveSubiPaidPeriod({
    existing: { periodStartMs: now + 20 * DAY, paidThroughMs: now + 10 * DAY }, nowMs: now,
  }), /malformed/);
  const expiredMalformed = periodSvc.resolveSubiPaidPeriod({
    existing: { periodStartMs: 5, paidThroughMs: 1 }, nowMs: now,
  });
  assert.equal(expiredMalformed.extended, false);
});

// ---------- First payment → entitlement + cycle ----------

async function runFirstPayment(uid = "u1", fxRate = 96.25) {
  const subi = fakeDb();
  seedFx(subi, fxRate);
  seedIndividual(sharedDir._state, uid);
  const mock = mockCashfree();
  const d = depsFor(subi, mock);
  const q = await billing.createQuote({ uid }, { store: subi, directoryDb: sharedDir });
  mock.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: 589, order_currency: "INR",
    order_tags: { productType: "subi_subscription", quoteId: q.quoteId },
  });
  const order = await billing.createOrder({
    uid, quoteId: q.quoteId,
    buyer: { name: "U", email: `${uid}@test.dev`, phone: "9999999999" },
    returnUrl: "https://x.test/purchase",
  }, d);
  const out = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(order.orderId))) }, d);
  return { subi, mock, d, quote: q, order, out };
}

test("successful first payment: entitlement active, period stored, cycle granted once", async () => {
  const { subi, order, out } = await runFirstPayment("u1");
  assert.equal(out.received, true);
  assert.equal(out.activated, true);
  assert.equal(out.cycleGranted, true);
  assert.equal(out.cycleError, null);
  // Entitlement recognizes the new schema (tierless).
  const profile = await getUserProfile("u1");
  assert.equal(profile.accountType, "individual");
  assert.equal(profile.subscription.subiCodeActive, true);
  assert.ok(profile.subscription.renewalDateMs > Date.now());
  assert.ok(profile.subscription.periodStartMs > 0);
  // Cycle grant ≈ 4200 credits at FX 96.25 (dynamic, not hard-coded).
  const acct = subi._state["creditAccounts/u1"];
  assert.equal(acct.monthlyGrantCreditsMilli, 4_200_000);
  assert.equal(acct.subscriptionActive, true);
  assert.equal(acct.fxSnapshot.rate, 96.25);
  assert.ok(subi._state[`creditAccounts/u1/ledger/grant-${acct.cycleId}`]);
  // Purchase record immutable audit.
  const rec = subi._state[`subiBillingOrders/${order.orderId}`];
  assert.equal(rec.status, "success");
  assert.equal(rec.baseAmountINR, 499);
  assert.equal(rec.gstRate, 0.18);
  assert.equal(rec.totalAmountINR, 589);
  assert.equal(rec.paymentId, "PAY-1");
});

test("duplicate webhook ×3: one extension, one grant, duplicate:true", async () => {
  const { subi, order, out, d } = await runFirstPayment("u2");
  assert.equal(out.duplicate, false);
  const body = { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(order.orderId))) };
  const r2 = await billing.handleWebhook(body, d);
  const r3 = await billing.handleWebhook(body, d);
  assert.equal(r2.duplicate, true);
  assert.equal(r3.duplicate, true);
  const grants = Object.keys(subi._state).filter((k) => k.includes("/ledger/grant-"));
  assert.equal(grants.length, 1);
  // Single extension: raw doc keeps the first orderId (normalizer drops it).
  assert.equal(sharedDir._state["users/u2"].subscription.subiCode.lastPaymentOrderId, order.orderId);
});

test("early renewal extends paidThrough without granting again", async () => {
  const { subi, d } = await runFirstPayment("u3");
  const before = subi._state["creditAccounts/u3"];
  const paidThroughBefore = sharedDir._state["users/u3"].subscription.subiCode.paidThroughMs;
  // Spend some credits, then renew early (still inside the paid period).
  subi._state["creditAccounts/u3"] = { ...before, monthlyRemainingCreditsMilli: 3_000_000 };
  const q2 = await billing.createQuote({ uid: "u3" }, { store: subi, directoryDb: sharedDir });
  const mock2 = mockCashfree();
  mock2.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: 589, order_currency: "INR",
    order_tags: { productType: "subi_subscription", quoteId: q2.quoteId },
  });
  const d2 = depsFor(subi, mock2);
  const o2 = await billing.createOrder({
    uid: "u3", quoteId: q2.quoteId,
    buyer: { name: "U", email: "u3@test.dev", phone: "9999999999" },
  }, d2);
  const r = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(o2.orderId))) }, d2);
  assert.equal(r.activated, true);
  assert.equal(r.cycleGranted, true); // ensure ran (idempotent path)
  const after = subi._state["creditAccounts/u3"];
  assert.equal(after.cycleId, before.cycleId, "same cycle, no new grant");
  assert.equal(after.monthlyRemainingCreditsMilli, 3_000_000, "no extra credits");
  const profile = await getUserProfile("u3");
  assert.ok(profile.subscription.paidThroughMs > paidThroughBefore, "paidThrough strictly extended");
});

test("expired renewal establishes a fresh paid period and fresh cycle", async () => {
  const { subi, d } = await runFirstPayment("u4");
  const old = subi._state["creditAccounts/u4"];
  // Expire the subscription + old cycle.
  const raw = sharedDir._state["users/u4"];
  const past = Date.now() - DAY;
  raw.subscription.subiCode.paidThroughMs = past;
  raw.subscription.subiCode.renewalDateMs = past;
  raw.subscription.subiCode.periodEndMs = past;
  raw.subscription.renewalDateMs = past;
  const q2 = await billing.createQuote({ uid: "u4" }, { store: subi, directoryDb: sharedDir });
  const mock2 = mockCashfree();
  mock2.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: 589, order_currency: "INR",
    order_tags: { productType: "subi_subscription", quoteId: q2.quoteId },
  });
  const d2 = depsFor(subi, mock2);
  const o2 = await billing.createOrder({
    uid: "u4", quoteId: q2.quoteId,
    buyer: { name: "U", email: "u4@test.dev", phone: "9999999999" },
  }, d2);
  const r = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(o2.orderId))) }, d2);
  assert.equal(r.activated, true);
  const after = subi._state["creditAccounts/u4"];
  assert.notEqual(after.cycleId, old.cycleId, "new cycle for new period");
  assert.equal(after.monthlyRemainingCreditsMilli, 4_200_000, "fresh grant, no resurrection");
});

// ---------- FX failure separation ----------

test("FX unavailable: payment active, grant retryable, no duplicates", async () => {
  const subi = fakeDb(); // no fxRates doc
  seedIndividual(sharedDir._state, "u5");
  const mock = mockCashfree();
  const d = depsFor(subi, mock);
  const q = await billing.createQuote({ uid: "u5" }, { store: subi, directoryDb: sharedDir });
  mock.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: 589, order_currency: "INR",
    order_tags: { productType: "subi_subscription", quoteId: q.quoteId },
  });
  const o = await billing.createOrder({
    uid: "u5", quoteId: q.quoteId,
    buyer: { name: "U", email: "u5@test.dev", phone: "9999999999" },
  }, d);
  const r = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(o.orderId))) }, d);
  assert.equal(r.activated, true, "genuine payment keeps subscription");
  assert.equal(r.cycleGranted, false);
  assert.equal(r.cycleError, "FX_UNAVAILABLE");
  assert.equal(subi._state[`subiBillingOrders/${o.orderId}`].status, "success");
  // Recovery after FX returns: grants once, repeat calls converge.
  seedFx(subi, 96.25);
  const g1 = await billing.ensureCurrentCreditCycleFromSubscription("u5", d);
  assert.equal(g1.alreadyGranted, false);
  assert.equal(g1.monthlyGrantCreditsMilli, 4_200_000);
  const g2 = await billing.ensureCurrentCreditCycleFromSubscription("u5", d);
  assert.equal(g2.alreadyGranted, true);
});

// ---------- Negative paths ----------

test("legacy tier user buys single-plan renewal: no tier written", async () => {
  const { subi } = await runFirstPayment("u6");
  const raw = sharedDir._state["users/u6"];
  assert.ok(!("tier" in (raw.subscription.subiCode || {})));
  assert.equal(raw.subscription.subiCode.enabled, true);
  // Legacy compat still recognizes them (no regression for old readers).
  const profile = await getUserProfile("u6");
  assert.equal(profile.subscription.subiCodeActive, true);
  void subi;
});

test("wrong product / wrong amount / failed payment: no activation", async () => {
  const subi = fakeDb();
  seedFx(subi);
  seedIndividual(sharedDir._state, "u7");
  const base = { store: subi, directoryDb: sharedDir };
  const q = await billing.createQuote({ uid: "u7" }, base);
  // Wrong product tag from Cashfree.
  const m1 = mockCashfree();
  m1.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: 589,
    order_tags: { productType: "school_plan", quoteId: q.quoteId },
  });
  const o1 = await billing.createOrder({
    uid: "u7", quoteId: q.quoteId, buyer: { name: "U", email: "u7@test.dev", phone: "1" },
  }, { ...base, cashfree: m1 });
  const r1 = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(o1.orderId))) },
    { ...base, cashfree: m1 });
  assert.equal(r1.activated || false, false);
  assert.equal(subi._state["creditAccounts/u7"], undefined);
  // Wrong amount.
  const q2 = await billing.createQuote({ uid: "u7" }, base);
  const m2 = mockCashfree();
  m2.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: 1,
    order_tags: { productType: "subi_subscription", quoteId: q2.quoteId },
  });
  const o2 = await billing.createOrder({
    uid: "u7", quoteId: q2.quoteId, buyer: { name: "U", email: "u7@test.dev", phone: "1" },
  }, { ...base, cashfree: m2 });
  const r2 = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(o2.orderId))) },
    { ...base, cashfree: m2 });
  assert.equal(r2.activated || false, false);
  assert.equal(r2.reason, "amount-or-product-mismatch");
  // Failed payment.
  const q3 = await billing.createQuote({ uid: "u7" }, base);
  const m3 = mockCashfree();
  m3.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "FAILED", order_amount: 589,
    order_tags: { productType: "subi_subscription", quoteId: q3.quoteId },
  });
  const o3 = await billing.createOrder({
    uid: "u7", quoteId: q3.quoteId, buyer: { name: "U", email: "u7@test.dev", phone: "1" },
  }, { ...base, cashfree: m3 });
  const r3 = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(o3.orderId))) },
    { ...base, cashfree: m3 });
  assert.equal(r3.activated || false, false);
  assert.equal(subi._state["creditAccounts/u7"], undefined);
  const profile = await getUserProfile("u7");
  assert.equal(profile.subscription.subiCodeActive || false, false);
});

test("bad webhook signature rejected; unknown order ignored", async () => {
  const subi = fakeDb();
  const d = depsFor(subi, { ...mockCashfree(), verifyWebhookSignature: () => false });
  await assert.rejects(
    billing.handleWebhook({ timestamp: "t", signature: "bad", rawBody: Buffer.from("{}") }, d),
    (e) => e.code === "SUBI_WEBHOOK_UNAUTHORIZED");
  const d2 = depsFor(subi);
  const r = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify({ order_id: "NOPE" })) }, d2);
  assert.equal(r.ignored, "unknown-order");
});

test("school account blocked at webhook even if order exists", async () => {
  const subi = fakeDb();
  seedFx(subi);
  sharedDir._state["users/s9"] = { uid: "s9", role: "student", accountType: "school", schoolId: "sch" };
  subi._state["subiBillingOrders/SUBI-x"] = {
    orderId: "SUBI-x", quoteId: "q", uid: "s9", product: "subi",
    productType: "subi_subscription", billingMonths: 1,
    baseAmountINR: 499, gstRate: 0.18, gstAmountINR: 90, totalAmountINR: 589,
    currency: "INR", status: "created",
  };
  const mock = mockCashfree();
  mock.fetchCashfreeOrder = async () => ({
    order_status: "PAID", order_amount: 589, order_currency: 'INR',
    order_tags: { productType: "subi_subscription", quoteId: "q" },
  });
  const r = await billing.handleWebhook(
    { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify({ order_id: "SUBI-x" })) },
    depsFor(subi, mock));
  assert.equal(r.activated || false, false);
  assert.equal(r.reason, "not-individual-account");
  assert.equal(sharedDir._state["users/s9"].subscription, undefined);
});

// ---------- HMAC + flags + codes ----------

test("real HMAC verify accepts exact signature, rejects tampering", () => {
  const secret = "whsec-test";
  const ts = "1720000000";
  const body = Buffer.from(JSON.stringify({ order_id: "SUBI-1" }));
  const crypto = require("crypto");
  const good = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(ts), body])).digest("base64");
  const deps = { webhookSecret: secret };
  assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: good, rawBody: body }, deps), true);
  assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: good, rawBody: Buffer.from("{}") }, deps), false);
  assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: "AAAA", rawBody: body }, deps), false);
  assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: "", signature: good, rawBody: body }, deps), false);
});

test("webhook HMAC key comes from CASHFREE_CLIENT_SECRET; missing secret fails closed", () => {
  const secret = "client-secret-test";
  const ts = "1720000000";
  const body = Buffer.from(JSON.stringify({ order_id: "SUBI-1" }));
  const crypto = require("crypto");
  const good = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(ts), body])).digest("base64");
  const prevClient = process.env.CASHFREE_CLIENT_SECRET;
  process.env.CASHFREE_CLIENT_SECRET = secret;
  try {
    // No DI deps: the default key must be CASHFREE_CLIENT_SECRET.
    assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: good, rawBody: body }), true);
    assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: good, rawBody: Buffer.from("{}") }), false);
    assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: "AAAA", rawBody: body }), false);
    assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: "", signature: good, rawBody: body }), false);
    // A signature made with any other key is rejected.
    const wrong = crypto.createHmac("sha256", "some-other-secret")
      .update(Buffer.concat([Buffer.from(ts), body])).digest("base64");
    assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: wrong, rawBody: body }), false);
    // Missing client secret fails closed (nothing verifies).
    delete process.env.CASHFREE_CLIENT_SECRET;
    assert.equal(cashfreeReal.verifyWebhookSignature({ timestamp: ts, signature: good, rawBody: body }), false);
  } finally {
    if (prevClient === undefined) delete process.env.CASHFREE_CLIENT_SECRET;
    else process.env.CASHFREE_CLIENT_SECRET = prevClient;
  }
});

test("new billing codes map to controlled HTTP statuses; flags stay OFF", () => {
  assert.equal(statusFor("SUBI_QUOTE_INVALID"), 400);
  assert.equal(statusFor("SUBI_QUOTE_EXPIRED"), 400);
  assert.equal(statusFor("SUBI_RETURN_ORIGIN_REJECTED"), 400);
  assert.equal(statusFor("SUBI_BILLING_UNAVAILABLE"), 503);
  assert.equal(statusFor("SUBI_WRONG_ACCOUNT_TYPE"), 403);
  assert.equal(statusFor("SUBI_UNKNOWN_USER"), 403);
  assert.equal(statusFor("SUBI_NO_PAID_PERIOD"), 503);
  assert.equal(statusFor("SUBI_WEBHOOK_UNAUTHORIZED"), 401);
  assert.equal(safeCode("SUBI_QUOTE_INVALID"), "SUBI_QUOTE_INVALID");
  assert.equal(safeCode("SUBI_RETURN_ORIGIN_REJECTED"), "SUBI_RETURN_ORIGIN_REJECTED");
  assert.deepEqual(flags.DEFAULTS.billingEnabled, false);
  assert.deepEqual(flags.DEFAULTS.enforcementEnabled, false);
  assert.deepEqual(flags.DEFAULTS.topupsEnabled, false);
  assert.deepEqual(flags.DEFAULTS.fullAgentCapabilitiesEnabled, false);
});

// ---------- Return-origin allowlist ----------

const billingOrigin = require("../src/services/subiBillingConfig");

test("return origin: canonical accepted, missing falls back", () => {
  assert.equal(
    billingOrigin.validateSubiReturnOrigin("https://stlearnsmart.in", { allowedOrigins: [] }),
    "https://stlearnsmart.in");
  assert.equal(
    billingOrigin.validateSubiReturnOrigin("https://STLEARNSMART.IN/", { allowedOrigins: [] }),
    "https://stlearnsmart.in");
  assert.equal(
    billingOrigin.validateSubiReturnOrigin(null, { allowedOrigins: [] }),
    "https://stlearnsmart.in");
  assert.equal(
    billingOrigin.validateSubiReturnOrigin("   ", { allowedOrigins: [] }),
    "https://stlearnsmart.in");
});

test("return origin: secondary accepted only when explicitly configured", () => {
  assert.equal(
    billingOrigin.validateSubiReturnOrigin("https://pay.example.com", {
      allowedOrigins: ["https://pay.example.com"],
    }),
    "https://pay.example.com");
  assert.throws(
    () => billingOrigin.validateSubiReturnOrigin("https://pay.example.com", { allowedOrigins: [] }),
    (e) => e.code === "SUBI_RETURN_ORIGIN_REJECTED");
});

test("return origin: malicious, lookalike, and wrong-scheme rejected", () => {
  for (const evil of [
    "https://evil.com",
    "https://stlearnsmart.in.evil.com",
    "https://evil.com/stlearnsmart.in",
    "https://stlearnsmart.in@evil.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://stlearnsmart.in",
    "http://stlearnsmart.in.evil.com",
    "not a url",
  ]) {
    assert.throws(
      () => billingOrigin.validateSubiReturnOrigin(evil, { allowedOrigins: [] }),
      (e) => e.code === "SUBI_RETURN_ORIGIN_REJECTED",
      evil);
  }
});

test("return origin: localhost only when explicitly configured", () => {
  assert.throws(
    () => billingOrigin.validateSubiReturnOrigin("http://localhost:3000", { allowedOrigins: [] }),
    (e) => e.code === "SUBI_RETURN_ORIGIN_REJECTED");
  assert.equal(
    billingOrigin.validateSubiReturnOrigin("http://localhost:3000", {
      allowedOrigins: ["http://localhost:3000"],
    }),
    "http://localhost:3000");
});

test("order creation rejects evil origin before Cashfree call; return URL is backend-built", async () => {
  const subi = fakeDb();
  seedIndividual(sharedDir._state, "u21");
  const base = { store: subi, directoryDb: sharedDir };
  const q = await billing.createQuote({ uid: "u21" }, base);
  let cashfreeCalled = false;
  const mock = {
    ...mockCashfree(),
    createCashfreeOrder: async () => { cashfreeCalled = true; return { payment_session_id: "s" }; },
  };
  await assert.rejects(
    billing.createOrder({
      uid: "u21", quoteId: q.quoteId,
      buyer: { name: "U", email: "u21@test.dev", phone: "1" },
      returnOrigin: "https://evil.com",
    }, { ...base, cashfree: mock }),
    (e) => e.code === "SUBI_RETURN_ORIGIN_REJECTED");
  assert.equal(cashfreeCalled, false, "no Cashfree call on rejected origin");
  // Canonical origin flows through; Cashfree receives a backend-built URL.
  let seenArgs = null;
  const mock2 = {
    ...mockCashfree(),
    createCashfreeOrder: async (args) => { seenArgs = args; return { payment_session_id: "s" }; },
  };
  const o = await billing.createOrder({
    uid: "u21", quoteId: q.quoteId,
    buyer: { name: "U", email: "u21@test.dev", phone: "1" },
    returnOrigin: "https://stlearnsmart.in",
  }, { ...base, cashfree: mock2 });
  assert.ok(seenArgs.returnUrl.startsWith("https://stlearnsmart.in/purchase?order_id="));
  assert.ok(seenArgs.returnUrl.includes(`order_id=${o.orderId}`));
  assert.ok(seenArgs.returnUrl.endsWith("&subi=1"));
});

// ---------- Crash/retry: Oct17→Nov17 paid, crash, retry ----------

test("crash between activation and order-mark: retry reuses original period", async () => {
  const subi = fakeDb();
  seedFx(subi, 96.25);
  // Existing paid period T0→T1 (conceptually Oct17→Nov17).
  const now = Date.now();
  const T0 = now - 20 * DAY;
  const T1 = now + 10 * DAY;
  sharedDir._state["users/u22"] = {
    uid: "u22", role: "student", accountType: "individual", schoolId: "",
    status: "active", email: "u22@test.dev",
    subscription: {
      status: "active",
      subiCode: {
        enabled: true, status: "active", product: "subi",
        periodStartMs: T0, periodEndMs: T1, paidThroughMs: T1, renewalDateMs: T1,
        lastPaymentOrderId: "ORDER-PREV",
      },
    },
  };
  const mock = mockCashfree();
  const d = depsFor(subi, mock);
  const q = await billing.createQuote({ uid: "u22" }, { store: subi, directoryDb: sharedDir });
  mock.fetchCashfreeOrder = async (orderId) => ({
    order_id: orderId, order_status: "PAID", order_amount: 589, order_currency: "INR",
    order_tags: { productType: "subi_subscription", quoteId: q.quoteId },
  });
  const o = await billing.createOrder({
    uid: "u22", quoteId: q.quoteId,
    buyer: { name: "U", email: "u22@test.dev", phone: "9999999999" },
  }, d);
  const body = { timestamp: "t", signature: "s", rawBody: Buffer.from(JSON.stringify(webhookBody(o.orderId))) };
  const r1 = await billing.handleWebhook(body, d);
  assert.equal(r1.activated, true);
  const E1 = r1.periodEndMs; // extended paid-through (conceptually Dec17)
  assert.ok(E1 > T1, "extension applied");
  // Simulate crash: order success never persisted.
  subi._state[`subiBillingOrders/${o.orderId}`].status = "created";
  const r2 = await billing.handleWebhook(body, d);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.periodStartMs, r1.periodStartMs, "same start, no fresh extension");
  assert.equal(r2.periodEndMs, E1, "same end, NOT another extra month");
  const rec = subi._state[`subiBillingOrders/${o.orderId}`];
  assert.equal(rec.periodEndMs, E1);
  assert.equal(rec.status, "success");
  // Subscription extended exactly once.
  const raw = sharedDir._state["users/u22"].subscription.subiCode;
  assert.equal(raw.paidThroughMs, E1);
  assert.equal(raw.lastPaymentOrderId, o.orderId);
  // Exactly one credit-cycle grant: the first webhook granted the current
  // [T0,T1] cycle; the duplicate retry must not grant again.
  const grants = Object.keys(subi._state).filter((k) => k.includes("/ledger/grant-"));
  assert.equal(grants.length, 1, "one grant total across first + retry");
});

test("owned subscription receipt preserves delivery pending and hides private fields", async () => {
  const store = fakeDb({ 'subiBillingOrders/SUBI-test': { uid: 'buyer', status: 'success', cycleGranted: false, paymentSessionId: 'private', cycleError: 'private' } });
  assert.equal(await billing.readOrder({ uid: 'other', orderId: 'SUBI-test' }, { store }), null);
  assert.equal(await billing.readOrder({ uid: 'buyer', orderId: '../bad' }, { store }), null);
  const receipt = await billing.readOrder({ uid: 'buyer', orderId: 'SUBI-test' }, { store });
  assert.equal(receipt.deliveryPending, true);
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.paymentSessionId, undefined);
  assert.equal(receipt.cycleError, undefined);
});

test('commerce availability updates preserve enforcement and reject stale saves', async () => {
  const store = fakeDb({ 'systemConfig/individualCreditFlags': { enforcementEnabled: true, fullAgentCapabilitiesEnabled: true, shadowTestUids: ['existing'], billingEnabled: false, topupsEnabled: false } });
  const updated = await flags.setCommerceAvailability({ billingEnabled: true, topupsEnabled: false, expectedFlagVersion: 1, adminUid: 'admin' }, { store });
  assert.equal(updated.commerceVersion, 2);
  assert.equal(updated.enforcementEnabled, true);
  assert.deepEqual(updated.shadowTestUids, ['existing']);
  await assert.rejects(flags.setCommerceAvailability({ billingEnabled: false, topupsEnabled: true, expectedFlagVersion: 1 }, { store }), e => e.code === 'INVALID_REQUEST');
  await assert.rejects(flags.setCommerceAvailability({ billingEnabled: 'true', topupsEnabled: false, expectedFlagVersion: 2 }, { store }), e => e.code === 'INVALID_REQUEST');
});
test('renewing paid legacy subscriptions preserves their existing paid-through horizon', async () => {
  const { activateSubiSubscription } = require('../src/services/subiSubscriptionWriter');
  const nowMs = Date.now(), paidThrough = nowMs + 90 * DAY;
  for (const [uid, subscription] of Object.entries({
    'legacy-enabled': { subiCode: { enabled: true, renewalDateMs: paidThrough } },
    'legacy-string': { subiCode: 'pro', renewalDate: new Date(paidThrough) },
  })) {
    seedIndividual(sharedDir._state, uid);
    sharedDir._state[`users/${uid}`].subscription = subscription;
    const result = await activateSubiSubscription({ uid, orderId: 'renew', billingMonths: 1, nowMs }, { directoryDb: sharedDir });
    assert.ok(result.appliedPeriod.paidThroughMs > paidThrough, uid);
    assert.equal(sharedDir._state[`users/${uid}/subiPayments/renew`].fundingStartMs, paidThrough);
  }
});
