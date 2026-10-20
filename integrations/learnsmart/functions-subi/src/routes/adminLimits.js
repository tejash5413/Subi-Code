// functions-subi/src/routes/adminLimits.js
// Superadmin per-user monthly token-limit administration (Phase 5).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// Firestore policy only — no secret, network, or provider access.
// School existence validated read-only via learnsmartDirectoryService;
// writes go to subiDb via monthlyLimitService only.

const express = require("express");
const limits = require("../services/monthlyLimitService");
const {
  getManagedUserByUid,
  getSchool,
} = require("../services/learnsmartDirectoryService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("monthly_limit.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function cleanSchoolId(value) {
  return String(value || "").trim().slice(0, 128);
}

function cleanUid(value) {
  return String(value || "").trim().slice(0, 128);
}

function router() {
  const r = express.Router();

  r.get("/admin/schools/:schoolId/monthly-limits", async (req, res) => {
    try {
      // Read-only: never creates policy on GET.
      const schoolId = cleanSchoolId(req.params.schoolId);
      const school = await getSchool(schoolId);
      if (!school || school.accountType !== "school") return sendError(res, "INVALID_REQUEST", req.subi && req.subi.uid);
      return res.json(await limits.getSchoolLimits(schoolId));
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  r.post("/admin/schools/:schoolId/monthly-limits", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const schoolId = cleanSchoolId(req.params.schoolId);
    const body = req.body;
    if (
      !schoolId ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.studentMonthlyTokens !== "number" ||
      typeof body.teacherMonthlyTokens !== "number"
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
      const out = await limits.setSchoolLimits({
        schoolId,
        studentMonthlyTokens: body.studentMonthlyTokens,
        teacherMonthlyTokens: body.teacherMonthlyTokens,
        adminUid,
      });
      logEvent("school_monthly_limit.updated", { adminUid, status: 200 });
      return res.json({ ok: true, ...out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.get("/admin/users/:uid/monthly-limit", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const uid = cleanUid(req.params.uid);
    if (!uid) return sendError(res, "INVALID_REQUEST", adminUid);
    try {
      const user = await getManagedUserByUid(uid);
      if (!user || user.accountType !== "individual") return sendError(res, "INVALID_REQUEST", adminUid);
      const [policy, school, effective] = await Promise.all([
        limits.getUserLimit(user.uid),
        limits.getSchoolLimits(user.schoolId),
        limits.resolveEffectiveMonthlyLimit({
          uid: user.uid,
          schoolId: user.schoolId,
          role: user.role,
          accountType: user.accountType,
        }),
      ]);
      let schoolName;
      try {
        const s = await getSchool(user.schoolId);
        if (s) schoolName = s.name;
      } catch (_) {
        // display-only enrichment; ignore failures
      }
      const roleDefault =
        user.role === "student" ? school.studentMonthlyTokens : school.teacherMonthlyTokens;
      return res.json({
        uid: user.uid,
        displayName: user.displayName,
        role: user.role,
        schoolId: user.schoolId,
        ...(schoolName ? { schoolName } : {}),
        schoolMonthlyDefault: roleDefault,
        monthlyTokenMode: policy.monthlyTokenMode,
        customMonthlyTokens: policy.monthlyTokens,
        effectiveMonthlyTokens: effective.monthlyTokenLimit,
        configured: effective.configured,
        source: effective.source,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.post("/admin/users/:uid/monthly-limit", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const uid = cleanUid(req.params.uid);
    const body = req.body;
    const mode = String((body && body.monthlyTokenMode) || "").trim().toLowerCase();
    if (!uid || !body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    if (mode !== "inherit" && mode !== "custom") {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    if (mode === "custom" && typeof body.monthlyTokens !== "number") {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      // Trusted target: re-resolved from directory; body identity ignored.
      const user = await getManagedUserByUid(uid);
      if (!user || user.accountType !== "individual") return sendError(res, "INVALID_REQUEST", adminUid);
      const out = await limits.setUserLimit({
        uid: user.uid,
        monthlyTokenMode: mode,
        monthlyTokens: mode === "custom" ? body.monthlyTokens : null,
        adminUid,
        trustedUser: { schoolId: user.schoolId, role: user.role, accountType: user.accountType },
      });
      logEvent(
        mode === "custom" ? "user_monthly_limit.custom" : "user_monthly_limit.inherit",
        { adminUid, status: 200 }
      );
      const effective = await limits.resolveEffectiveMonthlyLimit({
        uid: user.uid,
        schoolId: user.schoolId,
        role: user.role,
        accountType: user.accountType,
      });
      return res.json({
        ok: true,
        uid: user.uid,
        monthlyTokenMode: out.monthlyTokenMode,
        customMonthlyTokens: out.monthlyTokens,
        effectiveMonthlyTokens: effective.monthlyTokenLimit,
        configured: effective.configured,
        source: effective.source,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { adminLimitsRouter: router };
