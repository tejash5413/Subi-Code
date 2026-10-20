// functions-subi/src/middleware/superadmin.js
// Independent server-side superadmin authorization (Phase 1A).
// Must run AFTER requireAuth: it never reads role from the request, only
// from req.subi populated via the trusted (default) users/{uid} profile.
//
// Role set mirrors the two existing authorities: the LearnSmart frontend
// maps bare `admin` → `superadmin` (AuthContext normalizeRole), and the
// default Firestore rules treat bare `admin` as superadmin-like
// (roleIsSuperAdmin). Real superadmin accounts use role "admin", so it is
// accepted here. `schooladmin`, `accountant`, `student`, `teacher` stay
// rejected.

function normalizeSuperAdminRole(value) {
  return String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function isSuperAdminRole(role) {
  const normalized = normalizeSuperAdminRole(role);
  return normalized === "super admin" || normalized === "superadmin" || normalized === "admin";
}

function requireSuperAdmin(req, res, next) {
  const role = req.subi && req.subi.role;
  if (!req.subi || !req.subi.uid) {
    return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
  }
  if (!isSuperAdminRole(role)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN' } });
  }
  return next();
}

module.exports = { requireSuperAdmin, isSuperAdminRole };
