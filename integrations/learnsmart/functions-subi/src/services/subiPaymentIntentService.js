// One durable intent per server quote, created before contacting Cashfree.
// An ambiguous timeout can retry that exact intent; it cannot mint a second
// payment order. Cashfree receives the same idempotency key on every attempt.
const crypto = require('node:crypto');

function invalid(message) { return Object.assign(new Error(message), { code: 'SUBI_QUOTE_INVALID' }); }
function checkoutOrderId(prefix, quoteId) { return `${prefix}-${crypto.createHash('sha256').update(quoteId).digest('hex').slice(0, 32)}`; }

async function createQuotedPayment({ uid, quoteId, prefix, quoteCollection, orderCollection, store, loadQuote, buildIntent, additionalQuotes, cashfree, noPaymentRequired }) {
  if (typeof quoteId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(quoteId)) throw invalid('invalid quote id');
  const orderId = checkoutOrderId(prefix, quoteId);
  const ref = store.collection(orderCollection).doc(orderId);
  const owner = (doc) => {
    if (doc.uid !== uid || doc.quoteId !== quoteId) throw invalid('payment intent owner mismatch');
    return doc;
  };
  const prior = await ref.get();
  let intent;
  if (prior.exists) intent = owner(prior.data());
  else {
    const quote = await loadQuote();
    const extras = additionalQuotes ? additionalQuotes() : [];
    const quoteRef = store.collection(quoteCollection).doc(quoteId);
    intent = await store.runTransaction(async tx => {
      const existing = await tx.get(ref);
      const snapshot = await tx.get(quoteRef);
      const extraSnapshots = [];
      for (const extra of extras) extraSnapshots.push(await tx.get(store.collection(extra.collection).doc(extra.quote.quoteId)));
      if (existing.exists) return owner(existing.data());
      const raw = snapshot.exists ? snapshot.data() : null;
      if (!raw || raw.uid !== uid || raw.status !== 'created' || raw.expiresAtMs <= Date.now()) throw invalid('quote no longer available');
      // The validator ran outside the transaction. Require the validated
      // financial fields to remain identical in this authoritative snapshot.
      for (const [key, value] of Object.entries(quote)) {
        if (key === 'quoteId') continue;
        if (key === 'configVersion' && raw[key] === undefined && value === 1) continue; // pre-version quotes
        if (JSON.stringify(raw[key] ?? null) !== JSON.stringify(value ?? null)) throw invalid('quote changed during checkout');
      }
      for (let i = 0; i < extras.length; i++) {
        const expected = extras[i].quote, actual = extraSnapshots[i].exists ? extraSnapshots[i].data() : null;
        if (!actual || actual.uid !== uid || actual.status !== 'created' || actual.expiresAtMs <= Date.now()) throw invalid('additional quote unavailable');
        for (const [key, value] of Object.entries(expected)) {
          if (key === 'quoteId' || key === 'configVersion' && actual[key] === undefined && value === 1) continue;
          if (JSON.stringify(actual[key] ?? null) !== JSON.stringify(value ?? null)) throw invalid('additional quote changed');
        }
      }
      const doc = { ...buildIntent(quote, orderId), orderId, uid, quoteId, status: 'creating', createdAtMs: Date.now(), updatedAtMs: Date.now() };
      if (noPaymentRequired?.(doc) === true) doc.status = 'success';
      if (!doc.buyer?.name?.trim() || !doc.buyer?.email?.trim() || !doc.buyer?.phone?.trim()) throw Object.assign(new Error('buyer contact required'), { code: 'INVALID_REQUEST' });
      tx.set(quoteRef, { status: 'consumed', consumedOrderId: orderId }, { merge: true });
      for (const extra of extras) tx.set(store.collection(extra.collection).doc(extra.quote.quoteId), { status: 'consumed', consumedOrderId: orderId }, { merge: true });
      tx.set(ref, doc);
      return doc;
    });
  }
  if (!intent.paymentSessionId && noPaymentRequired?.(intent) !== true) {
    const result = await cashfree.createCashfreeOrder({ orderId, quote: intent, buyer: intent.buyer, returnUrl: intent.returnUrl });
    const session = result && result.payment_session_id;
    if (typeof session !== 'string' || !session) throw Object.assign(new Error('payment session unavailable'), { code: 'SUBI_BILLING_UNAVAILABLE' });
    await store.runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const current = owner(snapshot.data() || {});
      tx.set(ref, { paymentSessionId: session, status: current.status === 'creating' ? 'created' : current.status, updatedAtMs: Date.now() }, { merge: true });
    });
    intent = { ...intent, paymentSessionId: session };
  }
  return intent;
}

module.exports = { createQuotedPayment, checkoutOrderId };
