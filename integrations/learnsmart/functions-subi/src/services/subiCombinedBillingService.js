// Default backend owns education quote production and education delivery.
// This orchestrator joins their immutable quote to the SUBI payment intent;
// it never writes education entitlements or duplicates credit grant math.
const { subiDb } = require('../db');
const { getUserProfile } = require('./learnsmartDirectoryService');
const { evaluateSubiCodeEntitlement } = require('./subiCodeEntitlementService');
const { getIndividualCreditFlags } = require('./individualCreditFlags');
const { requireValidQuote } = require('./subiPurchaseQuoteService');
const { createQuotedPayment } = require('./subiPaymentIntentService');
const { validateSubiReturnOrigin } = require('./subiBillingConfig');
const cashfree = require('./subiCashfreeService');
const fail = code => Object.assign(new Error(code), { code });
const COLLECTION = 'subiEducationQuotes';
async function createCombinedOrder({ uid, quoteId, educationQuoteId, buyer, returnOrigin }, deps) {
  const d = { store: subiDb, ...(deps || {}) };
  const profile = await getUserProfile(uid);
  if (!profile || profile.accountType !== 'individual') throw fail('SUBI_WRONG_ACCOUNT_TYPE');
  if (profile.active === false || ['disabled', 'inactive', 'blocked', 'suspended', 'deleted'].includes(String(profile.status || '').toLowerCase())) throw fail('FORBIDDEN');
  const existing = evaluateSubiCodeEntitlement({ accountType: 'individual', userSubscription: profile.subscription });
  const alreadyPaid = existing.allowed && Number.isFinite(existing.renewalDateMs) && existing.renewalDateMs > Date.now();
  const origin = validateSubiReturnOrigin(returnOrigin);
  let subiQuote;
  const intent = await createQuotedPayment({ uid, quoteId: educationQuoteId, prefix: 'SUBIC', quoteCollection: COLLECTION, orderCollection: 'subiBillingOrders', store: d.store, cashfree: d.cashfree || cashfree,
    loadQuote: async () => {
      const snapshot = await d.store.collection(COLLECTION).doc(educationQuoteId).get();
      const education = snapshot.exists ? snapshot.data() : null;
      const months = { monthly: 1, semiannual: 6, annual: 12 };
      if (!education || education.uid !== uid || education.productType !== 'education_subscription' || education.role !== profile.role || !['student', 'teacher'].includes(education.role) || education.currency !== 'INR' || !Number.isSafeInteger(education.baseAmountINR) || education.baseAmountINR < 0 || education.baseAmountINR > 1200000 || education.gstAmountINR !== Math.round(education.baseAmountINR * .18) || education.totalAmountINR !== education.baseAmountINR + education.gstAmountINR || education.billingMonths !== months[education.period] || !Number.isSafeInteger(education.extraDays) || education.extraDays < 0 || education.extraDays > 366 || education.status !== 'created' || education.expiresAtMs <= Date.now()) throw fail('SUBI_QUOTE_INVALID');
      if (!alreadyPaid) {
        const flags = await getIndividualCreditFlags({ store: d.store });
        if (!flags.billingEnabled) throw fail('SUBI_BILLING_UNAVAILABLE');
        subiQuote = await requireValidQuote({ uid, quoteId }, { store: d.store });
      }
      if (education.totalAmountINR + (subiQuote?.totalAmountINR || 0) < 0) throw fail('INVALID_REQUEST');
      return education;
    },
    additionalQuotes: () => subiQuote ? [{ collection: 'subiBillingQuotes', quote: subiQuote }] : [],
    noPaymentRequired: order => order.zeroChargeEducation === true && order.totalAmountINR === 0 && order.subiIncludedExisting === true && order.productType === 'education_subscription',
    buildIntent: (education, orderId) => ({
      product: subiQuote ? 'subi' : 'education', productType: subiQuote ? 'subi_subscription' : 'education_subscription',
      cashfreeProductType: subiQuote ? 'education_subi' : 'education_subscription',
      zeroChargeEducation: !subiQuote && education.totalAmountINR === 0,
      billingMonths: subiQuote ? 1 : 0, subiQuoteId: subiQuote?.quoteId || null, subiIncludedExisting: !subiQuote,
      configVersion: subiQuote?.configVersion || null, economicsSnapshot: subiQuote?.economicsSnapshot || null,
      baseAmountINR: education.baseAmountINR + (subiQuote?.baseAmountINR || 0), gstRate: .18,
      gstAmountINR: education.gstAmountINR + (subiQuote?.gstAmountINR || 0), totalAmountINR: education.totalAmountINR + (subiQuote?.totalAmountINR || 0), currency: 'INR',
      lineItems: [{ productType: education.productType, baseAmountINR: education.baseAmountINR, gstAmountINR: education.gstAmountINR, totalAmountINR: education.totalAmountINR, billingMonths: education.billingMonths }, ...(subiQuote ? [{ productType: 'subi_subscription', baseAmountINR: subiQuote.baseAmountINR, gstAmountINR: subiQuote.gstAmountINR, totalAmountINR: subiQuote.totalAmountINR, billingMonths: 1 }] : [])],
      education: { quoteId: education.quoteId, role: education.role, plan: education.plan, period: education.period, billingMonths: education.billingMonths, extraDays: education.extraDays, pricingSnapshotRef: education.pricingSnapshotRef },
      educationDelivered: false, cycleGranted: false, paymentSessionId: null, paidAtMs: null,
      buyer: { name: String(buyer?.name || profile.displayName || profile.email.split('@')[0]).slice(0, 120), email: profile.email.toLowerCase().slice(0, 120), phone: String(buyer?.phone || profile.phone).slice(0, 20) },
      returnUrl: `${origin}/purchase?subi=1&order_id=${orderId}`,
    }),
  });
  return { orderId: intent.orderId, paymentSessionId: intent.paymentSessionId, zeroChargeEducation: intent.zeroChargeEducation === true, amounts: { baseAmountINR: intent.baseAmountINR, gstAmountINR: intent.gstAmountINR, totalAmountINR: intent.totalAmountINR, currency: 'INR', lineItems: intent.lineItems }, subiIncludedExisting: intent.subiIncludedExisting };
}
module.exports = { createCombinedOrder, COLLECTION };
