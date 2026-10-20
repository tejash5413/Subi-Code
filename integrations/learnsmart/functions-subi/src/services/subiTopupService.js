// functions-subi/src/services/subiTopupService.js
// INDIVIDUAL SUBI top-up packs (purchased credits). Single-purpose module:
// server quotes with FROZEN credits, Cashfree order intent, idempotent grant
// to the existing wallet's topup bucket, and safe refund groundwork.
//
// Product: pack base prices (INR) [199, 499, 999, 1999] + 18% GST via the
// project integer-rupee convention (Math.round, no paise). Credit quantity is
// dynamic per quote (FX + economics at quote time) and FROZEN: the webhook
// grants exactly the frozen amount, never recalculating.
//
// Boundaries mirror subiBillingService: subiDb via injected store;
// learnsmartDb ONLY through directory reads (getUserProfile) — this module
// never writes the directory. Cashfree ONLY through subiCashfreeService (DI).
// Never secrets in logs. Top-ups require an ACTIVE individual SUBI
// subscription (they supplement it; they never substitute for it).

const crypto = require("crypto");
const { subiDb } = require("../db");
const { GST_RATE, CURRENCY, QUOTE_TTL_MS, validateSubiReturnOrigin } = require("./subiBillingConfig");
const cashfree = require("./subiCashfreeService");
const { getFxRate } = require("./fxRateService");
const { getEconomicsConfig } = require("./individualCreditEconomicsConfig");
const { topupQuoteCredits } = require("./individualCreditEconomics");
const { getUserProfile } = require("./learnsmartDirectoryService");
const { evaluateSubiCodeEntitlement } = require("./subiCodeEntitlementService");
const { toSafeAccount } = require("./individualCreditAccountService");
const { getIndividualCreditFlags } = require("./individualCreditFlags");
const { createQuotedPayment } = require('./subiPaymentIntentService');

const TOPUP_PRODUCT_TYPE = "subi_topup";
const TOPUP_PACKS_INR = Object.freeze([199, 499, 999, 1999]);
const TOPUP_QUOTE_COLLECTION = "subiTopupQuotes";
const TOPUP_ORDER_COLLECTION = "subiTopupOrders";
// Grant rounding mirrors the subscription economics (floor to 50-credit step).
const TOPUP_GRANT_ROUND_STEP = 50;

function defaultDeps() {
  return { store: subiDb, cashfree: null };
}
function cleanId(v, max = 128) { return String(v || "").trim().slice(0, max); }
function invalidRequest(m) { const e = new Error(m || "invalid topup payload"); e.code = "INVALID_REQUEST"; return e; }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }
function num(v) { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0; }

function newTopupQuoteId(uid) {
  return `SUBITQ-${Date.now()}-${cleanId(uid, 16)}-${crypto.randomBytes(4).toString("hex")}`;
}
function cleanPack(packPriceINR, packs) {
  const n = Number(packPriceINR);
  if (!Number.isSafeInteger(n) || !(packs || []).some(p => p.enabled && p.packPriceINR === n)) throw coded('unsupported topup pack', "SUBI_TOPUP_PACK_INVALID");
  return n;
}

// Active individual SUBI required (tierless single-plan contract). Expired /
// missing → controlled entitlement codes (never a grant).
async function requireActiveIndividualSubi(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) throw coded("unknown user", "SUBI_UNKNOWN_USER");
  if (profile.accountType !== "individual") {
    throw coded("school accounts cannot buy individual topups", "SUBI_WRONG_ACCOUNT_TYPE");
  }
  if (profile.active === false || ['disabled', 'inactive', 'blocked', 'suspended', 'deleted'].includes(String(profile.status || '').toLowerCase())) throw coded('disabled account', 'FORBIDDEN');
  const decision = evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: profile.subscription || null,
    schoolSubscription: null,
  });
  if (!decision.allowed) {
    throw coded(
      decision.code === "SUBI_PLAN_EXPIRED" ? "subi subscription expired" : "subi subscription required",
      decision.code || "SUBI_CODE_REQUIRED"
    );
  }
  return profile;
}

async function topupsEnabled(deps) {
  try {
    const f = await getIndividualCreditFlags(deps && deps.store ? { store: deps.store } : undefined);
    return f && f.topupsEnabled === true;
  } catch (_) {
    return false;
  }
}

function toSafeTopupQuote(id, data) {
  const d = (data && typeof data === "object") ? data : {};
  return {
    quoteId: id,
    uid: typeof d.uid === "string" ? d.uid : null,
    configVersion: Number.isSafeInteger(d.configVersion) ? d.configVersion : 1,
    product: d.product || null,
    productType: d.productType || null,
    packPriceINR: typeof d.packPriceINR === "number" ? d.packPriceINR : null,
    gstRate: typeof d.gstRate === "number" ? d.gstRate : null,
    gstAmountINR: typeof d.gstAmountINR === "number" ? d.gstAmountINR : null,
    totalAmountINR: typeof d.totalAmountINR === "number" ? d.totalAmountINR : null,
    currency: d.currency || null,
    creditsGranted: typeof d.creditsGranted === "number" ? d.creditsGranted : null,
    creditsGrantedMilli: typeof d.creditsGrantedMilli === "number" ? d.creditsGrantedMilli : null,
    fxSnapshot: d.fxSnapshot && typeof d.fxSnapshot === "object" ? d.fxSnapshot : null,
    economicsSnapshot: d.economicsSnapshot && typeof d.economicsSnapshot === "object" ? d.economicsSnapshot : null,
    status: d.status || null,
    createdAtMs: typeof d.createdAtMs === "number" ? d.createdAtMs : null,
    expiresAtMs: typeof d.expiresAtMs === "number" ? d.expiresAtMs : null,
    consumedOrderId: typeof d.consumedOrderId === "string" ? d.consumedOrderId : null,
  };
}

// POST /subi/topups/quote — { packPriceINR }. Amounts + credits server-side.
async function createTopupQuote({ uid, packPriceINR }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  await requireActiveIndividualSubi(id);
  const cfg = await getEconomicsConfig({ store: d.store });
  const pack = cleanPack(packPriceINR, cfg.topupPacks);
  const fx = await getFxRate({ store: d.store }).catch(() => null);
  if (!fx || !Number.isFinite(Number(fx.rate))) throw coded("fx rate unavailable", "FX_UNAVAILABLE");
  const quoted = topupQuoteCredits({
    packINR: pack,
    fxRate: Number(fx.rate),
    providerFundingMultiplier: cfg ? cfg.providerFundingMultiplier : undefined,
    marginPct: cfg ? cfg.topupMarginPct : undefined,
  });
  const creditsGranted = Math.floor(quoted.credits / TOPUP_GRANT_ROUND_STEP) * TOPUP_GRANT_ROUND_STEP;
  if (!Number.isSafeInteger(creditsGranted) || creditsGranted <= 0) {
    throw coded("topup credits out of range", "SUBI_TOPUP_QUOTE_FAILED");
  }
  const gstAmountINR = Math.round(pack * GST_RATE);
  const nowMs = Date.now();
  const quoteId = newTopupQuoteId(id);
  const doc = {
    quoteId,
    uid: id,
    configVersion: cfg.configVersion,
    product: "subi_topup",
    productType: TOPUP_PRODUCT_TYPE,
    packPriceINR: pack,
    gstRate: GST_RATE,
    gstAmountINR,
    totalAmountINR: pack + gstAmountINR,
    currency: CURRENCY,
    creditsGranted,
    creditsGrantedMilli: creditsGranted * 1000,
    fxSnapshot: { pair: "USD_INR", rate: Number(fx.rate), source: fx.source || null, fetchedAtMs: fx.fetchedAtMs || null, snapshotId: fx.snapshotId || null },
    economicsSnapshot: {
      providerFundingMultiplier: cfg ? cfg.providerFundingMultiplier : null,
      topupMarginPct: cfg ? cfg.topupMarginPct : null,
      quotedAtMs: nowMs,
    },
    status: "created",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + QUOTE_TTL_MS,
    consumedOrderId: null,
  };
  await d.store.collection(TOPUP_QUOTE_COLLECTION).doc(quoteId).set(doc);
  return toSafeTopupQuote(quoteId, doc);
}

async function requireValidTopupQuote({ uid, quoteId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const qid = cleanId(quoteId, 160);
  if (!id || !qid) throw invalidRequest("missing uid/quoteId");
  const snap = await d.store.collection(TOPUP_QUOTE_COLLECTION).doc(qid).get();
  if (!snap.exists) throw coded("unknown topup quote", "SUBI_QUOTE_INVALID");
  const q = toSafeTopupQuote(qid, snap.data() || {});
  if (q.uid !== id) throw coded("quote owner mismatch", "SUBI_QUOTE_INVALID");
  if (q.productType !== TOPUP_PRODUCT_TYPE) throw coded("quote product mismatch", "SUBI_QUOTE_INVALID");
  if (q.status !== "created") throw coded("quote already used", "SUBI_QUOTE_INVALID");
  if (!(q.expiresAtMs > Date.now())) throw coded("quote expired", "SUBI_QUOTE_EXPIRED");
  if (!Number.isSafeInteger(q.packPriceINR) || q.packPriceINR < 1 || q.packPriceINR > 100000) throw coded("quote pack mismatch", "SUBI_QUOTE_INVALID");
  let expectedCredits;
  try {
    const frozen = topupQuoteCredits({ packINR: q.packPriceINR, fxRate: q.fxSnapshot?.rate,
      providerFundingMultiplier: q.economicsSnapshot?.providerFundingMultiplier, marginPct: q.economicsSnapshot?.topupMarginPct });
    expectedCredits = Math.floor(frozen.credits / TOPUP_GRANT_ROUND_STEP) * TOPUP_GRANT_ROUND_STEP;
  } catch (_) { throw coded('quote funding mismatch', 'SUBI_QUOTE_INVALID'); }
  // Recompute the GST shell (integer-rupee convention) — stored tampering fails.
  if (q.currency !== CURRENCY || q.gstRate !== GST_RATE || q.creditsGranted !== expectedCredits
    || q.gstAmountINR !== Math.round(q.packPriceINR * GST_RATE)
    || q.totalAmountINR !== q.packPriceINR + q.gstAmountINR
    || !(q.creditsGrantedMilli > 0) || q.creditsGrantedMilli !== q.creditsGranted * 1000) {
    throw coded("quote amount mismatch", "SUBI_QUOTE_INVALID");
  }
  return q;
}

async function consumeTopupQuote({ uid, quoteId, orderId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const ref = d.store.collection(TOPUP_QUOTE_COLLECTION).doc(cleanId(quoteId, 160));
  return d.store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw coded("unknown topup quote", "SUBI_QUOTE_INVALID");
    const q = toSafeTopupQuote(quoteId, snap.data() || {});
    if (q.uid !== cleanId(uid) || q.status !== "created") {
      throw coded("quote already used", "SUBI_QUOTE_INVALID");
    }
    if (!(q.expiresAtMs > Date.now())) throw coded("quote expired", "SUBI_QUOTE_EXPIRED");
    tx.set(ref, { status: "consumed", consumedOrderId: cleanId(orderId, 160) }, { merge: true });
    return q;
  });
}

// POST /subi/topups/order — { quoteId, buyer, returnOrigin? }.
async function createTopupOrder({ uid, quoteId, buyer, returnOrigin }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const profile = await requireActiveIndividualSubi(id);
  const cf = d.cashfree || cashfree;
  const returnBase = validateSubiReturnOrigin(returnOrigin);
  const nowMs = Date.now();
  const intent = await createQuotedPayment({ uid: id, quoteId, prefix: 'SUBIT', quoteCollection: TOPUP_QUOTE_COLLECTION, orderCollection: TOPUP_ORDER_COLLECTION,
    store: d.store, cashfree: cf,
    loadQuote: () => requireValidTopupQuote({ uid: id, quoteId }, { store: d.store }),
    buildIntent: (q, orderId) => ({
    returnUrl: `${returnBase}/purchase?order_id=${orderId}&subi=topup`,
    billingMonths: 0,
    baseAmountINR: q.packPriceINR,
    configVersion: q.configVersion,
    quoteId: q.quoteId,
    uid: id,
    product: q.product,
    productType: q.productType,
    packPriceINR: q.packPriceINR,
    gstRate: q.gstRate,
    gstAmountINR: q.gstAmountINR,
    totalAmountINR: q.totalAmountINR,
    currency: q.currency,
    creditsGranted: q.creditsGranted,
    creditsGrantedMilli: q.creditsGrantedMilli,
    fxSnapshot: q.fxSnapshot,
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
    grantedAtMs: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  }) });
  const q = intent;
  return {
    orderId: intent.orderId,
    paymentSessionId: intent.paymentSessionId,
    amounts: {
      packPriceINR: q.packPriceINR,
      gstRate: q.gstRate,
      gstAmountINR: q.gstAmountINR,
      totalAmountINR: q.totalAmountINR,
      currency: q.currency,
    },
    creditsGranted: q.creditsGranted,
  };
}

// Webhook-side grant of FROZEN credits to the existing wallet's topup bucket.
// Idempotent via deterministic ledger `topup-{orderId}` + order status gate
// performed by the caller. Only the topup bucket moves; monthly/rollover/
// reserved are untouched. Returns { granted, duplicate, balanceAfterMilli }.
async function grantTopupCredits({ uid, order }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const o = (order && typeof order === "object") ? order : {};
  const orderId = cleanId(o.orderId, 160);
  const amount = num(o.creditsGrantedMilli);
  if (!id || !orderId) throw invalidRequest("missing uid/orderId");
  if (!(amount > 0)) throw invalidRequest("order has no frozen credits");
  const ref = d.store.collection("creditAccounts").doc(id);
  const ledgerRef = ref.collection("ledger").doc(`topup-${orderId}`);
  return d.store.runTransaction(async (tx) => {
    const existing = await tx.get(ledgerRef);
    if (existing.exists) {
      const doc = existing.data() || {};
      return { granted: false, duplicate: true, balanceAfterMilli: num(doc.balanceAfterMilli) };
    }
    const uSnap = await tx.get(ref);
    const cur = uSnap.exists ? (uSnap.data() || {}) : {};
    const toSafe = toSafeAccount(id, cur);
    const after = num(toSafe.topupRemainingCreditsMilli) + amount;
    tx.set(ref, {
      uid: id,
      topupRemainingCreditsMilli: after,
      reservedCreditsMilli: num(toSafe.reservedCreditsMilli),
      updatedAtMs: Date.now(),
    }, { merge: true });
    tx.set(ledgerRef, {
      type: "topup_purchase",
      uid: id,
      orderId,
      quoteId: typeof o.quoteId === "string" ? o.quoteId : null,
      amountMilli: amount,
      creditsGranted: Math.floor(amount / 1000),
      packPriceINR: typeof o.packPriceINR === "number" ? o.packPriceINR : null,
      gstAmountINR: typeof o.gstAmountINR === "number" ? o.gstAmountINR : null,
      totalAmountINR: typeof o.totalAmountINR === "number" ? o.totalAmountINR : null,
      fxSnapshot: o.fxSnapshot && typeof o.fxSnapshot === "object" ? o.fxSnapshot : null,
      economicsSnapshot: o.economicsSnapshot && typeof o.economicsSnapshot === "object" ? o.economicsSnapshot : null,
      balanceAfterMilli: after,
      createdAtMs: Date.now(),
    });
    return { granted: true, duplicate: false, balanceAfterMilli: after };
  });
}

// Refund groundwork (service-level only; no HTTP route yet). Never deletes
// the original purchase ledger. Full unused amount → deterministic reversal.
// Partially consumed → controlled review state, NO negative wallet.
async function refundTopup({ uid, orderId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const oid = cleanId(orderId, 160);
  if (!id || !oid) throw invalidRequest("missing uid/orderId");
  const orderRef = d.store.collection(TOPUP_ORDER_COLLECTION).doc(oid);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw coded("unknown topup order", "SUBI_QUOTE_INVALID");
  const order = orderSnap.data() || {};
  if (order.uid !== id) throw coded("order owner mismatch", "SUBI_QUOTE_INVALID");
  const amount = num(order.creditsGrantedMilli);
  if (!(amount > 0)) throw invalidRequest("order has no granted credits");
  return d.store.runTransaction(async (tx) => {
    const cur = await tx.get(orderRef);
    const curData = cur.exists ? cur.data() || {} : {};
    // Idempotent terminals are decided INSIDE the transaction (a pre-check
    // outside would break repeat calls after the first refund).
    if (curData.status === "refunded") return { refunded: true, duplicate: true };
    if (curData.status === "refund_review") return { refunded: false, review: true, duplicate: true };
    if (curData.status !== "granted") throw coded("only granted orders can refund", "INVALID_REQUEST");
    const ref = d.store.collection("creditAccounts").doc(id);
    const uSnap = await tx.get(ref);
    const toSafe = toSafeAccount(id, uSnap.exists ? (uSnap.data() || {}) : {});
    const available = num(toSafe.topupRemainingCreditsMilli);
    if (available >= amount) {
      const after = available - amount;
      tx.set(ref, { topupRemainingCreditsMilli: after, updatedAtMs: Date.now() }, { merge: true });
      tx.set(ref.collection("ledger").doc(`topup-refund-${oid}`), {
        type: "topup_reversal",
        uid: id,
        orderId: oid,
        amountMilli: -amount,
        balanceAfterMilli: after,
        reason: "full_unused_reversal",
        createdAtMs: Date.now(),
      });
      tx.set(orderRef, { status: "refunded", updatedAtMs: Date.now() }, { merge: true });
      return { refunded: true, duplicate: false, balanceAfterMilli: after };
    }
    tx.set(orderRef, { status: "refund_review", updatedAtMs: Date.now() }, { merge: true });
    return { refunded: false, review: true, reason: "TOPUP_REFUND_REVIEW_REQUIRED" };
  });
}

// Owner-only status read for the web success page (backend truth, never the
// redirect alone). Returns safe order fields + current wallet total, or null.
async function readTopupOrder({ uid, orderId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const oid = cleanId(orderId, 160);
  if (!id || !oid) return null;
  const snap = await d.store.collection(TOPUP_ORDER_COLLECTION).doc(oid).get();
  if (!snap.exists) return null;
  const o = snap.data() || {};
  if (o.uid !== id) return null;
  let walletTotalAvailableMilli = null;
  try {
    const acct = toSafeAccount(id, ((await d.store.collection("creditAccounts").doc(id).get()).data() || {}));
    walletTotalAvailableMilli = num(acct.monthlyRemainingCreditsMilli)
      + num(acct.rolloverRemainingCreditsMilli) + num(acct.topupRemainingCreditsMilli);
  } catch (_) {
    walletTotalAvailableMilli = null;
  }
  return {
    orderId: oid,
    status: o.status || null,
    packPriceINR: typeof o.packPriceINR === "number" ? o.packPriceINR : null,
    gstAmountINR: typeof o.gstAmountINR === "number" ? o.gstAmountINR : null,
    totalAmountINR: typeof o.totalAmountINR === "number" ? o.totalAmountINR : null,
    currency: o.currency || null,
    creditsGranted: typeof o.creditsGranted === "number" ? o.creditsGranted : null,
    creditsGrantedMilli: typeof o.creditsGrantedMilli === "number" ? o.creditsGrantedMilli : null,
    paidAtMs: typeof o.paidAtMs === "number" ? o.paidAtMs : null,
    grantedAtMs: typeof o.grantedAtMs === "number" ? o.grantedAtMs : null,
    walletTotalAvailableMilli,
  };
}

// Webhook-side settlement for a VERIFIED-paid top-up order. Freezes nothing
// new: grants exactly order.creditsGrantedMilli (frozen at quote). Safe to
// retry: deterministic ledger `topup-{orderId}` + granted-status re-checks
// converge to exactly one grant, one balance increment, one ledger entry.
async function handleTopupWebhook({ orderId, payload }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cf = d.cashfree || cashfree;
  const oid = cleanId(orderId, 160);
  if (!oid) throw invalidRequest("missing orderId");
  const orderRef = d.store.collection(TOPUP_ORDER_COLLECTION).doc(oid);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return { received: true, ignored: "unknown-topup-order", orderId: oid };
  const order = orderSnap.data() || {};
  if (order.productType !== TOPUP_PRODUCT_TYPE) {
    return { received: true, ignored: "wrong-product", orderId: oid };
  }
  if (['granted', 'refunded', 'refund_review'].includes(order.status)) {
    return { received: true, duplicate: true, orderId: oid };
  }
  const cfOrder = await cf.fetchCashfreeOrder(oid);
  const paid = cf.isPaidStatus(cfOrder && cfOrder.order_status);
  const nowMs = Date.now();
  // All non-grant terminal writes are granted-guarded in-transaction: a
  // concurrent duplicate that already granted must never be overwritten.
  async function markUnlessGranted(patch) {
    await d.store.runTransaction(async (tx) => {
      const cur = await tx.get(orderRef);
      const curData = cur.exists ? cur.data() || {} : {};
      if (curData.status === "granted") return;
      tx.set(orderRef, { ...patch, updatedAtMs: nowMs }, { merge: true });
    });
  }
  if (!paid) {
    await markUnlessGranted({
      status: String((cfOrder && cfOrder.order_status) || "failed").toLowerCase(),
      failureReason: "cashfree-not-paid",
    });
    return { received: true, granted: false, orderId: oid, reason: "not-paid" };
  }
  const cfAmount = Number(cfOrder && (cfOrder.order_amount ?? cfOrder.orderAmount));
  const cfTags = (cfOrder && cfOrder.order_tags) || {};
  if (cfAmount !== Number(order.totalAmountINR)
    || String(cfOrder.order_currency || '') !== 'INR'
    || String(cfTags.productType || "") !== TOPUP_PRODUCT_TYPE
    || String(cfTags.quoteId || "") !== String(order.quoteId || "")) {
    await markUnlessGranted({ status: "blocked", failureReason: "amount-or-product-mismatch" });
    return { received: true, granted: false, orderId: oid, reason: "amount-or-product-mismatch" };
  }
  // Quote/order relationship: the frozen credits must match the server quote.
  const qSnap = await d.store.collection(TOPUP_QUOTE_COLLECTION).doc(cleanId(order.quoteId, 160)).get();
  const q = qSnap.exists ? qSnap.data() || {} : null;
  if (!q || q.uid !== order.uid
    || num(q.creditsGrantedMilli) !== num(order.creditsGrantedMilli)
    || q.status !== 'consumed' || q.consumedOrderId !== oid
    || q.totalAmountINR !== order.totalAmountINR || q.currency !== order.currency
    || num(order.creditsGrantedMilli) <= 0) {
    await markUnlessGranted({ status: "blocked", failureReason: "quote-order-mismatch" });
    return { received: true, granted: false, orderId: oid, reason: "quote-order-mismatch" };
  }
  // Active individual SUBI required at grant time too (top-ups supplement).
  // Inactive/school → visible blocked marker (retryable later), never a
  // grant and never a throw (matches the subscription webhook contract).
  try {
    await requireActiveIndividualSubi(order.uid);
  } catch (err) {
    await markUnlessGranted({ status: "blocked", failureReason: "subscription-inactive" });
    return { received: true, granted: false, orderId: oid, reason: "subscription-inactive" };
  }
  const paymentId = cf.extractPaymentId(payload, cfOrder);
  const granted = await grantTopupCredits({ uid: order.uid, order }, { store: d.store });
  await d.store.runTransaction(async (tx) => {
    const cur = await tx.get(orderRef);
    const curData = cur.exists ? cur.data() || {} : {};
    if (curData.status === "granted") return;
    tx.set(orderRef, {
      status: "granted",
      paymentId: paymentId || null,
      paidAtMs: nowMs,
      grantedAtMs: nowMs,
      updatedAtMs: nowMs,
    }, { merge: true });
  });
  return {
    received: true,
    granted: true,
    duplicate: granted.duplicate === true,
    orderId: oid,
    uid: order.uid,
    creditsGranted: num(order.creditsGrantedMilli) / 1000,
    creditsGrantedMilli: num(order.creditsGrantedMilli),
    balanceAfterMilli: granted.balanceAfterMilli,
  };
}

async function reconcileOwnedTopupOrder({ uid, orderId }, deps) {
  if (!await readTopupOrder({ uid, orderId }, deps)) throw coded('order unavailable', 'FORBIDDEN');
  return handleTopupWebhook({ orderId, payload: {} }, deps);
}

module.exports = {
  TOPUP_PRODUCT_TYPE,
  TOPUP_PACKS_INR,
  TOPUP_QUOTE_COLLECTION,
  TOPUP_ORDER_COLLECTION,
  TOPUP_GRANT_ROUND_STEP,
  createTopupQuote,
  requireValidTopupQuote,
  consumeTopupQuote,
  createTopupOrder,
  readTopupOrder,
  grantTopupCredits,
  handleTopupWebhook,
  reconcileOwnedTopupOrder,
  refundTopup,
  topupsEnabled,
  requireActiveIndividualSubi,
};
