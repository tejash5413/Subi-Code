// Superadmin-only, bounded history. Never return payment sessions, contacts,
// provider payloads or mutable wallet operations.
async function listCommerceOrders({ uid, limit = 20 }, deps) {
  if (typeof uid !== 'string' || !uid.trim() || uid.length > 128 || uid.includes('/')) throw Object.assign(new Error('invalid uid'), { code: 'INVALID_REQUEST' });
  const store = deps?.store || require('../db').subiDb;
  const bounded = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  const groups = await Promise.all(['subiBillingOrders', 'subiTopupOrders'].map(async collection => {
    const snapshot = await store.collection(collection).where('uid', '==', uid).orderBy('createdAtMs', 'desc').limit(bounded).get();
    return snapshot.docs.filter(doc => doc.data().uid === uid).map(doc => {
      const o = doc.data();
      const topup = collection === 'subiTopupOrders';
      return { orderId: doc.id, kind: topup ? 'credits' : o.education ? 'education_subi' : 'subscription', status: String(o.status || '').slice(0, 32),
        createdAtMs: Number.isFinite(o.createdAtMs) ? o.createdAtMs : null,
        paidAtMs: Number.isFinite(o.paidAtMs) ? o.paidAtMs : null,
        totalAmountINR: Number.isSafeInteger(o.totalAmountINR) ? o.totalAmountINR : null, currency: o.currency === 'INR' ? 'INR' : null,
        periodStartMs: Number.isFinite(o.periodStartMs) ? o.periodStartMs : null, periodEndMs: Number.isFinite(o.periodEndMs) ? o.periodEndMs : null,
        deliveryPending: topup ? ['blocked', 'paid'].includes(o.status) : o.status === 'success' && (!(o.cycleGranted === true || o.subiIncludedExisting === true) || !!o.education && o.educationDelivered !== true),
        educationDelivered: o.education ? o.educationDelivered === true : null,
        creditsGrantedMilli: topup && Number.isSafeInteger(o.creditsGrantedMilli) ? o.creditsGrantedMilli : null };
    });
  }));
  return groups.flat().sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0) || a.orderId.localeCompare(b.orderId)).slice(0, bounded);
}
module.exports = { listCommerceOrders };
