// functions-subi/src/routes/managedUsage.js
// Normal-user own-usage snapshot (Phase 9A).
// Firestore policy reads only — no secret resolution, no OpenRouter call.
// Same managed access gate as models/limits: blocked users receive the safe
// disabled response (historical usage stays hidden for consistency).
// Safe projection only: configured/period/limit/used/remaining. Never uid
// parameters, school aggregates, other users, reservations, upstream data.

const express = require("express");
const accessService = require("../services/accessService");
const usageQuota = require("../services/usageQuotaService");
const quotaModeService = require("../services/quotaModeService");
const individualCreditFlags = require("../services/individualCreditFlags");
const individualCreditAccountService = require("../services/individualCreditAccountService");
const individualCreditReady = require("../services/individualCreditReadyService");
const chatConfig = require("../services/managedChatConfigService");
const { requireAuth } = require("../middleware/auth");
const { info: logUsageInfo } = require("../utils/structuredLogger");
const { safeCode: safeUsageCode, statusFor: statusForUsage } = require("../utils/redact");

const { toCreditSnapshot: toCreditSnapshot } = require('../services/individualCreditContract');

// Current-user chat capability (Phase 9B.2A): answers only "can THIS user
// send now?" from the operational gate (disabled/test/enabled + testUids).
// Never exposes mode, testUids, other UIDs, or admin config. Fail-closed:
// any doubt means chatAvailable:false. This is UI/preflight information
// only — /chat still independently revalidates access, model, limit, and
// quota on every request.
async function resolveChatCapability(uid) {
  try {
    const config = await chatConfig.getManagedChatConfig();
    return chatConfig.evaluateChatCapability(config, uid);
  } catch (_) {
    return null;
  }
}

function router() {
  const r = express.Router();

  // See managedAccess.js: managedOnly is route-scoped, never app-level.
  r.get("/managed/usage", requireAuth({ managedOnly: true }), async (req, res) => {
    const ctx = req.subi || {};
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
        return res.status(503).json({ allowed: false, code: "SUBI_ACCESS_UNAVAILABLE", chatAvailable: false });
      }
      return res.status(500).json({ error: { code: "INTERNAL" }, chatAvailable: false });
    }
    if (!access.allowed) {
      return res.json({ allowed: false, code: "SUBI_ACCESS_DISABLED", chatAvailable: false });
    }
    try {
      // Authoritative quota routing: school -> tokens, individual -> credits.
      // Account type comes from trusted directory (req.subi), never client body.
      // Unknown/missing account type fails closed (no school fallback).
      let quotaMode;
      try {
        quotaMode = quotaModeService.resolveQuotaMode({ accountType: ctx.accountType });
      } catch (_) {
        return res.status(403).json({ allowed: false, code: "ACCOUNT_TYPE_UNSUPPORTED", chatAvailable: false });
      }
      // Chat capability is quota-mode independent (operational gate only).
      // Evaluated once here so both branches below share one definition.
      const cap = await resolveChatCapability(ctx.uid);
      const chatAvailable = cap !== null && cap.chatAvailable === true;
      if (quotaMode === "individual_credits") {
        const flags = await individualCreditFlags.getIndividualCreditFlags().catch(() => null);
        void flags;
        // Lazy recovery: usage refresh creates the current monthly cycle if
        // due (extension opened after a boundary, webhook grant missed).
        // School path below is untouched.
        try {
          const acct = await individualCreditReady.ensureIndividualCreditReady({
            uid: ctx.uid,
            accountType: ctx.accountType,
          });
          return res.json({
            allowed: true,
            quotaMode: "individual_credits",
            credits: toCreditSnapshot(acct),
            chatAvailable,
          });
        } catch (err) {
          const code = safeUsageCode((err && err.code) || "INTERNAL");
          const existing = await individualCreditAccountService.getCreditAccount(ctx.uid).catch(() => null);
          const snapshot = toCreditSnapshot(existing);
          if (code === "SUBI_PLAN_EXPIRED" || code === "SUBI_CODE_REQUIRED") {
            return res.status(statusForUsage(code)).json({
              allowed: false,
              code,
              quotaMode: "individual_credits",
              credits: snapshot,
              chatAvailable,
            });
          }
          if (code === "FX_UNAVAILABLE" || code === "SUBI_NO_PAID_PERIOD" || code === "SUBI_BILLING_UNAVAILABLE") {
            // Temporary dependency (FX) or missing anchor: controlled
            // unavailable, never zero. Existing balances stay visible so
            // purchased top-up is never misreported.
            if (code === "SUBI_NO_PAID_PERIOD" && !existing) {
              return res.json({
                allowed: true,
                quotaMode: "individual_credits",
                credits: null,
                chatAvailable,
                code,
              });
            }
            return res.status(statusForUsage(code)).json({
              allowed: false,
              code,
              quotaMode: "individual_credits",
              credits: snapshot,
              chatAvailable,
            });
          }
          if (code === "ACCOUNT_TYPE_UNSUPPORTED" || code === "SUBI_UNKNOWN_USER") {
            return res.status(statusForUsage(code)).json({ allowed: false, code, chatAvailable });
          }
          // Future-paid or malformed: controlled failure with preserved snapshot.
          return res.status(statusForUsage(code)).json({
            allowed: false,
            code,
            quotaMode: "individual_credits",
            credits: snapshot,
            chatAvailable,
          });
        }
      }
      const snapshot = await usageQuota.getManagedUsage({
        uid: ctx.uid,
        schoolId: ctx.schoolId,
        role: ctx.role,
        // Keep the usage snapshot on the same account-type authority as the
        // models and monthly-limit endpoints. Without this field the legacy
        // compatibility path can surface an orphaned individual override for
        // a school account.
        accountType: ctx.accountType,
      });
      // Phase 9B.3B.1: capability and its safe diagnostic come from ONE
      // evaluation (shared `cap` above) so they can never disagree.
      // Response contract unchanged.
      try {
        logUsageInfo("managed-usage-capability-evaluated", {
          chatModeClass: cap !== null ? cap.chatModeClass : "invalid",
          testUidCount: cap !== null ? cap.testUidCount : 0,
          testUidMatched: cap !== null ? cap.testUidMatched : false,
          chatAvailable,
          accessAllowed: true,
          usageConfigured: snapshot.configured === true,
          roleClass: ctx.role === "student" ? "student" : ctx.role === "teacher" ? "teacher" : "other",
        });
      } catch (_) {
        // Observability must never affect the response.
      }
      return res.json({ allowed: true, quotaMode: "school_tokens", usage: snapshot, chatAvailable });
    } catch (_) {
      return res.status(500).json({ error: { code: "INTERNAL" }, chatAvailable: false });
    }
  });

  return r;
}

module.exports = { managedUsageRouter: router };
