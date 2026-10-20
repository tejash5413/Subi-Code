// functions-subi/src/routes/managedSubiCode.js
// Explicit Subi Code entitlement status for LearnSmart students/teachers.
// Independent of AI Connection: never touches secrets, OpenRouter, or keys.
//
// GET /managed/subicode-status -> { active, tier, renewalDateMs, source }
// Sources: individual_subscription | school_default | none.
// Route-scoped requireAuth({ managedOnly: true }); uid/role/school come from
// the verified token + trusted directory, never the request body.

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  getUserProfile,
  getSchool,
} = require("../services/learnsmartDirectoryService");
const {
  evaluateSubiCodeEntitlement,
} = require("../services/subiCodeEntitlementService");
const monthlyLimits = require("../services/monthlyLimitService");
const { resolveQuotaMode } = require('../services/quotaModeService');

function router() {
  const r = express.Router();

  r.get("/managed/subicode-status", requireAuth({ managedOnly: true }), async (req, res) => {
    const ctx = req.subi || {};
    try {
      const profile = await getUserProfile(ctx.uid);
      if (!profile) {
        return res.status(403).json({ active: false, code: "SUBI_UNKNOWN_USER" });
      }
      // Fail closed: unknown/missing account type never coerces to school.
      const accountType = profile.accountType;
      if (accountType !== "individual" && accountType !== "school") {
        return res.status(403).json({ active: false, code: "ACCOUNT_TYPE_UNSUPPORTED" });
      }
      let schoolSubscription = null;
      if (accountType === "school" && profile.schoolId) {
        try {
          const school = await getSchool(profile.schoolId);
          schoolSubscription = (school && school.subscription) || null;
        } catch (_) {
          schoolSubscription = null;
        }
      }
      const decision = evaluateSubiCodeEntitlement({
        accountType,
        userSubscription: profile.subscription || null,
        schoolSubscription,
      });
      if (!decision.allowed) {
        return res.json({
          active: false,
          code: decision.code || "SUBI_CODE_REQUIRED",
          tier: null,
          renewalDateMs: decision.renewalDateMs ?? null,
          source: accountType === "individual" ? "individual_subscription" : "school_default",
          quotaMode: resolveQuotaMode(profile),
        });
      }
      if (accountType === "individual") {
        // Single-plan: no tier is exposed (no Basic/Plus/Pro plans exist).
        return res.json({
          active: true,
          tier: null,
          renewalDateMs: decision.renewalDateMs ?? null,
          source: "individual_subscription",
          quotaMode: resolveQuotaMode(profile),
        });
      }
      // School allowance = existing superadmin Monthly Limit settings
      // for this school (role-specific token default), if configured.
      let allowance = null;
      try {
        const schoolLimits = await monthlyLimits.getSchoolLimits(profile.schoolId);
        const tokens =
          ctx.role === "teacher"
            ? schoolLimits.teacherMonthlyTokens
            : schoolLimits.studentMonthlyTokens;
        if (typeof tokens === "number") {
          allowance = {
            monthlyRequests: null,
            monthlyTokens: tokens,
            allowanceSource: "school_monthly_limit",
          };
        }
      } catch (_) {
        allowance = null;
      }
      return res.json({
        active: Boolean(allowance),
        tier: null,
        renewalDateMs:
          (schoolSubscription && schoolSubscription.renewalDateMs) ||
          (profile.subscription && profile.subscription.renewalDateMs) ||
          null,
        source: "school_default",
        quotaMode: resolveQuotaMode(profile),
        allowance,
      });
    } catch (err) {
      return res.status(500).json({ error: { code: "INTERNAL" } });
    }
  });

  return r;
}

module.exports = { managedSubiCodeRouter: router };
