// functions-subi/src/routes/adminUsers.js
// Superadmin individual-user search + user-policy management (Phase 3B).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// Directory reads come from learnsmartDirectoryService (READ ONLY);
// policy reads/writes go to subiDb via accessService. Effective access is
// computed with the authoritative evaluateBatch()/evaluateEffective() core.

const express = require("express");
const accessService = require("../services/accessService");
const {
  getManagedUserByUid,
  getSchool,
  searchManagedUsers,
} = require("../services/learnsmartDirectoryService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

const ACCESS_MODES = new Set(["inherit", "enabled", "disabled"]);

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("subi_user_access.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function cleanUid(value) {
  return String(value || "").trim().slice(0, 128);
}

async function enrichRows(rows) {
  if (!rows.length) return [];
  const enriched = await accessService.evaluateBatch(
    rows.map((r) => ({ uid: r.uid, schoolId: r.schoolId, role: r.role }))
  );
  const byUid = new Map(enriched.map((e) => [e.uid, e]));
  const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter(Boolean))];
  const names = {};
  await Promise.all(
    schoolIds.map(async (id) => {
      try {
        const s = await getSchool(id);
        if (s) names[id] = s.name;
      } catch (_) {
        // display-only enrichment; ignore failures
      }
    })
  );
  return rows.map((r) => {
    const e = byUid.get(r.uid) || {};
    const out = {
      uid: r.uid,
      displayName: r.displayName,
      role: r.role,
      accountType: r.accountType,
      schoolId: r.schoolId,
      email: r.email || undefined,
      studentId: r.studentId || undefined,
      teacherId: r.teacherId || undefined,
      schoolDefaultEnabled: e.schoolDefaultEnabled === true,
      individualAccessMode: e.individualAccessMode || "inherit",
      effectiveAllowed: e.effectiveAllowed === true,
      effectiveBasis: e.effectiveBasis || "policy_invalid",
    };
    if (names[r.schoolId]) out.schoolName = names[r.schoolId];
    if (out.effectiveBasis === "policy_invalid") out.policyNeedsAttention = true;
    return out;
  });
}

function router() {
  const r = express.Router();

  r.get("/admin/subi-users", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const { users, nextCursor } = await searchManagedUsers({
        q: req.query.q,
        role: req.query.role,
        accountType: req.query.accountType,
        schoolId: req.query.schoolId,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      const rows = await enrichRows(users);
      return res.json({ users: rows, nextCursor });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.get("/admin/users/:uid/subi-access", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const uid = cleanUid(req.params.uid);
    if (!uid) return sendError(res, "INVALID_REQUEST", adminUid);
    try {
      const user = await getManagedUserByUid(uid);
      if (!user || user.accountType !== "individual") return sendError(res, "INVALID_REQUEST", adminUid);
      const [policy, enriched] = await Promise.all([
        accessService.getUserAccess(uid),
        enrichRows([user]),
      ]);
      const e = enriched[0];
      return res.json({
        uid: user.uid,
        displayName: user.displayName,
        role: user.role,
        accountType: user.accountType,
        schoolId: user.schoolId,
        ...(e.schoolName ? { schoolName: e.schoolName } : {}),
        schoolDefaultEnabled: e.schoolDefaultEnabled,
        accessMode: policy.accessMode,
        effectiveAllowed: e.effectiveAllowed,
        effectiveBasis: e.effectiveBasis,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.post("/admin/users/:uid/subi-access", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const uid = cleanUid(req.params.uid);
    const body = req.body;
    if (
      !uid ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !ACCESS_MODES.has(String(body.accessMode || "").trim().toLowerCase())
    ) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      // Trusted target: re-resolved from directory; body identity ignored.
      const user = await getManagedUserByUid(uid);
      if (!user || user.accountType !== "individual") return sendError(res, "INVALID_REQUEST", adminUid);
      const out = await accessService.setUserAccess({
        uid: user.uid,
        accessMode: String(body.accessMode).trim().toLowerCase(),
        adminUid,
        trustedUser: { schoolId: user.schoolId, role: user.role, accountType: user.accountType },
      });
      logEvent(`user_access.${out.accessMode}`, { adminUid, status: 200 });
      const enriched = await enrichRows([user]);
      const e = enriched[0];
      return res.json({
        ok: true,
        uid: user.uid,
        accessMode: out.accessMode,
        effectiveAllowed: e.effectiveAllowed,
        effectiveBasis: e.effectiveBasis,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { adminUsersRouter: router };
