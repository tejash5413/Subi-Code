const test = require('node:test');
const assert = require('node:assert/strict');
const { readOwnedCheckoutIntent, closeUnusedCheckoutIntent, resumeOwnedCheckoutIntent } = require('../src/services/subiCheckoutRecoveryService');
const { checkoutOrderId } = require('../src/services/subiPaymentIntentService');
function fixture(records) { const doc = key => ({ key, get: async () => ({ exists: !!records[key], data: () => records[key] }) }); return { records, store: { collection: name => ({ doc: id => doc(`${name}/${id}`) }), runTransaction: fn => fn({ get: ref => ref.get(), set: (ref, data) => { records[ref.key] = { ...records[ref.key], ...data }; } }) } }; }
test('reload finds the same owner order even after its quote expired or was removed', async () => {
  const orderId = checkoutOrderId('SUBI', 'q');
  const d = fixture({ [`subiBillingOrders/${orderId}`]: { uid: 'buyer', quoteId: 'q', status: 'creating', paymentSessionId: 'private-session', buyer: { phone: 'private-contact' } } });
  const receipt = await readOwnedCheckoutIntent({ uid: 'buyer', kind: 'subscription', quoteId: 'q' }, d);
  assert.equal(receipt.orderId, orderId); assert.equal(receipt.canStartAnother, false);
  assert.equal(receipt.paymentSessionId, undefined); assert.equal(receipt.buyer, undefined);
  await assert.rejects(readOwnedCheckoutIntent({ uid: 'other', kind: 'subscription', quoteId: 'q' }, d));
});
test('a provider timeout can resume the existing intent without its expired quote or changed price', async () => {
  const orderId = checkoutOrderId('SUBI', 'q');
  const d = fixture({ [`subiBillingOrders/${orderId}`]: { orderId, uid: 'buyer', quoteId: 'q', status: 'creating', totalAmountINR: 589, currency: 'INR', buyer: { name: 'Buyer' } } });
  let providerId;
  const resumed = await resumeOwnedCheckoutIntent({ uid: 'buyer', kind: 'subscription', quoteId: 'q' }, { ...d, getProfile: async () => ({ accountType: 'individual', active: true }), cashfree: { createCashfreeOrder: async args => { providerId = args.orderId; return { payment_session_id: 'recovered-session' }; } } });
  assert.equal(resumed.orderId, orderId); assert.equal(providerId, orderId); assert.equal(resumed.totalAmountINR, 589);
  assert.equal(d.records[`subiBillingOrders/${orderId}`].status, 'created');
});
test('resuming an unpaid topup rechecks active SUBI coverage before opening payment', async () => {
  const orderId = checkoutOrderId('SUBIT', 'q');
  const d = fixture({ [`subiTopupOrders/${orderId}`]: { orderId, uid: 'buyer', quoteId: 'q', status: 'created', totalAmountINR: 235, currency: 'INR', paymentSessionId: 'old-session' } });
  const expired = { accountType: 'individual', active: true, subscription: { subiCodeActive: true, paidThroughMs: Date.now() - 1000 } };
  await assert.rejects(resumeOwnedCheckoutIntent({ uid: 'buyer', kind: 'topup', quoteId: 'q' }, { ...d, getProfile: async () => expired }), error => error.code === 'SUBI_PLAN_EXPIRED');
  const active = { ...expired, subscription: { subiCodeActive: true, paidThroughMs: Date.now() + 86400000 } };
  const resumed = await resumeOwnedCheckoutIntent({ uid: 'buyer', kind: 'topup', quoteId: 'q' }, { ...d, getProfile: async () => active });
  assert.equal(resumed.paymentSessionId, 'old-session'); assert.equal(resumed.orderId, orderId);
});
test('only an owned unconsumed quote confirms that no payment order exists', async () => {
  const d = fixture({ 'subiTopupQuotes/q': { uid: 'buyer', status: 'created' } });
  assert.equal((await readOwnedCheckoutIntent({ uid: 'buyer', kind: 'topup', quoteId: 'q' }, d)).canStartAnother, false);
  const closed = await closeUnusedCheckoutIntent({ uid: 'buyer', kind: 'topup', quoteId: 'q' }, d);
  assert.equal(closed.canStartAnother, true);
  assert.equal(d.records['subiTopupQuotes/q'].status, 'cancelled');
  await assert.rejects(readOwnedCheckoutIntent({ uid: 'other', kind: 'topup', quoteId: 'q' }, d));
  await assert.rejects(readOwnedCheckoutIntent({ uid: 'buyer', kind: 'topup', quoteId: 'missing' }, d));
});
test('closing an unused quote cannot discard an order created concurrently', async () => {
  const orderId = checkoutOrderId('SUBI', 'q');
  const d = fixture({ 'subiBillingQuotes/q': { uid: 'buyer', status: 'consumed' }, [`subiBillingOrders/${orderId}`]: { uid: 'buyer', quoteId: 'q', status: 'creating' } });
  await assert.rejects(closeUnusedCheckoutIntent({ uid: 'buyer', kind: 'subscription', quoteId: 'q' }, d));
  assert.equal(d.records['subiBillingQuotes/q'].status, 'consumed');
});
test('paid partial delivery cannot be discarded as a failed or empty purchase', async () => {
  const id = checkoutOrderId('SUBIC', 'edq');
  const d = fixture({ [`subiBillingOrders/${id}`]: { uid: 'buyer', quoteId: 'edq', status: 'success', cycleGranted: true, education: {}, educationDelivered: false } });
  assert.equal((await readOwnedCheckoutIntent({ uid: 'buyer', kind: 'combined', quoteId: 'edq' }, d)).canStartAnother, false);
});
