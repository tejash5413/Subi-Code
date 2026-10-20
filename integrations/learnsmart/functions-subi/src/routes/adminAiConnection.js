// functions-subi/src/routes/adminAiConnection.js
// Superadmin AI-connection management (Phase 2A).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// Bodies are validated strictly; responses and logs carry safe codes only.

const express = require("express");
const aiConnection = require("../services/aiConnectionService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("ai_connection.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function extractApiKey(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (typeof body.apiKey !== "string") return null;
  return body.apiKey;
}

function router() {
  const r = express.Router();

  r.get("/admin/ai-connection", async (req, res) => {
    try {
      const status = await aiConnection.getStatus();
      return res.json(status);
    } catch (_) {
      return sendError(res, "INTERNAL", req.subi && req.subi.uid);
    }
  });

  async function handleWrite(req, res, op) {
    const adminUid = req.subi && req.subi.uid;
    const apiKey = op === "remove" || op === "rollback" ? null : extractApiKey(req.body);
    if ((op === "configure" || op === "replace") && apiKey === null) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      if (op === "configure") {
        const out = await aiConnection.configure(apiKey, adminUid);
        logEvent("ai_connection.configured", { adminUid, status: 200, version: out.version });
        return res.json({ ok: true });
      }
      if (op === "replace") {
        const out = await aiConnection.replace(apiKey, adminUid);
        logEvent("ai_connection.replaced", { adminUid, status: 200, version: out.version });
        return res.json({ ok: true });
      }
      if (op === "rollback") {
        await aiConnection.rollback(adminUid);
        logEvent("ai_connection.rollback", { adminUid, status: 200 });
        return res.json({ ok: true });
      }
      await aiConnection.remove(adminUid);
      logEvent("ai_connection.removed", { adminUid, status: 200 });
      return res.json({ ok: true });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  }

  r.post("/admin/ai-connection/configure", (req, res) => handleWrite(req, res, "configure"));
  r.post("/admin/ai-connection/replace", (req, res) => handleWrite(req, res, "replace"));
  r.post("/admin/ai-connection/rollback", (req, res) => handleWrite(req, res, "rollback"));
  r.delete("/admin/ai-connection", (req, res) => handleWrite(req, res, "remove"));

  return r;
}

module.exports = { adminAiConnectionRouter: router };
