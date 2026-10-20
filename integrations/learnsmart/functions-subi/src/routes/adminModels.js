// functions-subi/src/routes/adminModels.js
// Superadmin approved-model administration (Phase 4).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// Policy data only — no secret, network, or provider access here.

const express = require("express");
const models = require("../services/approvedModelService");
const { probeModelCompatibility } = require("../services/modelCompatibilityProbe");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("approved_model.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function router() {
  const r = express.Router();

  r.get("/admin/approved-models", async (req, res) => {
    try {
      return res.json({ models: await models.listApprovedModelsAdmin() });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  r.post("/admin/approved-models/approve", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const out = await models.approveModel(req.body, adminUid);
      logEvent("model.approved", { adminUid, status: 200 });
      return res.json({ ok: true, model: out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.post("/admin/approved-models/:modelKey", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const out = await models.updateApprovedModel(req.params.modelKey, req.body, adminUid);
      logEvent("model.updated", { adminUid, status: 200 });
      return res.json({ ok: true, model: out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  // Certification backfill report: live counts + per-model queue.
  // Read-only; safe for Super Admin planning (no provider calls).
  r.get("/admin/models/certification-status", async (req, res) => {
    try {
      return res.json(await models.listUncertifiedModels());
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  // Controlled compatibility probe (admin-triggered, bounded provider use).
  // Runs the tool/terminal/verify workflow checks and returns outcomes ONLY.
  // Never persists marks — use the certify endpoint for explicit persist.
  r.post("/admin/models/:modelKey/probe", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const body = (req.body && typeof req.body === "object") ? req.body : {};
      const out = await probeModelCompatibility({ modelKey: req.params.modelKey, kinds: body.kinds });
      logEvent("model.probed", { adminUid, status: 200 });
      return res.json({ ok: true, probe: out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  // Explicit certification persist (admin decision after probe evidence).
  // Sets ONLY agentTerminal/agentVerify; enabled/pricing/modalities untouched.
  r.post("/admin/models/:modelKey/certify", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const body = (req.body && typeof req.body === "object") ? req.body : {};
      const out = await models.setModelCertification(
        req.params.modelKey,
        { agentTerminal: body.agentTerminal, agentVerify: body.agentVerify },
        adminUid
      );
      logEvent("model.certified", { adminUid, status: 200 });
      return res.json({ ok: true, model: out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INVALID_REQUEST", adminUid);
    }
  });

  // Usage impact for the Remove confirm (read-only, bounded counts).
  r.get("/admin/approved-models/:modelKey/usage", async (req, res) => {
    try {
      return res.json(await models.getModelUsageCounts(req.params.modelKey));
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  // Permanent remove (warn-but-allow: assignments become stale warnings).
  r.delete("/admin/approved-models/:modelKey", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const out = await models.removeApprovedModel(req.params.modelKey, adminUid);
      logEvent("model.removed", { adminUid, status: 200 });
      return res.json(out);
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { adminModelsRouter: router };
