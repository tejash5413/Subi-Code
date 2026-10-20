// test/directoryReadiness.test.js — read-only user readiness checks.
// Verifies READY vs MISSING_ACCOUNT_TYPE/INVALID_ROLE/INACTIVE/
// MISSING_SCHOOL/SCHOOL_ID_NOT_FOUND without touching production auth.
const test = require("node:test");
const assert = require("node:assert/strict");

const { checkUserReadiness } = require("../src/services/directoryReadinessService");

test("ready school user with existing school doc", () => {
  assert.equal(
    checkUserReadiness({ status: "active", role: "student", accountType: "school", schoolId: "s1" }, true),
    "READY"
  );
  assert.equal(
    checkUserReadiness({ status: "Active", role: "Teacher", accountType: "School", schoolId: "s1" }, true),
    "READY"
  );
});

test("ready individual user needs no school", () => {
  assert.equal(
    checkUserReadiness({ status: "active", role: "student", accountType: "individual" }, null),
    "READY"
  );
});

test("inactive wins over everything else", () => {
  assert.equal(checkUserReadiness({ status: "suspended", role: "student", accountType: "school", schoolId: "s1" }, true), "INACTIVE");
  assert.equal(checkUserReadiness({}, null), "INACTIVE");
});

test("non-managed roles are invalid", () => {
  assert.equal(checkUserReadiness({ status: "active", role: "admin", accountType: "school", schoolId: "s1" }, true), "INVALID_ROLE");
  assert.equal(checkUserReadiness({ status: "active", role: "", accountType: "individual" }, null), "INVALID_ROLE");
});

test("missing/unknown accountType is reported, never inferred", () => {
  assert.equal(checkUserReadiness({ status: "active", role: "student" }, null), "MISSING_ACCOUNT_TYPE");
  assert.equal(checkUserReadiness({ status: "active", role: "student", accountType: "" }, null), "MISSING_ACCOUNT_TYPE");
  assert.equal(checkUserReadiness({ status: "active", role: "student", accountType: "org" }, null), "MISSING_ACCOUNT_TYPE");
});

test("school accounts require a resolvable schoolId", () => {
  assert.equal(checkUserReadiness({ status: "active", role: "student", accountType: "school", schoolId: "" }, true), "MISSING_SCHOOL");
  assert.equal(checkUserReadiness({ status: "active", role: "student", accountType: "school", schoolId: "s9" }, false), "SCHOOL_ID_NOT_FOUND");
  assert.equal(checkUserReadiness({ status: "active", role: "student", accountType: "school", schoolId: "s9" }, null), "SCHOOL_ID_NOT_FOUND");
});
