// functions-subi/src/routes/managedCatalog.js
// Superadmin-only model catalogue on subiManagedApi (Phase 4).
// Runs as subi-managed-runtime (secretAccessor) — admin runtime gains no
// secret permission. Mounted with requireAuth() + requireSuperAdmin (NOT
// managedOnly): superadmins are not student/teacher users.

const express = require("express");
const catalog = require("../services/modelCatalogService");
const approvedModels = require("../services/approvedModelService");
const autoEligible = require("../services/autoEligibleModelService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("model_catalog.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function router() {
  const r = express.Router();

  r.get("/admin/model-catalog", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const out = await catalog.fetchCatalog();
      logEvent("model_catalog.loaded", { adminUid, status: 200 });
      return res.json({ models: out.models, cached: out.cached === true });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  // Auto-register Free + Cheap (Out <=$0.5/1M) models into the Registry.
  // Free = In $0 AND Out $0. Cheap-auto = Out <= $0.5/1M inclusive (so $0.50
  // qualifies, $0.60 does not). Missing/invalid pricing never qualifies.
  // Creates missing mdl_* records Enabled + UNCERTIFIED (no terminal/verify
  // marks): OpenRouter metadata proves basic toolCalling eligibility only,
  // never SUBI terminal/verification compatibility. New records join the
  // certification backfill queue instead of falsely carrying verified marks.
  // Reuses existing records untouched (marks preserved). Does NOT mutate
  // school/individual policies: serving is via the auto-eligible baseline
  // in modelPolicyService.resolveManagedModels, so both school and
  // individual users receive these models without manual assignment.
  // Disabled records stay disabled (admin opt-out wins).
  r.post("/admin/models/auto-register", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const fetched = await catalog.fetchCatalog({ refresh: true });
      const live = Array.isArray(fetched.models) ? fetched.models : [];
      const eligible = autoEligible.filterAutoEligible(live);
      if (eligible.length === 0) {
        return res.json({ ok: true, eligible: 0, created: [], reused: [], autoKeys: [] });
      }
      const existing = await approvedModels.resolveExistingUpstreamKeys(
        eligible.map((m) => m.upstreamModelId)
      );
      const missing = eligible.filter((m) => !existing.has(m.upstreamModelId));
      const selections = autoEligible.buildAutoSelections(missing);
      let created = [];
      let reused = [];
      if (selections.length > 0) {
        // A whole provider catalogue can exceed the assignment helper's
        // validated per-call bound. Preserve that bound and register chunks
        // sequentially; upstream mapping makes retries idempotent.
        for (let offset = 0; offset < selections.length; offset += approvedModels.MAX_ENSURE_ITEMS) {
          const ensured = await approvedModels.ensureCatalogueModels(
            selections.slice(offset, offset + approvedModels.MAX_ENSURE_ITEMS), { catalog: live, adminUid });
          created.push(...(ensured.created || []));
          reused.push(...(ensured.reused || []));
        }
      } else {
        reused = [...existing.values()];
      }
      const allKeys = [...created, ...reused, ...[...existing.values()].filter((k) => !reused.includes(k))];
      const uniqueKeys = [...new Set(allKeys)];
      // No certification here: auto-registered records must NOT gain
      // verified terminal/verify marks without an actual probe. New records
      // land uncertified in the backfill queue; use the model certification
      // workflow (probe + explicit certify) to mark them.
      logEvent("model.auto_registered", { adminUid, status: 200 });
      return res.json({
        ok: true,
        eligible: eligible.length,
        created,
        reused,
        autoKeys: uniqueKeys,
        reenabledModelKeys: [],
        verifiedModelKeys: [],
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { managedCatalogRouter: router };
