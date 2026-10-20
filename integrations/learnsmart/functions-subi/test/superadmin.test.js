// test/superadmin.test.js — superadmin gate must match the real LearnSmart
// role convention: frontend maps bare "admin" → superadmin and default
// Firestore rules treat "admin" as superadmin-like.
const test = require("node:test");
const assert = require("node:assert/strict");

const { isSuperAdminRole, requireSuperAdmin } = require("../src/middleware/superadmin");

test("accepts superadmin variants and bare admin", () => {
  for (const r of ["superadmin", "SuperAdmin", "super_admin", "super-admin", "super admin", "Super Admin", "admin", "Admin", "  admin  "]) {
    assert.equal(isSuperAdminRole(r), true, r);
  }
});

test("rejects all other roles", () => {
  for (const r of ["schooladmin", "school", "accountant", "teacher", "student", "", null, undefined]) {
    assert.equal(isSuperAdminRole(r), false, String(r));
  }
});

test("middleware allows admin role, denies others", () => {
  const allow = { subi: { uid: "u1", role: "admin" } };
  let nexted = false;
  requireSuperAdmin(allow, {}, () => {
    nexted = true;
  });
  assert.equal(nexted, true);

  const deny = { subi: { uid: "u1", role: "teacher" } };
  let status = 0;
  requireSuperAdmin(deny, { status: (s) => ({ json: () => { status = s; } }) }, () => {});
  assert.equal(status, 403);
});
