// functions-subi/src/routes/billing.js
// INDIVIDUAL SUBI billing HTTP surface (₹499/mo + GST, single plan).
// Quote + order creation are gated on billingEnabled (OFF by default: no
// behavior change while disabled). The webhook processes already-created
// SUBI orders regardless of the flag (money moved; must settle).
// Recovery helper is service-only in this phase (no request-time auto-grant).
//
// Schools NEVER enter these paths (directory individual check on quote/order
// and re-verified on webhook). No secrets in responses or logs.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { statusFor, errorBody } = require("../utils/redact");
const flags = require("../services/individualCreditFlags");
const billingConfig = require("../services/subiBillingConfig");
const economicsConfig = require('../services/individualCreditEconomicsConfig');
const billing = require("../services/subiBillingService");
const topups = require("../services/subiTopupService");
const { readOwnedCheckoutIntent, closeUnusedCheckoutIntent, resumeOwnedCheckoutIntent } = require('../services/subiCheckoutRecoveryService');

function sendMapped(res, err, fallback = "INTERNAL") {
  const code = (err && typeof err.code === "string" && err.code) || fallback;
  return res.status(statusFor(code)).json(errorBody(code));
}

async function billingEnabled() {
  try {
    const f = await flags.getIndividualCreditFlags();
    return f && f.billingEnabled === true;
  } catch (_) {
    return false;
  }
}

async function topupsEnabled() {
  try {
    const f = await flags.getIndividualCreditFlags();
    return f && f.topupsEnabled === true;
  } catch (_) {
    return false;
  }
}

function router() {
  const r = express.Router();

  // Public product/flag surface (no secrets, no user data). Frontend gates
  // the SUBI purchase UI on billingEnabled.
  r.get("/subi/billing-status", async (req, res) => {
    try {
      const enabled = await billingEnabled();
      const cfg = await economicsConfig.getEconomicsConfig();
      return res.json({
        configVersion: cfg.configVersion,
        billingEnabled: enabled,
        topupsEnabled: await topupsEnabled(),
        creditRules: { usdPerCredit: 0.001, rolloverPct: cfg.rolloverPct, rolloverCycles: 1, purchasedCreditsCarryForward: true },
        topupPacks: cfg.topupPacks.filter(p => p.enabled).map(({ packPriceINR }) => ({ packPriceINR, gstAmountINR: Math.round(packPriceINR * billingConfig.GST_RATE), totalAmountINR: packPriceINR + Math.round(packPriceINR * billingConfig.GST_RATE), currency: 'INR' })),
        product: {
          ...billingConfig.buildSubiQuoteAmounts({ baseAmountINR: cfg.priceINR }),
          product: "subi",
          productType: billingConfig.PRODUCT_TYPE,
          baseAmountINR: cfg.priceINR,
          gstRate: billingConfig.GST_RATE,
          currency: billingConfig.CURRENCY,
          billingMonths: billingConfig.BILLING_MONTHS,
        },
      });
    } catch (_) {
      return sendMapped(res, null);
    }
  });

  // Authenticated server quote (amounts computed backend-side only).
  r.post("/subi/billing/quote", requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      if (!(await billingEnabled())) {
        return res.status(403).json(errorBody("SUBI_BILLING_UNAVAILABLE"));
      }
      const ctx = req.subi || {};
      const quote = await billing.createQuote({ uid: ctx.uid });
      return res.json({ quote });
    } catch (err) {
      return sendMapped(res, err);
    }
  });

  // Historical receipts remain readable even while new sales are disabled.
  r.get('/subi/billing/checkout-intent', requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      return res.json({ intent: await readOwnedCheckoutIntent({ uid: req.subi?.uid, kind: req.query.kind, quoteId: req.query.quoteId }) });
    } catch (err) { return sendMapped(res, err); }
  });
  r.post('/subi/billing/checkout-intent/close-unused', requireAuth({ managedOnly: true }), async (req, res) => {
    try { return res.json({ intent: await closeUnusedCheckoutIntent({ uid: req.subi?.uid, kind: req.body?.kind, quoteId: req.body?.quoteId }) }); }
    catch (err) { return sendMapped(res, err); }
  });
  r.post('/subi/billing/checkout-intent/resume', requireAuth({ managedOnly: true }), async (req, res) => {
    try { return res.json(await resumeOwnedCheckoutIntent({ uid: req.subi?.uid, kind: req.body?.kind, quoteId: req.body?.quoteId })); }
    catch (err) { return sendMapped(res, err); }
  });

  r.get("/subi/billing/order/:orderId", requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      const order = await billing.readOrder({ uid: req.subi?.uid, orderId: req.params.orderId });
      if (!order) return res.status(404).json(errorBody("SUBI_QUOTE_INVALID"));
      return res.json({ order });
    } catch (err) { return sendMapped(res, err); }
  });

  r.post('/subi/billing/combined-order', requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      const body = req.body || {};
      return res.json(await billing.createCombinedOrder({ uid: req.subi?.uid, quoteId: body.quoteId, educationQuoteId: body.educationQuoteId, buyer: body.buyer, returnOrigin: body.returnOrigin }));
    } catch (err) { return sendMapped(res, err); }
  });

  r.post('/subi/billing/order/:orderId/reconcile', requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      await billing.reconcileOwnedOrder({ uid: req.subi?.uid, orderId: req.params.orderId });
      return res.json({ order: await billing.readOrder({ uid: req.subi?.uid, orderId: req.params.orderId }) });
    } catch (err) { return sendMapped(res, err); }
  });

  // Cashfree order intent for a server quote.
  r.post("/subi/billing/order", requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      if (!(await billingEnabled())) {
        return res.status(403).json(errorBody("SUBI_BILLING_UNAVAILABLE"));
      }
      const ctx = req.subi || {};
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      const out = await billing.createOrder({
        uid: ctx.uid,
        quoteId: b.quoteId,
        buyer: b.buyer || {},
        returnOrigin: typeof b.returnOrigin === "string" ? b.returnOrigin : null,
      });
      return res.json(out);
    } catch (err) {
      return sendMapped(res, err);
    }
  });

  // Top-up packs: server-quoted frozen credits, active SUBI required.
  // Gated on topupsEnabled (OFF by default); the webhook settles
  // already-created top-up orders regardless (money moved; must settle).
  r.post("/subi/topups/quote", requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      if (!(await topupsEnabled())) {
        return res.status(403).json(errorBody("SUBI_BILLING_UNAVAILABLE"));
      }
      const ctx = req.subi || {};
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      const quote = await topups.createTopupQuote({ uid: ctx.uid, packPriceINR: b.packPriceINR });
      return res.json({ quote });
    } catch (err) {
      return sendMapped(res, err);
    }
  });

  r.post("/subi/topups/order", requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      if (!(await topupsEnabled())) {
        return res.status(403).json(errorBody("SUBI_BILLING_UNAVAILABLE"));
      }
      const ctx = req.subi || {};
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      const out = await topups.createTopupOrder({
        uid: ctx.uid,
        quoteId: b.quoteId,
        buyer: b.buyer || {},
        returnOrigin: typeof b.returnOrigin === "string" ? b.returnOrigin : null,
      });
      return res.json(out);
    } catch (err) {
      return sendMapped(res, err);
    }
  });

  // Owner-only top-up order status (success page polls backend truth, never
  // the redirect alone).
  r.get("/subi/topups/order/:orderId", requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      const ctx = req.subi || {};
      const orderId = String(req.params.orderId || "").slice(0, 160);
      const snap = await topups.readTopupOrder({ uid: ctx.uid, orderId });
      if (!snap) return res.status(404).json(errorBody("SUBI_QUOTE_INVALID"));
      return res.json({ order: snap });
    } catch (err) {
      return sendMapped(res, err);
    }
  });

  // Cashfree webhook: signature-verified, idempotent. Raw body is required
  r.post('/subi/topups/order/:orderId/reconcile', requireAuth({ managedOnly: true }), async (req, res) => {
    try {
      await topups.reconcileOwnedTopupOrder({ uid: req.subi?.uid, orderId: req.params.orderId });
      return res.json({ order: await topups.readTopupOrder({ uid: req.subi?.uid, orderId: req.params.orderId }) });
    } catch (err) { return sendMapped(res, err); }
  });

  // Cashfree webhook: signature-verified, idempotent. Raw body is required
  // for HMAC, so this route parses application/json as a Buffer itself.
  r.post(
    "/subi/billing/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res) => {
      try {
        const out = await billing.handleWebhook({
          timestamp: req.headers["x-webhook-timestamp"],
          signature: req.headers["x-webhook-signature"],
          rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.from(""),
        });
        return res.json(out);
      } catch (err) {
        return sendMapped(res, err);
      }
    }
  );

  return r;
}

module.exports = { billingRouter: router };
