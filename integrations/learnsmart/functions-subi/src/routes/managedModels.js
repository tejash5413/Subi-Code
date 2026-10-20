// functions-subi/src/routes/managedModels.js
// Normal-user effective model list (Model Redesign).
// Firestore policy reads only — no secret resolution, no OpenRouter call.
// Phase-3 access gate applies FIRST (WHO): blocked users receive the safe
// disabled response instead of the model list. Model assignment (WHICH)
// resolves via the shared effectiveModelService seam AFTER access passes —
// the same seam POST /managed/chat preflight uses. Safe projection only
// (never upstreamModelId, pricing, roles, policies, or admin metadata).

const express = require("express");
const accessService = require("../services/accessService");
const effectiveModels = require("../services/effectiveModelService");
const modelPolicies = require("../services/modelPolicyService");
const quotaModeService = require("../services/quotaModeService");
const approvedModels = require("../services/approvedModelService");
const { requireAuth } = require("../middleware/auth");
const { info: logInfo, hashRequestId } = require("../utils/structuredLogger");

// Safe bootstrap diagnostics (observability only): hashed UID, coarse
// account/role/quota, outcome code, elapsed time. Never UID/email/token/keys.
function instrumentModelsDiagnostics(req, res, ctx, startedMs) {
  try {
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const b = body && typeof body === "object" ? body : {};
        logInfo("managed-models-status", {
          uidHash: hashRequestId(ctx.uid),
          accountType: typeof ctx.accountType === "string" ? ctx.accountType.slice(0, 32) : null,
          role: typeof ctx.role === "string" ? ctx.role.slice(0, 16) : null,
          quotaMode: typeof b.quotaMode === "string" ? b.quotaMode.slice(0, 32) : null,
          allowed: b.allowed === true,
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

function router() {
  const r = express.Router();

  // See managedAccess.js: managedOnly is route-scoped, never app-level.
  r.get("/managed/models", requireAuth({ managedOnly: true }), async (req, res) => {
    const ctx = req.subi || {};
    const startedMs = Date.now();
    instrumentModelsDiagnostics(req, res, ctx, startedMs);
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
      // Authoritative quota routing first: unknown/missing account type fails
      // closed (no school fallback, no provider-adjacent work).
      let quotaMode;
      try {
        quotaMode = quotaModeService.resolveQuotaMode({ accountType: ctx.accountType });
      } catch (_) {
        return res.status(403).json({ allowed: false, code: "ACCOUNT_TYPE_UNSUPPORTED" });
      }
      // Individual credit universe: ALL approved + enabled + compatible models
      // (same universe /agent/turn authorizes). No userModelPolicies, no tier,
      // no costClass gate. School path below is unchanged.
      if (quotaMode === "individual_credits") {
        const models = await approvedModels.listIndividualCreditModels();
        try {
          logInfo("managed-models", {
            source: "individual",
            role: String(ctx.role || "").slice(0, 16),
            assigned: -1,
            eligible: Array.isArray(models) ? models.length : -1,
            returned: Array.isArray(models) ? models.length : -1,
            refresh: "fresh",
            disabled: -1,
            removed: -1,
            notRegistered: -1,
          });
        } catch (_) {
          // Observability must never affect the response.
        }
        return res.json({ allowed: true, source: "individual", quotaMode, models });
      }
      // Single resolver seam shared with POST /managed/chat preflight.
      // The cutover branch lives in effectiveModelService; this route
      // encodes no eligibility rules of its own.
      const resolved = await effectiveModels.resolveEffectiveModels(
        { uid: ctx.uid, schoolId: ctx.schoolId, role: ctx.role, accountType: ctx.accountType },
        { basis: access.basis }
      );
      // Safe aggregate diagnostics (counts + coarse enums only — never UID,
      // school ID, model IDs, keys, or tokens). Excluded-model reason
      // counts keep assignment bugs distinguishable from certification.
      try {
        const assigned = typeof resolved.assignedCount === "number" ? resolved.assignedCount : -1;
        const stale = Array.isArray(resolved.staleModelKeys) ? resolved.staleModelKeys.length : 0;
        const disabled = Array.isArray(resolved.disabledModelKeys) ? resolved.disabledModelKeys.length : 0;
        logInfo("managed-models", {
          source: modelPolicies.toSafePolicySource(resolved.mode),
          role: String(ctx.role || "").slice(0, 16),
          assigned,
          eligible: Array.isArray(resolved.models) ? resolved.models.length : -1,
          returned: Array.isArray(resolved.models) ? resolved.models.length : -1,
          refresh: "fresh",
          disabled,
          removed: stale,
          notRegistered: stale,
        });
      } catch (_) {
        // Observability must never affect the response.
      }
      return res.json({
        allowed: true,
        source: modelPolicies.toSafePolicySource(resolved.mode),
        quotaMode,
        models: resolved.models,
      });
    } catch (_) {
      return res.status(500).json({ error: { code: "INTERNAL" } });
    }
  });

  return r;
}

module.exports = { managedModelsRouter: router };
