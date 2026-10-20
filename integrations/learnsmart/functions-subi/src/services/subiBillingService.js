// functions-subi/src/services/subiBillingService.js
// INDIVIDUAL SUBI billing orchestrator (₹499/mo + GST, single plan).
// Owns: server quotes (via subiPurchaseQuoteService), Cashfree order intent,
// webhook verification + idempotent activation, subscription writes (via
// subiSubscriptionWriter), and delegation to the tested credit-cycle engine.
// The webhook NEVER duplicates grant math — it calls ensureCurrentCreditCycle.
//
// Separation that survives partial failure (§23):
//   payment success -> subscription becomes active FIRST (durable).
//   cycle grant attempted second; FX failure leaves subscription active with
//   cycleGranted:false so ensureCurrentCreditCycleFromSubscription can retry.
// A genuine payment is never rolled back because FX is unavailable.
//
// BOUNDARY: subiDb for orders/quotes (via injected store); learnsmartDb ONLY
// through subiSubscriptionWriter + learnsmartDirectoryService reads. Cashfree
// ONLY through subiCashfreeService (DI). Never secrets in logs.

const { subiDb } = require("../db");
const { createQuotedPayment } = require('./subiPaymentIntentService');
const { PRODUCT_TYPE, buildSubiQuoteAmounts, validateSubiReturnOrigin } = require("./subiBillingConfig");
const {
  createSubiQuote,
  requireValidQuote,
} = require("./subiPurchaseQuoteService");
const { resolvePaidCreditCycle } = require('./subiPaidCreditPeriodService');
const cashfree = require("./subiCashfreeService");
const {
  readSubiPeriod,
  activateSubiSubscription,
} = require("./subiSubscriptionWriter");
const {
  TOPUP_PRODUCT_TYPE,
  TOPUP_ORDER_COLLECTION,
  handleTopupWebhook,
} = require("./subiTopupService");
const { getUserProfile } = require("./learnsmartDirectoryService");
const { getCreditAccount } = require("./individualCreditAccountService");
const { ensureCurrentCreditCycle } = require("./individualCreditCycleService");

const ORDER_COLLECTION = "subiBillingOrders";

function defaultDeps() {
  return { store: subiDb, directoryDb: null, cashfree: null };
}
function cleanId(v, max = 128) { return String(v || "").trim().slice(0, max); }
function invalidRequest(m) { const e = new Error(m || "invalid billing payload"); e.code = "INVALID_REQUEST"; return e; }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

// Directory individual check shared by quote/order paths (school can never
// buy the ₹499 product; missing users fail closed).
async function requireIndividualUid(uid, deps) {
  const profile = await getUserProfile(uid);
  if (!profile) throw coded("unknown user", "SUBI_UNKNOWN_USER");
  if (profile.accountType !== "individual") throw coded("school accounts cannot buy individual subi", "SUBI_WRONG_ACCOUNT_TYPE");
  if (profile.active === false || ['disabled', 'inactive', 'blocked', 'suspended', 'deleted'].includes(String(profile.status || '').toLowerCase())) throw coded('disabled account', 'FORBIDDEN');
  return profile;
}

// POST /subi/billing/quote — authenticated individual only.
async function createQuote({ uid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  await requireIndividualUid(uid, d);
  return createSubiQuote({ uid }, { store: d.store });
}

// POST /subi/billing/order — { quoteId, buyer{name,email,phone}, returnOrigin? }.
// The return URL is built server-side (existing convention): only an https
// origin is accepted from the client, never a full URL.
async function createOrder({ uid, quoteId, buyer, returnOrigin }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const profile = await requireIndividualUid(id, d);
  const cf = d.cashfree || cashfree;
  // Strict allowlist: arbitrary client origins are rejected, never trusted.
  const returnBase = validateSubiReturnOrigin(returnOrigin);
  const nowMs = Date.now();
  const intent = await createQuotedPayment({ uid: id, quoteId, prefix: 'SUBI', quoteCollection: 'subiBillingQuotes', orderCollection: ORDER_COLLECTION,
    store: d.store, cashfree: cf,
    loadQuote: () => requireValidQuote({ uid: id, quoteId }, { store: d.store }),
    buildIntent: (q, orderId) => ({
    returnUrl: `${returnBase}/purchase?order_id=${orderId}&subi=1`,
    quoteId: q.quoteId,
    uid: id,
    product: q.product,
    productType: q.productType,
    billingMonths: q.billingMonths,
    baseAmountINR: q.baseAmountINR,
    gstRate: q.gstRate,
    gstAmountINR: q.gstAmountINR,
    totalAmountINR: q.totalAmountINR,
    currency: q.currency,
    configVersion: q.configVersion,
    economicsSnapshot: q.economicsSnapshot,
    buyer: {
      name: String(buyer?.name || profile.displayName || profile.email.split('@')[0]).slice(0, 120),
      email: profile.email.toLowerCase().slice(0, 120),
      phone: String(buyer?.phone || profile.phone).slice(0, 20),
    },
    paymentSessionId: null,
    status: "created",
    paymentId: null,
    paidAtMs: null,
    periodStartMs: null,
    periodEndMs: null,
    cycleId: null,
    cycleGranted: false,
    cycleError: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  }) });
  return {
    orderId: intent.orderId,
    paymentSessionId: intent.paymentSessionId,
    amounts: buildSubiQuoteAmounts({ baseAmountINR: intent.baseAmountINR }),
  };
}

// POST /subi/billing/webhook — signature-verified, idempotent activation.
async function handleWebhook({ timestamp, signature, rawBody }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cf = d.cashfree || cashfree;
  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  if (!cf.verifyWebhookSignature({ timestamp, signature, rawBody: bodyBuf })) {
    throw coded("bad webhook signature", "SUBI_WEBHOOK_UNAUTHORIZED");
  }
  let payload = {};
  try {
    payload = bodyBuf.length ? JSON.parse(bodyBuf.toString("utf8")) : {};
  } catch (_) {
    throw invalidRequest("webhook body must be JSON");
  }
  const orderId = cleanId(cf.extractOrderId(payload));
  if (!orderId) throw invalidRequest("webhook missing orderId");
  // Top-up orders live in their own collection: dispatch by server-owned doc.
  // (Product tags alone are never trusted for routing.)
  const topupRef = d.store.collection(TOPUP_ORDER_COLLECTION).doc(orderId);
  const topupSnap = await topupRef.get();
  if (topupSnap.exists) {
    const topupOrder = topupSnap.data() || {};
    if (topupOrder.productType === TOPUP_PRODUCT_TYPE) {
      return handleTopupWebhook({ orderId, payload }, d);
    }
    return { received: true, ignored: "wrong-product", orderId };
  }
  return settleSubscriptionPayment({ orderId, payload }, d);
}

async function settleSubscriptionPayment({ orderId, payload = {} }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cf = d.cashfree || cashfree;
  const orderRef = d.store.collection(ORDER_COLLECTION).doc(orderId);
  const orderSnap = await orderRef.get();
  // Unknown order: not ours (other products share the gateway URL space).
  // Record nothing, activate nothing.
  if (!orderSnap.exists) return { received: true, ignored: "unknown-order", orderId };
  const order = orderSnap.data() || {};
  if (order.productType !== PRODUCT_TYPE && !(order.productType === 'education_subscription' && order.subiIncludedExisting === true && order.education)) {
    return { received: true, ignored: "wrong-product", orderId };
  }
  if (order.status === "success" && (order.cycleGranted === true || order.subiIncludedExisting === true)) {
    return { received: true, duplicate: true, orderId };
  }
  // Server truth (never the webhook body).
  const cfOrder = await cf.fetchCashfreeOrder(orderId);
  const paid = cf.isPaidStatus(cfOrder && cfOrder.order_status);
  const nowMs = Date.now();
  if (!paid) {
    // Failed/pending/cancelled: record, never activate. Never overwrite success.
    await d.store.runTransaction(async (tx) => {
      const cur = await tx.get(orderRef);
      const curData = cur.exists ? cur.data() || {} : {};
      if (curData.status === "success") return;
      tx.set(orderRef, {
        status: String((cfOrder && cfOrder.order_status) || "failed").toLowerCase(),
        failureReason: "cashfree-not-paid",
        updatedAtMs: nowMs,
      }, { merge: true });
    });
    return { received: true, activated: false, orderId, reason: "not-paid" };
  }
  // Amount + product verification against the server-created order.
  const cfAmount = Number(cfOrder && (cfOrder.order_amount ?? cfOrder.orderAmount));
  const cfTags = (cfOrder && cfOrder.order_tags) || {};
  if (cfAmount !== Number(order.totalAmountINR)
    || String(cfTags.productType || "") !== (order.cashfreeProductType || PRODUCT_TYPE)
    || String(cfOrder.order_currency || '') !== 'INR'
    || String(cfTags.quoteId || "") !== String(order.quoteId || "")) {
    await orderRef.set({
      status: "blocked", failureReason: "amount-or-product-mismatch", updatedAtMs: nowMs,
    }, { merge: true });
    return { received: true, activated: false, orderId, reason: "amount-or-product-mismatch" };
  }
  // Buyer must be an explicit individual (school can never take this product).
  const dirDbOpts = d.directoryDb ? { directoryDb: d.directoryDb } : undefined;
  const profile = await getUserProfile(order.uid).catch(() => null);
  const dirType = profile ? profile.accountType : null;
  if (!profile || dirType !== "individual") {
    await orderRef.set({
      status: "blocked", failureReason: "not-individual-account", updatedAtMs: nowMs,
    }, { merge: true });
    return { received: true, activated: false, orderId, reason: "not-individual-account" };
  }
  if (order.subiIncludedExisting === true) {
    await orderRef.set({ status: 'success', paidAtMs: order.paidAtMs || nowMs, paymentId: cf.extractPaymentId(payload, cfOrder) || null, updatedAtMs: nowMs }, { merge: true });
    return { received: true, activated: false, orderId, subiIncludedExisting: true };
  }
  // Durable activation FIRST (guarded by orderId: replays never re-extend).
  const activation = await activateSubiSubscription({
    uid: order.uid,
    billingMonths: Number(order.billingMonths) || 1,
    economicsSnapshot: order.economicsSnapshot || null,
    configVersion: order.configVersion,
    existingCycle: await getCreditAccount(order.uid, { store: d.store }),
    nowMs,
    orderId,
  }, dirDbOpts);
  // Duplicate retry (e.g. crash between activation and order-marking): reuse
  // the ALREADY-APPLIED period for this orderId. Never derive a fresh
  // extension from the extended subscription (that would overstate the order
  // metadata by another month). Same orderId → same period, deterministically.
  const effectiveCoverage = activation.appliedPeriod;
  // Cycle for the period containing now (early renewal → current cycle stays;
  // ensure returns alreadyGranted, no double grant).
  const livePeriod = await readSubiPeriod(order.uid, dirDbOpts);
  let cycleId = null;
  let cycleGranted = false;
  let cycleError = null;
  try {
    const bounds = await resolvePaidCreditCycle({ uid: order.uid, periodStartMs: livePeriod.period.periodStartMs, paidThroughMs: livePeriod.period.paidThroughMs, nowMs }, d);
    const granted = await ensureCurrentCreditCycle({
      uid: order.uid,
      accountType: "individual",
      userSubscription: { subiCodeActive: true, renewalDateMs: livePeriod.period.paidThroughMs },
      paidPeriodStartMs: bounds.paidPeriodStartMs,
      paidPeriodEndMs: bounds.paidPeriodEndMs,
      economics: bounds.economics,
      nowMs,
    }, { store: d.store });
    cycleId = granted.cycleId || null;
    cycleGranted = true;
  } catch (err) {
    // FX (or any grant-side) failure must NOT roll back a genuine payment:
    // subscription stays active; recovery retries the grant later.
    cycleError = (err && err.code) || "INTERNAL";
  }
  const paymentId = cf.extractPaymentId(payload, cfOrder);
  await d.store.runTransaction(async (tx) => {
    const cur = await tx.get(orderRef);
    const curData = cur.exists ? cur.data() || {} : {};
    if (curData.status === "success" && curData.cycleGranted === true) return;
    tx.set(orderRef, {
      status: "success",
      paymentId: paymentId || null,
      paidAtMs: curData.paidAtMs || nowMs,
      periodStartMs: effectiveCoverage.periodStartMs,
      periodEndMs: effectiveCoverage.periodEndMs,
      cycleId,
      cycleGranted,
      cycleError,
      updatedAtMs: nowMs,
    }, { merge: true });
  });
  return {
    received: true,
    activated: true,
    duplicate: activation.duplicate === true,
    orderId,
    uid: order.uid,
    periodStartMs: effectiveCoverage.periodStartMs,
    periodEndMs: effectiveCoverage.periodEndMs,
    cycleId,
    cycleGranted,
    cycleError,
  };
}

// Idempotent recovery (§24): re-read the authoritative subscription period
// and (re)run the cycle engine for the CURRENT monthly sub-period only.
// Never grants the whole extended span (17 Oct -> 17 Dec stays two monthly
// cycles); never stacks historical months; safe to call repeatedly.
async function ensureCurrentCreditCycleFromSubscription(uid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const profile = await getUserProfile(id);
  if (!profile) throw coded("unknown user", "SUBI_UNKNOWN_USER");
  if (profile.accountType !== "individual") throw coded("credit cycles are individual-only", "INVALID_REQUEST");
  const sub = profile.subscription || {};
  const start = num(sub.periodStartMs);
  const end = num(require('./subiCodeEntitlementService').resolvePaidThroughMs(sub));
  if (start === null || end === null || start <= 0 || end <= start) {
    throw coded("no usable subi paid period", "SUBI_NO_PAID_PERIOD");
  }
  const nowMs = Number.isSafeInteger(d.nowMs) ? d.nowMs : Date.now();
  if (nowMs >= end) throw coded("subscription period ended", "SUBI_PLAN_EXPIRED");
  const bounds = await resolvePaidCreditCycle({ uid: id, periodStartMs: start, paidThroughMs: end, nowMs }, d);
  return ensureCurrentCreditCycle({
    uid: id,
    accountType: "individual",
    userSubscription: { subiCodeActive: true, renewalDateMs: end },
    paidPeriodStartMs: bounds.paidPeriodStartMs,
    paidPeriodEndMs: bounds.paidPeriodEndMs,
    economics: bounds.economics,
    nowMs,
  }, { store: d.store });
}

// Owner-only safe receipt projection. Reading never activates or charges.
async function readOrder({ uid, orderId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof uid !== "string" || !uid || typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(orderId)) return null;
  const snap = await d.store.collection(ORDER_COLLECTION).doc(orderId).get();
  if (!snap.exists) return null;
  const order = snap.data() || {};
  if (order.uid !== uid) return null;
  const status = ["creating", "created", "active", "pending", "success", "blocked", "failed", "expired", "cancelled", "terminated"].includes(order.status) ? order.status : "pending";
  return {
    orderId, status, cycleGranted: order.cycleGranted === true,
    deliveryPending: status === "success" && (!(order.cycleGranted === true || order.subiIncludedExisting === true) || !!order.education && order.educationDelivered !== true),
    subiIncludedExisting: order.subiIncludedExisting === true,
    zeroChargeEducation: order.zeroChargeEducation === true,
    education: order.education ? { plan: order.education.plan, period: order.education.period, billingMonths: order.education.billingMonths, delivered: order.educationDelivered === true } : null,
    lineItems: Array.isArray(order.lineItems) ? order.lineItems.map(line => ({ productType: line.productType, baseAmountINR: line.baseAmountINR, gstAmountINR: line.gstAmountINR, totalAmountINR: line.totalAmountINR, billingMonths: line.billingMonths })) : null,
    baseAmountINR: num(order.baseAmountINR), gstAmountINR: num(order.gstAmountINR),
    totalAmountINR: num(order.totalAmountINR), currency: "INR",
    paidAtMs: num(order.paidAtMs), periodStartMs: num(order.periodStartMs), periodEndMs: num(order.periodEndMs),
  };
}

async function reconcileOwnedOrder({ uid, orderId }, deps) {
  const order = await readOrder({ uid, orderId }, deps);
  if (!order) throw coded('unknown owned order', 'SUBI_QUOTE_INVALID');
  if (order.zeroChargeEducation === true && order.totalAmountINR === 0 && order.status === 'success') return { received: true, orderId };
  return settleSubscriptionPayment({ orderId }, deps);
}

module.exports = {
  readOrder,
  ORDER_COLLECTION,
  createQuote,
  createOrder,
  createCombinedOrder: require('./subiCombinedBillingService').createCombinedOrder,
  reconcileOwnedOrder,
  settleSubscriptionPayment,
  handleWebhook,
  ensureCurrentCreditCycleFromSubscription,
};
