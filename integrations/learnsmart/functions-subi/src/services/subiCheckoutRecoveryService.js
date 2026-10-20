const { subiDb } = require('../db');
const { checkoutOrderId } = require('./subiPaymentIntentService');
const { createQuotedPayment } = require('./subiPaymentIntentService');
const { getUserProfile } = require('./learnsmartDirectoryService');
const cashfree = require('./subiCashfreeService');
const { evaluateSubiCodeEntitlement } = require('./subiCodeEntitlementService');
const kinds = {
  subscription: { prefix: 'SUBI', quotes: 'subiBillingQuotes', orders: 'subiBillingOrders' },
  combined: { prefix: 'SUBIC', quotes: 'subiEducationQuotes', orders: 'subiBillingOrders' },
  topup: { prefix: 'SUBIT', quotes: 'subiTopupQuotes', orders: 'subiTopupOrders' },
};
const invalid = () => Object.assign(new Error('checkout reference unavailable'), { code: 'SUBI_QUOTE_INVALID' });
async function readOwnedCheckoutIntent({ uid, kind, quoteId }, { store = subiDb } = {}) {
  const cfg = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(kinds, kind) ? kinds[kind] : null;
  if (!uid || !cfg || typeof quoteId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(quoteId)) throw invalid();
  const orderId = checkoutOrderId(cfg.prefix, quoteId);
  const order = await store.collection(cfg.orders).doc(orderId).get();
  if (order.exists) {
    const data = order.data();
    if (data.uid !== uid || data.quoteId !== quoteId) throw invalid();
    const delivered = kind === 'topup' ? data.status === 'granted' : data.status === 'success'
      && (data.cycleGranted === true || data.subiIncludedExisting === true) && (!data.education || data.educationDelivered === true);
    return { kind, quoteId, orderId, status: data.status, totalAmountINR: data.totalAmountINR ?? null, currency: data.currency || null, canResumeCheckout: ['creating', 'created', 'active', 'pending'].includes(data.status), canStartAnother: delivered || ['failed', 'expired', 'cancelled', 'terminated'].includes(data.status) };
  }
  const quote = await store.collection(cfg.quotes).doc(quoteId).get();
  if (!quote.exists || quote.data().uid !== uid || !['created', 'cancelled'].includes(quote.data().status)) throw invalid();
  return { kind, quoteId, orderId: null, status: 'no_order', canStartAnother: quote.data().status === 'cancelled', canCloseUnusedQuote: quote.data().status === 'created' };
}
async function resumeOwnedCheckoutIntent({ uid, kind, quoteId }, deps = {}) {
  const store = deps.store || subiDb;
  const profile = await (deps.getProfile || getUserProfile)(uid);
  if (!profile || profile.accountType !== 'individual' || profile.active === false || ['disabled', 'inactive', 'blocked', 'suspended', 'deleted'].includes(String(profile.status || '').toLowerCase())) throw invalid();
  const recovery = await readOwnedCheckoutIntent({ uid, kind, quoteId }, { store });
  if (!recovery.orderId || !recovery.canResumeCheckout) throw invalid();
  if (kind === 'topup') {
    const entitlement = evaluateSubiCodeEntitlement({ accountType: 'individual', userSubscription: profile.subscription });
    if (!entitlement.allowed) throw Object.assign(new Error('Active SUBI coverage is required.'), { code: entitlement.code || 'SUBI_CODE_REQUIRED' });
  }
  const cfg = kinds[kind];
  const intent = await createQuotedPayment({ uid, quoteId, prefix: cfg.prefix, quoteCollection: cfg.quotes, orderCollection: cfg.orders, store, cashfree: deps.cashfree || cashfree,
    loadQuote: async () => { throw invalid(); }, buildIntent: () => { throw invalid(); } });
  // Never mint a new quote/order or reprice an existing order during recovery.
  return { orderId: intent.orderId, paymentSessionId: intent.paymentSessionId, totalAmountINR: intent.totalAmountINR, currency: intent.currency };
}
async function closeUnusedCheckoutIntent({ uid, kind, quoteId }, { store = subiDb } = {}) {
  const cfg = typeof kind === 'string' && Object.prototype.hasOwnProperty.call(kinds, kind) ? kinds[kind] : null;
  if (!uid || !cfg || typeof quoteId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(quoteId)) throw invalid();
  const orderRef = store.collection(cfg.orders).doc(checkoutOrderId(cfg.prefix, quoteId));
  const quoteRef = store.collection(cfg.quotes).doc(quoteId);
  await store.runTransaction(async tx => {
    const order = await tx.get(orderRef), quote = await tx.get(quoteRef);
    if (order.exists || !quote.exists || quote.data().uid !== uid || !['created', 'cancelled'].includes(quote.data().status)) throw invalid();
    // Prevent any delayed request holding this quote from creating an order
    // after the customer moves on. Order claiming requires status=created.
    tx.set(quoteRef, { status: 'cancelled', closedAtMs: Date.now() }, { merge: true });
  });
  return { kind, quoteId, orderId: null, status: 'no_order', canStartAnother: true };
}
module.exports = { readOwnedCheckoutIntent, closeUnusedCheckoutIntent, resumeOwnedCheckoutIntent };
