// functions-subi/src/middleware/auth.js
// Fresh SUBI authentication middleware (Phase 1A).
// Built from scratch for the managed APIs; shares no logic with the legacy
// chatHandler/apiV2 stack. No App Check / reCAPTCHA requirement: the VS Code
// extension is not the browser client.
//
// Flow: Authorization: Bearer <Firebase ID token> -> verifyIdToken ->
// trusted profile from (default) users/{uid} -> attach req.subi.

const { admin } = require("../db");
const { getUserProfile, getSchool } = require("../services/learnsmartDirectoryService");
const { isSuperAdminRole } = require('./superadmin');

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// Roles permitted on future managed (student/teacher runtime) endpoints.
const MANAGED_ROLES = new Set(["student", "teacher"]);

function requireAuth({ managedOnly = false } = {}) {
  return async (req, res, next) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      }

      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(token, true);
      } catch (_) {
        return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      }

      // Never trust uid/role/schoolId from the request body. The uid comes
      // from the verified token; everything else from the trusted directory.
      const profile = await getUserProfile(decoded.uid);
      if (!profile) {
        return res.status(403).json({ error: { code: 'FORBIDDEN' } });
      }
      const legacySuperAdmin = !managedOnly && isSuperAdminRole(profile.role) && profile.statusConfigured === false;
      if (profile.status !== "active" && !legacySuperAdmin) {
        return res.status(403).json({ error: { code: 'FORBIDDEN' } });
      }

      if (managedOnly && !MANAGED_ROLES.has(profile.role)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN' } });
      }
      // Every managed route shares this guard, including search and the
      // legacy chat transport. Unknown directory types must never reach
      // school-policy compatibility fallbacks in downstream services.
      if (managedOnly && profile.accountType !== "school" && profile.accountType !== "individual") {
        return res.status(403).json({ error: { code: "ACCOUNT_TYPE_UNSUPPORTED" } });
      }
      if (managedOnly && profile.accountType === 'school') {
        const school = profile.schoolId ? await getSchool(profile.schoolId) : null;
        if (!school || school.accountType !== 'school') {
          return res.status(403).json({ error: { code: 'FORBIDDEN' } });
        }
      }

      req.subi = {
        uid: decoded.uid,
        role: profile.role,
        accountType: profile.accountType,
        schoolId: profile.schoolId,
        studentId: profile.studentId,
        teacherId: profile.teacherId,
      };
      return next();
    } catch (err) {
      console.error('[subi][auth] code=SUBI_ACCESS_UNAVAILABLE');
      return res.status(503).json({ error: { code: 'SUBI_ACCESS_UNAVAILABLE' } });
    }
  };
}

module.exports = { requireAuth };
