// functions-subi/src/services/subiCashfreeService.js
// Cashfree client for INDIVIDUAL SUBI billing only.
// Mirrors the verification architecture of functions/createCashfreeOrder +
// cashfreeWebhook (same HMAC scheme, same server-side order fetch as truth):
//   signature = base64(HMAC-SHA256(secret, timestamp + rawBody))
// Never trusts webhook payload amounts. Never logs secrets.
//
// Secrets come from process.env (CASHFREE_CLIENT_ID / CASHFREE_CLIENT_SECRET
// / CASHFREE_API_BASE / CASHFREE_API_VERSION) with DI overrides ({ clientId,
// clientSecret, apiBase, apiVersion, webhookSecret, fetchImpl }) for fakes.
// Webhook HMAC verification uses CASHFREE_CLIENT_SECRET as the authoritative
// key (no separate webhook secret binding). Never accept secrets from requests.
//
// BOUNDARY: HTTPS to Cashfree only. Never Firestore. Never secrets to logs.

const crypto = require("crypto");

function orderIdempotencyKey(orderId) {
  const dnsNamespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const bytes = crypto.createHash('sha1').update(dnsNamespace).update(`subi.cashfree.order:${orderId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes.toString('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

function defaultDeps() {
  return {
    clientId: process.env.CASHFREE_CLIENT_ID || "",
    clientSecret: process.env.CASHFREE_CLIENT_SECRET || "",
    webhookSecret: process.env.CASHFREE_CLIENT_SECRET || "",
    apiBase: (process.env.CASHFREE_API_BASE || "https://api.cashfree.com/pg").replace(/\/+$/, ""),
    apiVersion: process.env.CASHFREE_API_VERSION || "2022-09-01",
    fetchImpl: fetch,
  };
}

function cleanStr(v, max = 200) { return String(v || "").trim().slice(0, max); }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }

function creds(d) {
  if (!d.clientId || !d.clientSecret) throw coded("cashfree not configured", "SUBI_BILLING_UNAVAILABLE");
  return d;
}

// HMAC verification identical to functions/cashfreeWebhook:
// base64(HMAC_SHA256(secret, timestamp + rawBody)), timing-safe compare.
function verifyWebhookSignature({ timestamp, signature, rawBody }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (!d.webhookSecret) return false;
  const ts = String(timestamp || "");
  const sig = String(signature || "");
  if (!ts || !sig) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expected = crypto.createHmac("sha256", d.webhookSecret)
    .update(Buffer.concat([Buffer.from(ts, "utf8"), body]))
    .digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractOrderId(payload) {
  const p = (payload && typeof payload === "object") ? payload : {};
  return (
    p?.data?.order?.order_id ||
    p?.data?.order_id ||
    p?.order_id ||
    p?.data?.payment?.order_id ||
    p?.order?.order_id ||
    null
  );
}

function extractPaymentId(payload, orderData) {
  const p = (payload && typeof payload === "object") ? payload : {};
  const o = (orderData && typeof orderData === "object") ? orderData : {};
  return (
    p?.data?.payment?.cf_payment_id ||
    p?.data?.payment?.payment_id ||
    o?.cf_payment_id ||
    o?.payments?.[0]?.cf_payment_id ||
    null
  );
}

function isPaidStatus(orderStatus) {
  return ["PAID", "SUCCESS"].includes(String(orderStatus || "").toUpperCase());
}

// Server-side order truth (never the webhook body).
async function fetchCashfreeOrder(orderId, deps) {
  const d = creds({ ...defaultDeps(), ...(deps || {}) });
  const id = cleanStr(orderId, 128);
  if (!id) throw coded("missing orderId", "INVALID_REQUEST");
  let res;
  try {
    res = await d.fetchImpl(`${d.apiBase}/orders/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: {
        "x-client-id": d.clientId,
        "x-client-secret": d.clientSecret,
        "x-api-version": d.apiVersion,
      },
    });
  } catch (_) {
    throw coded("cashfree unreachable", "SUBI_BILLING_UNAVAILABLE");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw coded("cashfree order fetch failed", "SUBI_BILLING_UNAVAILABLE");
  return data || {};
}

// Create a Cashfree payment order for a server quote. Amounts come ONLY from
// the quote (never the request body beyond quoteId + buyer contact).
async function createCashfreeOrder({ orderId, quote, buyer, returnUrl }, deps) {
  const d = creds({ ...defaultDeps(), ...(deps || {}) });
  const q = (quote && typeof quote === "object") ? quote : {};
  if (!cleanStr(orderId, 128)) throw coded("missing orderId", "INVALID_REQUEST");
  const name = cleanStr(buyer && buyer.name, 120);
  const email = cleanStr(buyer && buyer.email, 120).toLowerCase();
  const phone = cleanStr(buyer && buyer.phone, 20);
  if (!name || !email || !phone) throw coded("buyer name/email/phone required", "INVALID_REQUEST");
  const safeCustomerId = email.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || `subi_${orderId}`.slice(0, 64);
  const payload = {
    order_id: orderId,
    order_amount: Number(q.totalAmountINR),
    order_currency: q.currency || "INR",
    customer_details: {
      customer_id: safeCustomerId,
      customer_name: name,
      customer_email: email,
      customer_phone: phone,
    },
    order_note: "SUBI individual subscription",
    ...(returnUrl ? { order_meta: { return_url: String(returnUrl).slice(0, 500) } } : {}),
    order_tags: {
      productType: q.cashfreeProductType || q.productType,
      quoteId: q.quoteId,
      uid: q.uid,
      billingMonths: String(q.billingMonths),
      baseAmount: String(q.baseAmountINR),
      gstRate: String(q.gstRate),
      gstAmount: String(q.gstAmountINR),
    },
  };
  let res;
  try {
    res = await d.fetchImpl(`${d.apiBase}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-idempotency-key": orderIdempotencyKey(orderId),
        "x-client-id": d.clientId,
        "x-client-secret": d.clientSecret,
        "x-api-version": d.apiVersion,
      },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    throw coded("cashfree unreachable", "SUBI_BILLING_UNAVAILABLE");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw coded((data && data.message) || "cashfree order failed", "SUBI_BILLING_UNAVAILABLE");
  return data || {};
}

module.exports = {
  verifyWebhookSignature,
  extractOrderId,
  extractPaymentId,
  isPaidStatus,
  fetchCashfreeOrder,
  createCashfreeOrder,
};
