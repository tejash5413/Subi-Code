// functions-subi/src/routes/adminAccess.js
// Superadmin Global + School access management (Phase 3A).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// School existence is validated read-only via learnsmartDirectoryService;
// policy writes go to subiDb only.

const express = require("express");
const accessService = require("../services/accessService");
const { getSchool } = require("../services/learnsmartDirectoryService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("subi_access.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function cleanSchoolId(value) {
  return String(value || "").trim().slice(0, 128);
}

function router() {
  const r = express.Router();

  r.get("/admin/subi-access", async (req, res) => {
    try {
      return res.json(await accessService.getGlobalAccess());
    } catch (_) {
      return sendError(res, "INTERNAL", req.subi && req.subi.uid);
    }
  });

  r.post("/admin/subi-access", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.enabled !== "boolean") {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      const out = await accessService.setGlobalAccess({ enabled: body.enabled, adminUid });
      logEvent(body.enabled ? "subi_access.enabled" : "subi_access.disabled", { adminUid, status: 200 });
      return res.json({ ok: true, enabled: out.enabled });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.get("/admin/schools/:schoolId/subi-access", async (req, res) => {
    try {
      const schoolId = cleanSchoolId(req.params.schoolId);
      const school = await getSchool(schoolId);
      if (!school || school.accountType !== "school") return sendError(res, "INVALID_REQUEST", req.subi && req.subi.uid);
      return res.json(await accessService.getSchoolAccess(schoolId));
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  r.post("/admin/schools/:schoolId/subi-access", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const schoolId = cleanSchoolId(req.params.schoolId);
    const body = req.body;
    if (
      !schoolId ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.studentEnabled !== "boolean" ||
      typeof body.teacherEnabled !== "boolean" ||
      (Object.prototype.hasOwnProperty.call(body, "studentPermissionProfileCeiling") && !["ask", "session", "full"].includes(body.studentPermissionProfileCeiling)) ||
      (Object.prototype.hasOwnProperty.call(body, "teacherPermissionProfileCeiling") && !["ask", "session", "full"].includes(body.teacherPermissionProfileCeiling))
    ) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      const school = await getSchool(schoolId);
      if (!school || school.accountType !== "school") return sendError(res, "INVALID_REQUEST", adminUid);
    } catch (_) {
      return sendError(res, "INTERNAL", adminUid);
    }
    try {
      const out = await accessService.setSchoolAccess({
        schoolId,
        studentEnabled: body.studentEnabled,
        teacherEnabled: body.teacherEnabled,
        studentPermissionProfileCeiling: body.studentPermissionProfileCeiling,
        teacherPermissionProfileCeiling: body.teacherPermissionProfileCeiling,
        adminUid,
      });
      logEvent("school_role_access.changed", { adminUid, status: 200 });
      return res.json({ ok: true, ...out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { adminAccessRouter: router };
