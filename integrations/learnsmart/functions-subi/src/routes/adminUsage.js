// Superadmin token-usage reporting. Identity/account scope always comes from
// the trusted LearnSmart directory; counters come only from subiDb.

const express = require("express");
const usage = require("../services/usageService");
const limits = require("../services/monthlyLimitService");
const {
  getManagedUserByUid,
  getSchool,
  searchManagedUsers,
} = require("../services/learnsmartDirectoryService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("usage.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function cleanId(value) {
  return String(value || "").trim().slice(0, 128);
}

function pctOf(used, limit) {
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) return null;
  return Math.min(1, used / limit);
}

async function buildUserRows(users, month) {
  const counters = await Promise.all(
    users.map((user) => usage.getUserUsage({ uid: user.uid, schoolId: user.schoolId, month }))
  );
  const limitRows = await limits.resolveEffectiveMonthlyLimitsBatch(
    users.map((user) => ({
      uid: user.uid,
      schoolId: user.schoolId,
      role: user.role,
      accountType: user.accountType,
    }))
  );
  const byUid = new Map(limitRows.map((row) => [row.uid, row]));
  return users.map((user, index) => {
    const use = counters[index];
    const lim = byUid.get(user.uid) || {};
    const used = use.inputTokens + use.outputTokens + (use.conservativeChargedTokens || 0);
    return {
      uid: user.uid,
      displayName: user.displayName,
      role: user.role,
      accountType: user.accountType,
      schoolId: user.schoolId,
      email: user.email || undefined,
      month: use.month,
      inputTokens: use.inputTokens,
      outputTokens: use.outputTokens,
      conservativeChargedTokens: use.conservativeChargedTokens || 0,
      requests: use.requests,
      byModel: use.byModel,
      limit: lim.configured ? lim.monthlyTokenLimit : null,
      limitSource: lim.source || "not_configured",
      pct: lim.configured ? pctOf(used, lim.monthlyTokenLimit) : null,
    };
  });
}

function aggregateIndividual(rows, month, complete) {
  const out = {
    accountType: "individual",
    month,
    inputTokens: 0,
    outputTokens: 0,
    conservativeChargedTokens: 0,
    requests: 0,
    byRole: {
      student: { inputTokens: 0, outputTokens: 0, conservativeChargedTokens: 0, requests: 0 },
      teacher: { inputTokens: 0, outputTokens: 0, conservativeChargedTokens: 0, requests: 0 },
    },
    byModel: {},
    usersCounted: rows.length,
    complete,
  };
  for (const row of rows) {
    out.inputTokens += row.inputTokens;
    out.outputTokens += row.outputTokens;
    out.conservativeChargedTokens += row.conservativeChargedTokens || 0;
    out.requests += row.requests;
    const role = row.role === "teacher" ? "teacher" : "student";
    out.byRole[role].inputTokens += row.inputTokens;
    out.byRole[role].outputTokens += row.outputTokens;
    out.byRole[role].conservativeChargedTokens += row.conservativeChargedTokens || 0;
    out.byRole[role].requests += row.requests;
    for (const [key, value] of Object.entries(row.byModel || {})) {
      const prev = out.byModel[key] || { inputTokens: 0, outputTokens: 0, requests: 0 };
      out.byModel[key] = {
        inputTokens: prev.inputTokens + (value.inputTokens || 0),
        outputTokens: prev.outputTokens + (value.outputTokens || 0),
        requests: prev.requests + (value.requests || 0),
      };
    }
  }
  return out;
}

async function listTrustedUsers(query) {
  const out = await searchManagedUsers(query);
  return { users: out.users || [], nextCursor: out.nextCursor || null };
}

function router() {
  const r = express.Router();

  r.get("/admin/usage/schools/:schoolId", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const schoolId = cleanId(req.params.schoolId);
      const school = await getSchool(schoolId);
      if (!school || school.accountType !== "school") return sendError(res, "INVALID_REQUEST", adminUid);
      const month = req.query.month !== undefined ? String(req.query.month) : undefined;
      const [use, lim] = await Promise.all([
        usage.getSchoolUsage({ schoolId, month }),
        limits.getSchoolLimits(schoolId).catch(() => null),
      ]);
      return res.json({
        schoolId,
        schoolName: school.name,
        accountType: "school",
        month: use.month,
        usage: use,
        limits: lim
          ? { configured: lim.configured, studentMonthlyTokens: lim.studentMonthlyTokens, teacherMonthlyTokens: lim.teacherMonthlyTokens }
          : { configured: false, studentMonthlyTokens: null, teacherMonthlyTokens: null },
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.get("/admin/usage/schools/:schoolId/users", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const schoolId = cleanId(req.params.schoolId);
      const school = await getSchool(schoolId);
      if (!school || school.accountType !== "school") return sendError(res, "INVALID_REQUEST", adminUid);
      const month = req.query.month !== undefined ? String(req.query.month) : undefined;
      const out = await listTrustedUsers({
        q: req.query.q, role: req.query.role, accountType: "school", schoolId,
        limit: req.query.limit, cursor: req.query.cursor,
      });
      const rows = await buildUserRows(out.users, month);
      return res.json({ schoolId, accountType: "school", month: rows[0]?.month || month, users: rows, nextCursor: out.nextCursor });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.get("/admin/usage/individuals", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const month = req.query.month !== undefined ? String(req.query.month) : undefined;
      const users = [];
      let cursor;
      let pages = 0;
      do {
        const out = await listTrustedUsers({ accountType: "individual", role: "all", limit: 50, cursor });
        users.push(...out.users);
        cursor = out.nextCursor || null;
        pages += 1;
      } while (cursor && pages < 4);
      const rows = await buildUserRows(users, month);
      const resolvedMonth = rows[0]?.month || month || usage.currentMonthIST();
      return res.json({ accountType: "individual", month: resolvedMonth, usage: aggregateIndividual(rows, resolvedMonth, !cursor) });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.get("/admin/usage/individuals/users", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    try {
      const month = req.query.month !== undefined ? String(req.query.month) : undefined;
      const out = await listTrustedUsers({
        q: req.query.q, role: req.query.role, accountType: "individual",
        limit: req.query.limit, cursor: req.query.cursor,
      });
      const rows = await buildUserRows(out.users, month);
      return res.json({ accountType: "individual", month: rows[0]?.month || month, users: rows, nextCursor: out.nextCursor });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.get("/admin/users/:uid/usage", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const uid = cleanId(req.params.uid);
    if (!uid) return sendError(res, "INVALID_REQUEST", adminUid);
    try {
      const user = await getManagedUserByUid(uid);
      if (!user) return sendError(res, "INVALID_REQUEST", adminUid);
      const month = req.query.month !== undefined ? String(req.query.month) : undefined;
      const [use, lim] = await Promise.all([
        usage.getUserUsage({ uid: user.uid, schoolId: user.schoolId, month }),
        limits.resolveEffectiveMonthlyLimit({
          uid: user.uid,
          schoolId: user.schoolId,
          role: user.role,
          accountType: user.accountType,
        }),
      ]);
      const used = use.inputTokens + use.outputTokens + (use.conservativeChargedTokens || 0);
      let schoolName;
      try { const school = await getSchool(user.schoolId); if (school) schoolName = school.name; } catch (_) {}
      return res.json({
        uid: user.uid, displayName: user.displayName, role: user.role, accountType: user.accountType,
        schoolId: user.schoolId, ...(schoolName ? { schoolName } : {}), month: use.month, usage: use,
        limit: lim.configured ? lim.monthlyTokenLimit : null,
        limitSource: lim.source || "not_configured",
        pct: lim.configured ? pctOf(used, lim.monthlyTokenLimit) : null,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { adminUsageRouter: router };
