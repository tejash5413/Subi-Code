// functions-subi/src/routes/adminIndividualCredits.js
// Superadmin read-only + grant controls for INDIVIDUAL credit accounts.
// Schools NEVER appear here (quotaMode routes them to tokens).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { requireSuperAdmin } = require("../middleware/superadmin");
const creditAccountService = require("../services/individualCreditAccountService");
const creditFlags = require("../services/individualCreditFlags");
const creditShadowService = require("../services/individualCreditShadowService");
const fxRateService = require("../services/fxRateService");
const econConfig = require("../services/individualCreditEconomicsConfig");
const econMath = require("../services/individualCreditEconomics");
const { getUserProfile } = require("../services/learnsmartDirectoryService");
const { toCreditSnapshot } = require('../services/individualCreditContract');
const { listCommerceOrders } = require('../services/subiCommerceHistoryService');
const { evaluateSubiCodeEntitlement } = require('../services/subiCodeEntitlementService');

function sendError(res, code, adminUid) {
  const { statusFor, errorBody } = require("../utils/redact");
  return res.status(statusFor(code)).json(errorBody(code));
}

function router() {
  const r = express.Router();

  r.get("/admin/individual-credit-flags", requireAuth(), requireSuperAdmin, async (req, res) => {
    try {
      const flags = await creditFlags.getIndividualCreditFlags();
      const fx = await fxRateService.getFxRate().catch(() => null);
      return res.json({ flags, fx });
    } catch (_) {
      return sendError(res, "INTERNAL");
    }
  });

  r.post('/admin/subi-commerce-availability', requireAuth(), requireSuperAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const flags = await creditFlags.setCommerceAvailability({ billingEnabled: body.billingEnabled, topupsEnabled: body.topupsEnabled, expectedFlagVersion: body.expectedFlagVersion, adminUid: req.subi?.uid });
      return res.json({ flags });
    } catch (err) { return sendError(res, err?.code || 'INTERNAL'); }
  });

  // Shadow rollout telemetry (read-only): aggregated "what WOULD credit
  // enforcement have charged/blocked?" across shadowUsage docs. Superadmin
  // only; never exposed to normal users. Optional ?uid= scopes to one user,
  // otherwise a collectionGroup read aggregates recent docs globally.
  r.get("/admin/credits/shadow-summary", requireAuth(), requireSuperAdmin, async (req, res) => {
    try {
      const q = (req.query && typeof req.query === "object") ? req.query : {};
      const uid = typeof q.uid === "string" ? q.uid.trim().slice(0, 128) : "";
      const rawLimit = Number(q.limit);
      const limit = uid
        ? Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50, 1), 200)
        : Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 200, 1), 1000);
      const records = uid
        ? await creditShadowService.listShadowRecords({ uid, limit })
        : await creditShadowService.fetchAllShadowRecords({ limit });
      // Minimal readiness view (Superadmin only): live rollout switch plus
      // the explicit test-UID allowlist, next to the telemetry it gates.
      // The same values are inspectable read-only via
      // GET /admin/individual-credit-flags. No separate config document.
      const rollout = await creditFlags.getIndividualCreditFlags().catch(() => null);
      const testUids = rollout && Array.isArray(rollout.shadowTestUids) ? rollout.shadowTestUids : [];
      return res.json({
        uid: uid || null,
        recordCount: records.length,
        summary: creditShadowService.summarizeShadowRecords(records),
        config: {
          shadowEnabled: rollout !== null && rollout.shadowEnabled === true,
          shadowTestUidCount: testUids.length,
          shadowTestUids: testUids,
        },
      });
    } catch (_) {
      return sendError(res, "INTERNAL");
    }
  });

  r.get("/admin/individual-credit-accounts/:uid", requireAuth(), requireSuperAdmin, async (req, res) => {
    try {
      const profile = await getUserProfile(req.params.uid);
      if (!profile || profile.accountType !== "individual") {
        return sendError(res, "INVALID_REQUEST");
      }
      const acct = await creditAccountService.getCreditAccount(profile.uid);
      const [ledger, orders] = await Promise.all([
        acct ? creditAccountService.listLedger({ uid: profile.uid, limit: 20 }) : [],
        listCommerceOrders({ uid: profile.uid, limit: 20 }),
      ]);
      const coverage = evaluateSubiCodeEntitlement({ accountType: 'individual', userSubscription: profile.subscription });
      return res.json({ uid: profile.uid, user: { displayName: profile.displayName, email: profile.email, role: profile.role }, coverage: { active: coverage.allowed && Number.isFinite(coverage.renewalDateMs) && coverage.renewalDateMs > Date.now(), paidThroughMs: coverage.renewalDateMs, periodStartMs: profile.subscription?.periodStartMs || null }, account: acct, credits: toCreditSnapshot(acct), ledger, orders });
    } catch (_) {
      return sendError(res, "INTERNAL");
    }
  });

  // Individual SUBI economics: Superadmin sets price (default 499) + buffer.
  r.get("/admin/individual-credit-economics", requireAuth(), requireSuperAdmin, async (req, res) => {
    try {
      const cfg = await econConfig.getEconomicsConfig();
      const fx = await fxRateService.getFxRate().catch(() => null);
      let preview = null;
      try {
        if (fx && Number.isFinite(Number(fx.rate))) {
          preview = econMath.monthlyGrantCredits({
            fxRate: Number(fx.rate),
            priceINR: cfg.priceINR,
            bufferINR: cfg.bufferINR,
            providerFundingMultiplier: cfg.providerFundingMultiplier,
          });
        }
      } catch (_) { preview = null; }
      return res.json({ economics: cfg, fx, previewGrant: preview });
    } catch (_) {
      return sendError(res, "INTERNAL");
    }
  });

  r.post("/admin/individual-credit-economics", requireAuth(), requireSuperAdmin, async (req, res) => {
    try {
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      const out = await econConfig.setEconomicsConfig({
        priceINR: b.priceINR,
        bufferINR: b.bufferINR,
        providerFundingMultiplier: b.providerFundingMultiplier,
        rolloverPct: b.rolloverPct,
        topupMarginPct: b.topupMarginPct,
        topupPacks: b.topupPacks,
        expectedConfigVersion: b.expectedConfigVersion,
        adminUid: req.subi && req.subi.uid,
      });
      return res.json({ economics: out });
    } catch (err) {
      if (err && err.code === "INVALID_REQUEST") return sendError(res, "INVALID_REQUEST");
      return sendError(res, "INTERNAL");
    }
  });

  r.post("/admin/fx-rate", requireAuth(), requireSuperAdmin, async (req, res) => {
    try {
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      const out = await fxRateService.setFxRate({
        rate: b.rate, source: b.source || "manual", adminUid: req.subi && req.subi.uid,
      });
      return res.json({ fx: out });
    } catch (err) {
      if (err && err.code === "INVALID_REQUEST") return sendError(res, "INVALID_REQUEST");
      return sendError(res, "INTERNAL");
    }
  });

  return r;
}

module.exports = { adminIndividualCreditsRouter: router };
