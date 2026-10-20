// functions-subi/src/routes/managedLimits.js
// Normal-user effective monthly token limit (Phase 5).
// Firestore policy reads only — no secret resolution, no OpenRouter call.
// Phase-3 access gate applies: blocked users receive the safe disabled
// response instead of quota details. Safe projection only.

const express = require("express");
const accessService = require("../services/accessService");
const limits = require("../services/monthlyLimitService");
const quotaModeService = require("../services/quotaModeService");
const individualCreditAccountService = require("../services/individualCreditAccountService");
const individualCreditReady = require("../services/individualCreditReadyService");
const { MONTH_PERIOD } = require("../services/monthlyLimitService");
const { requireAuth } = require("../middleware/auth");
const { safeCode: safeLimitsCode, statusFor: statusForLimits } = require("../utils/redact");
const { info: logLimitsInfo, hashRequestId } = require("../utils/structuredLogger");

// Safe bootstrap diagnostics (observability only): hashed UID, coarse
// account/role/quota, outcome code, elapsed time. Never UID/email/token.
function instrumentLimitsDiagnostics(req, res, ctx, startedMs) {
  try {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const b = body && typeof body === "object" ? body : {};
        logLimitsInfo("managed-monthly-limit-status", {
          uidHash: hashRequestId(ctx.uid),
          accountType: typeof ctx.accountType === "string" ? ctx.accountType.slice(0, 32) : null,
          role: typeof ctx.role === "string" ? ctx.role.slice(0, 16) : null,
          quotaMode: typeof b.quotaMode === "string" ? b.quotaMode.slice(0, 32) : null,
          configured: typeof b.configured === "boolean" ? b.configured : null,
          code: (typeof b.code === "string" && b.code) ||
            (b.error && typeof b.error.code === "string" && b.error.code) || null,
          elapsedMs: Date.now() - startedMs,
        });
      } catch (_) {
        // Observability must never affect the response.
      }
      return origJson(body);
    };
  } catch (_) {
    // Observability must never affect the request.
  }
}

// Individual monthly-limit credit projection. Carries the full wallet shape
// for parity with /managed/usage (grant + cycle end included); never a
// monthlyTokenLimit (token limits are not authoritative for individuals).
// Older extension builds accept the reduced shape (missing fields normalize
// to null client-side); current validators accept both shapes.
const { toCreditSnapshot: toLimitsCredits } = require('../services/individualCreditContract');

function router() {
  const r = express.Router();

  // See managedAccess.js: managedOnly is route-scoped, never app-level.
  r.get("/managed/monthly-limit", requireAuth({ managedOnly: true }), async (req, res) => {
    const ctx = req.subi || {};
    const startedMs = Date.now();
    instrumentLimitsDiagnostics(req, res, ctx, startedMs);
    let access;
    try {
      access = await accessService.resolveSubiAccess({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        accountType: ctx.accountType,
      });
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(503).json({ allowed: false, code: "SUBI_ACCESS_UNAVAILABLE" });
      }
      return res.status(500).json({ error: { code: "INTERNAL" } });
    }
    if (!access.allowed) {
      return res.json({ allowed: false, code: "SUBI_ACCESS_DISABLED" });
    }
    try {
      // Unknown/missing account type fails closed (no school fallback).
      let quotaMode;
      try {
        quotaMode = quotaModeService.resolveQuotaMode({ accountType: ctx.accountType });
      } catch (_) {
        return res.status(403).json({ allowed: false, code: "ACCOUNT_TYPE_UNSUPPORTED" });
      }
      if (quotaMode === "individual_credits") {
        // Individuals use credits only. There is deliberately NO
        // monthlyTokenLimit here: token limits are not authoritative for
        // individual credit accounts (and must never become so).
        // Same current-cycle guarantee as /managed/usage via the shared
        // preflight (bootstrap may open after a boundary).
        try {
          const acct = await individualCreditReady.ensureIndividualCreditReady({
            uid: ctx.uid,
            accountType: ctx.accountType,
          });
          return res.json({
            quotaMode: "individual_credits",
            configured: true,
            credits: toLimitsCredits(acct),
            period: MONTH_PERIOD,
          });
        } catch (err) {
          const code = safeLimitsCode((err && err.code) || "INTERNAL");
          const existing = await individualCreditAccountService.getCreditAccount(ctx.uid).catch(() => null);
          const snapshot = toLimitsCredits(existing);
          if (code === "SUBI_NO_PAID_PERIOD" && !existing) {
            return res.json({
              quotaMode: "individual_credits",
              configured: false,
              credits: null,
              period: MONTH_PERIOD,
              code,
            });
          }
          if (code === "ACCOUNT_TYPE_UNSUPPORTED" || code === "SUBI_UNKNOWN_USER") {
            return res.status(statusForLimits(code)).json({ allowed: false, code });
          }
          if (code === "FX_UNAVAILABLE" || code === "SUBI_BILLING_UNAVAILABLE") {
            return res.status(statusForLimits(code)).json({
              quotaMode: "individual_credits",
              configured: existing !== null,
              credits: snapshot,
              period: MONTH_PERIOD,
              code,
            });
          }
          // Expired / not-entitled / future: 200 with preserved snapshot so
          // bootstrap still shows purchased top-up; the code signals state.
          // (Agent dispatch remains the enforcing gate, not this read.)
          return res.json({
            quotaMode: "individual_credits",
            configured: existing !== null,
            credits: snapshot,
            period: MONTH_PERIOD,
            code,
          });
        }
      }
      const effective = await limits.resolveEffectiveMonthlyLimit({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        // Account type is authoritative for policy precedence. Omitting it
        // activates the legacy compatibility path and can incorrectly apply
        // an orphaned individual override to a school account.
        accountType: ctx.accountType,
      });
      if (!effective.configured) {
        return res.json({
          quotaMode: "school_tokens",
          configured: false,
          monthlyTokenLimit: null,
          period: MONTH_PERIOD,
          source: limits.toSafePolicySource(effective.source),
        });
      }
      return res.json({
        quotaMode: "school_tokens",
        configured: true,
        monthlyTokenLimit: effective.monthlyTokenLimit,
        period: MONTH_PERIOD,
        source: limits.toSafePolicySource(effective.source),
      });
    } catch (err) {
      if (err && err.code === "UNAVAILABLE") {
        return res.status(503).json({ allowed: false, code: "SUBI_ACCESS_UNAVAILABLE" });
      }
      return res.status(500).json({ error: { code: "INTERNAL" } });
    }
  });

  return r;
}

module.exports = { managedLimitsRouter: router };
