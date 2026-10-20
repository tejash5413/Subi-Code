// functions-subi/src/routes/adminManagedAgentConfig.js
// Superadmin managed-agent operational gate (Phase 13, local only).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// BOUNDARY: config data only (mode + test UIDs). No secrets, no OpenRouter,
// no prompt/completion content.

const express = require("express");
const agentConfig = require("../services/managedAgentConfigService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

const ALLOWED_BODY_FIELDS = new Set(["mode", "testUids", "terminalEnabled", "jobsEnabled", "jobsTestUids", "coordinationEnabled"]);

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("managed_agent_config.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function router() {
  const r = express.Router();

  r.get("/admin/managed-agent-config", async (req, res) => {
    try {
      const out = await agentConfig.getManagedAgentConfig();
      return res.json({
        mode: out.mode,
        testUids: out.testUids,
        ...(out.jobsEnabled === true ? { jobsEnabled: true } : {}),
        ...(out.jobsTestUids !== undefined ? { jobsTestUids: out.jobsTestUids } : {}),
        ...(out.coordinationEnabled === true ? { coordinationEnabled: true } : {}),
        ...(out.terminalEnabled === true ? { terminalEnabled: true } : {}),
        updatedAt: out.updatedAt,
        updatedBy: out.updatedBy,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  r.post("/admin/managed-agent-config", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    for (const key of Object.keys(body)) {
      if (!ALLOWED_BODY_FIELDS.has(key)) return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      const out = await agentConfig.setManagedAgentConfig(
        { mode: body.mode, testUids: body.testUids, terminalEnabled: body.terminalEnabled, jobsEnabled: body.jobsEnabled, jobsTestUids: body.jobsTestUids, coordinationEnabled: body.coordinationEnabled, adminUid },
        undefined
      );
      logEvent("managed_agent_config.updated", { adminUid, code: "OK", status: 200 });
      return res.json({
        mode: out.mode,
        testUids: out.testUids,
        ...(out.jobsEnabled === true ? { jobsEnabled: true } : {}),
        ...(out.jobsTestUids !== undefined ? { jobsTestUids: out.jobsTestUids } : {}),
        ...(out.coordinationEnabled === true ? { coordinationEnabled: true } : {}),
        ...(out.terminalEnabled === true ? { terminalEnabled: true } : {}),
        updatedAt: out.updatedAt,
        updatedBy: out.updatedBy,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  return r;
}

module.exports = { adminManagedAgentConfigRouter: router };
