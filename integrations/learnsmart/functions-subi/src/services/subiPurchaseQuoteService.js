// functions-subi/src/services/subiPurchaseQuoteService.js
// Backend-authoritative SUBI purchase quotes (individual-only).
// The browser NEVER sends price/credits/GST/period/FX: it receives a quoteId
// and the checkout uses server-computed amounts. Tampered client numbers are
// ignored by construction (quote math lives in subiBillingConfig).
//
// Collection (subi DB): subiBillingQuotes/{quoteId}
//   { quoteId, uid, product, productType, baseAmountINR, gstRate,
//     gstAmountINR, totalAmountINR, currency, billingMonths,
//     status: created|consumed|expired, createdAtMs, expiresAtMs,
//     consumedOrderId? }
//
// BOUNDARY: uses ONLY subiDb. Never learnsmartDb. DI supports fakes.

const crypto = require("crypto");
const { subiDb } = require("../db");
const { getEconomicsConfig } = require('./individualCreditEconomicsConfig');
const {
  PRODUCT_TYPE,
  QUOTE_TTL_MS,
  buildSubiQuoteAmounts,
} = require("./subiBillingConfig");

const COLLECTION = "subiBillingQuotes";

function defaultDeps() {
  return { store: subiDb };
}
function cleanId(v, max = 128) { return String(v || "").trim().slice(0, max); }
function invalidRequest(m) { const e = new Error(m || "invalid quote payload"); e.code = "INVALID_REQUEST"; return e; }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }

function newQuoteId(uid) {
  return `SUBIQ-${Date.now()}-${cleanId(uid, 16)}-${crypto.randomBytes(4).toString("hex")}`;
}

function toSafeQuote(id, data) {
  const d = (data && typeof data === "object") ? data : {};
  return {
    quoteId: id,
    uid: typeof d.uid === "string" ? d.uid : null,
    configVersion: Number.isSafeInteger(d.configVersion) ? d.configVersion : 1,
    economicsSnapshot: d.economicsSnapshot || null,
    product: d.product || null,
    productType: d.productType || null,
    baseAmountINR: typeof d.baseAmountINR === "number" ? d.baseAmountINR : null,
    gstRate: typeof d.gstRate === "number" ? d.gstRate : null,
    gstAmountINR: typeof d.gstAmountINR === "number" ? d.gstAmountINR : null,
    totalAmountINR: typeof d.totalAmountINR === "number" ? d.totalAmountINR : null,
    currency: d.currency || null,
    billingMonths: typeof d.billingMonths === "number" ? d.billingMonths : null,
    status: d.status || null,
    createdAtMs: typeof d.createdAtMs === "number" ? d.createdAtMs : null,
    expiresAtMs: typeof d.expiresAtMs === "number" ? d.expiresAtMs : null,
    consumedOrderId: typeof d.consumedOrderId === "string" ? d.consumedOrderId : null,
  };
}

// Create a fresh server quote for an individual uid. Caller must have
// verified directory accountType === "individual" already.
async function createSubiQuote({ uid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const cfg = await getEconomicsConfig({ store: d.store });
  const amounts = buildSubiQuoteAmounts({ baseAmountINR: cfg.priceINR });
  const nowMs = Date.now();
  const quoteId = newQuoteId(id);
  const doc = {
    quoteId,
    uid: id,
    configVersion: cfg.configVersion,
    economicsSnapshot: { priceINR: cfg.priceINR, bufferINR: cfg.bufferINR, providerFundingMultiplier: cfg.providerFundingMultiplier, rolloverPct: cfg.rolloverPct, topupMarginPct: cfg.topupMarginPct },
    ...amounts,
    status: "created",
    createdAtMs: nowMs,
    expiresAtMs: nowMs + QUOTE_TTL_MS,
    consumedOrderId: null,
  };
  await d.store.collection(COLLECTION).doc(quoteId).set(doc);
  return toSafeQuote(quoteId, doc);
}

// Load a quote and enforce: exists, belongs to uid, product matches,
// unexpired, unconsumed. Anything else fails closed (tamper-proof).
async function requireValidQuote({ uid, quoteId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const qid = cleanId(quoteId, 128);
  if (!id || !qid) throw invalidRequest("missing uid/quoteId");
  const snap = await d.store.collection(COLLECTION).doc(qid).get();
  if (!snap.exists) throw coded("unknown quote", "SUBI_QUOTE_INVALID");
  const q = toSafeQuote(qid, snap.data() || {});
  if (q.uid !== id) throw coded("quote owner mismatch", "SUBI_QUOTE_INVALID");
  if (q.productType !== PRODUCT_TYPE || q.product !== "subi") {
    throw coded("quote product mismatch", "SUBI_QUOTE_INVALID");
  }
  if (q.status !== "created") throw coded("quote already used", "SUBI_QUOTE_INVALID");
  if (!(q.expiresAtMs > Date.now())) throw coded("quote expired", "SUBI_QUOTE_EXPIRED");
  // Recompute server math and require an exact match (stored tampering fails).
  // The quote retains its own price after a later admin edit.
  const amounts = buildSubiQuoteAmounts({ baseAmountINR: q.baseAmountINR });
  if (q.economicsSnapshot && q.economicsSnapshot.priceINR !== q.baseAmountINR) throw coded('quote funding mismatch', 'SUBI_QUOTE_INVALID');
  if (q.currency !== amounts.currency || q.baseAmountINR !== amounts.baseAmountINR
    || q.gstRate !== amounts.gstRate
    || q.gstAmountINR !== amounts.gstAmountINR
    || q.totalAmountINR !== amounts.totalAmountINR
    || q.billingMonths !== amounts.billingMonths) {
    throw coded("quote amount mismatch", "SUBI_QUOTE_INVALID");
  }
  return q;
}

// Single-use: mark consumed by orderId inside a transaction. Concurrent
// double-order attempts on one quote converge (second sees consumed).
async function consumeQuote({ uid, quoteId, orderId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const ref = d.store.collection(COLLECTION).doc(cleanId(quoteId, 128));
  return d.store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw coded("unknown quote", "SUBI_QUOTE_INVALID");
    const q = toSafeQuote(quoteId, snap.data() || {});
    if (q.uid !== cleanId(uid) || q.status !== "created") {
      throw coded("quote already used", "SUBI_QUOTE_INVALID");
    }
    if (!(q.expiresAtMs > Date.now())) throw coded("quote expired", "SUBI_QUOTE_EXPIRED");
    tx.set(ref, { status: "consumed", consumedOrderId: cleanId(orderId, 128) }, { merge: true });
    return q;
  });
}

module.exports = {
  COLLECTION,
  createSubiQuote,
  requireValidQuote,
  consumeQuote,
};
