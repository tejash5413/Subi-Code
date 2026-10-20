// functions-subi/src/routes/adminManagedChatConfig.js
// Superadmin managed-chat operational gate (Phase 9A.1, local only).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// Separate from Global SUBI Access: this controls whether the managed
// inference runtime is operational, not who may use SUBI.
//
// BOUNDARY: config data only (mode + test UIDs). No secrets, no OpenRouter,
// no prompt/completion content. Browser never touches Firestore directly.

const express = require("express");
const chatConfig = require("../services/managedChatConfigService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

const ALLOWED_BODY_FIELDS = new Set(["mode", "testUids"]);

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("managed_chat_config.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function router() {
  const r = express.Router();

  r.get("/admin/managed-chat-config", async (req, res) => {
    try {
      const out = await chatConfig.getManagedChatConfig();
      return res.json({
        mode: out.mode,
        testUids: out.testUids,
        updatedAt: out.updatedAt,
        updatedBy: out.updatedBy,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  r.post("/admin/managed-chat-config", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    // Exact-shape validation: server stamps updatedAt/updatedBy itself;
    // client-supplied timestamps, schema versions, or unknown fields are
    // rejected, never trusted.
    for (const key of Object.keys(body)) {
      if (!ALLOWED_BODY_FIELDS.has(key)) return sendError(res, "INVALID_REQUEST", adminUid);
    }
    if (typeof body.mode !== "string") return sendError(res, "INVALID_REQUEST", adminUid);
    try {
      const out = await chatConfig.setManagedChatConfig({
        mode: body.mode,
        testUids: body.testUids,
        adminUid,
      });
      logEvent("managed_chat_config.updated", { adminUid, status: 200 });
      return res.json({ ok: true, ...out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { adminManagedChatConfigRouter: router };
