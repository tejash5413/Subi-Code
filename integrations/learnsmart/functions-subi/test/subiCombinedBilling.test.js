const test = require('node:test');
const assert = require('node:assert/strict');
const { fundingQuery } = require('./fundingQueries');
function fakeDb(initial = {}) {
  const state = { ...initial }; let queue = Promise.resolve();
  const ref = key => ({ _key: key, collection: name => ({ ...fundingQuery(state, `${key}/${name}`), doc: id => ref(`${key}/${name}/${id}`) }), get: async () => ({ exists: key in state, data: () => state[key] }), set: async (data, options) => { state[key] = options?.merge ? { ...state[key], ...data } : data; } });
  return { _state: state, collection: name => ({ doc: id => ref(`${name}/${id}`) }), runTransaction(fn) { const run = queue.then(() => fn({ get: r => r.get(), set: (r, d, o) => r.set(d, o) })); queue = run.catch(() => {}); return run; } };
}
const directory = fakeDb();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { loaded: true, exports: { learnsmartDb: directory, subiDb: fakeDb() } };
const billing = require('../src/services/subiBillingService');
const qService = require('../src/services/subiPurchaseQuoteService');

function seed(store, uid, active = false) {
  directory._state[`users/${uid}`] = { uid, email: `${uid}@test.dev`, phone: '9999999999', displayName: 'Buyer', role: 'teacher', accountType: 'individual', status: 'active', subscription: active ? { subiCode: { enabled: true, periodStartMs: Date.now() - 1000, paidThroughMs: Date.now() + 300000 } } : {} };
  store._state['systemConfig/individualCreditFlags'] = { billingEnabled: true };
  store._state['fxRates/USD_INR'] = { rate: 96.25, pair: 'USD_INR', source: 'test', fetchedAtMs: 1, snapshotId: 'test-fx' };
  store._state['subiEducationQuotes/edq'] = { quoteId: 'edq', uid, productType: 'education_subscription', role: 'teacher', plan: 'individual-teacher', period: 'annual', billingMonths: 12, extraDays: 5, baseAmountINR: 5510, gstAmountINR: 992, totalAmountINR: 6502, currency: 'INR', status: 'created', expiresAtMs: Date.now() + 300000, createdAtMs: Date.now(), pricingSnapshotRef: 'pricing-v1', consumedOrderId: null };
}
const cfFor = store => ({ createCashfreeOrder: async () => ({ payment_session_id: 'combined-session' }), verifyWebhookSignature: () => true, extractOrderId: body => body.order_id, extractPaymentId: () => 'payment', isPaidStatus: status => status === 'PAID', fetchCashfreeOrder: async id => { const o = store._state[`subiBillingOrders/${id}`]; return { order_id: id, order_status: 'PAID', order_amount: o.totalAmountINR, order_currency: 'INR', order_tags: { productType: o.cashfreeProductType, quoteId: o.quoteId } }; } });

test('annual education plus SUBI charges one SUBI month and delivers one credit cycle', async () => {
  const store = fakeDb(); seed(store, 'combo');
  const quote = await qService.createSubiQuote({ uid: 'combo' }, { store });
  const deps = { store, directoryDb: directory, cashfree: cfFor(store) };
  const order = await billing.createCombinedOrder({ uid: 'combo', quoteId: quote.quoteId, educationQuoteId: 'edq', buyer: {} }, deps);
  assert.equal(order.amounts.totalAmountINR, 6502 + 589);
  const stored = store._state[`subiBillingOrders/${order.orderId}`];
  assert.equal(stored.billingMonths, 1);
  assert.equal(stored.education.billingMonths, 12);
  const result = await billing.handleWebhook({ timestamp: 't', signature: 's', rawBody: Buffer.from(JSON.stringify({ order_id: order.orderId })) }, deps);
  assert.equal(result.cycleGranted, true);
  assert.equal(store._state['creditAccounts/combo'].monthlyGrantCreditsMilli, 4200000);
  const receipt = await billing.readOrder({ uid: 'combo', orderId: order.orderId }, { store });
  assert.equal(receipt.deliveryPending, true); // default education delivery has not run
  assert.equal(receipt.education.plan, 'individual-teacher');
});
test('already-active subscriber buys education without a second SUBI charge or grant', async () => {
  const store = fakeDb(); seed(store, 'active-combo', true);
  const deps = { store, directoryDb: directory, cashfree: cfFor(store) };
  const order = await billing.createCombinedOrder({ uid: 'active-combo', educationQuoteId: 'edq', buyer: {} }, deps);
  assert.equal(order.amounts.totalAmountINR, 6502);
  const stored = store._state[`subiBillingOrders/${order.orderId}`];
  assert.equal(stored.subiIncludedExisting, true);
  await billing.handleWebhook({ timestamp: 't', signature: 's', rawBody: Buffer.from(JSON.stringify({ order_id: order.orderId })) }, deps);
  assert.equal(store._state['creditAccounts/active-combo'], undefined);
});
test('a server-quoted zero education total with existing SUBI creates no payment and no credit grant', async () => {
  const store = fakeDb(); seed(store, 'free-education', true);
  Object.assign(store._state['subiEducationQuotes/edq'], { baseAmountINR: 0, gstAmountINR: 0, totalAmountINR: 0 });
  let requests = 0;
  const deps = { store, directoryDb: directory, cashfree: { createCashfreeOrder: async () => { requests++; throw Error('no charge allowed'); } } };
  const order = await billing.createCombinedOrder({ uid: 'free-education', educationQuoteId: 'edq', buyer: {} }, deps);
  assert.equal(order.zeroChargeEducation, true); assert.equal(order.amounts.totalAmountINR, 0); assert.equal(requests, 0);
  assert.equal(store._state[`subiBillingOrders/${order.orderId}`].status, 'success');
  assert.equal(store._state['creditAccounts/free-education'], undefined);
  await billing.reconcileOwnedOrder({ uid: 'free-education', orderId: order.orderId }, deps);
  assert.equal(requests, 0);
});
test('combined quote ownership is enforced before contacting the provider', async () => {
  const store = fakeDb(); seed(store, 'owner'); seed(store, 'intruder');
  store._state['subiEducationQuotes/edq'].uid = 'owner';
  const q = await qService.createSubiQuote({ uid: 'intruder' }, { store });
  let called = false;
  await assert.rejects(billing.createCombinedOrder({ uid: 'intruder', quoteId: q.quoteId, educationQuoteId: 'edq' }, { store, cashfree: { createCashfreeOrder: async () => { called = true; } } }), e => e.code === 'SUBI_QUOTE_INVALID');
  assert.equal(called, false);
});
test('an enabled legacy entitlement without a paid-through date cannot skip the SUBI charge', async () => {
  const store = fakeDb(); seed(store, 'undated');
  directory._state['users/undated'].subscription = { subiCode: { enabled: true } };
  const quote = await qService.createSubiQuote({ uid: 'undated' }, { store });
  const order = await billing.createCombinedOrder({ uid: 'undated', quoteId: quote.quoteId, educationQuoteId: 'edq', buyer: {} }, { store, cashfree: cfFor(store) });
  assert.equal(order.subiIncludedExisting, false);
  assert.equal(order.amounts.totalAmountINR, 7091);
});
