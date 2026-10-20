// functions-subi/src/routes/adminReadiness.js
// Superadmin model-policy cutover readiness check (read-only).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// Single GET endpoint; no POST, no mutation, no audit writes (read-only
// check). Delegates entirely to modelPolicyReadinessService.

const express = require("express");
const readiness = require("../services/modelPolicyReadinessService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function router() {
  const r = express.Router();

  r.get("/admin/model-policy-readiness", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      return res.json(await readiness.runReadiness());
    } catch (err) {
      const c = safeCode((err && err.code) || "INTERNAL");
      logEvent("model_policy_readiness.error", { adminUid, code: c, status: statusFor(c) });
      return res.status(statusFor(c)).json(errorBody(c));
    }
  });

  return r;
}

module.exports = { adminReadinessRouter: router };
