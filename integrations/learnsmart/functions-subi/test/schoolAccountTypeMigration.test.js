// test/schoolAccountTypeMigration.test.js — legacy school backfill classification.
// Guards: missing/blank -> candidate; "school" -> no-op; explicit
// non-empty other values -> conflict (never overwritten). No Firestore I/O.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifySchoolDoc,
  summarizeSchoolDocs,
} = require("../src/services/schoolAccountTypeMigration");

test("missing/null/blank accountType is a backfill candidate", () => {
  assert.equal(classifySchoolDoc({}), "update_to_school");
  assert.equal(classifySchoolDoc({ accountType: null }), "update_to_school");
  assert.equal(classifySchoolDoc({ accountType: "" }), "update_to_school");
  assert.equal(classifySchoolDoc({ accountType: "   " }), "update_to_school");
  assert.equal(classifySchoolDoc(null), "update_to_school");
});

test("already school is a no-op (case-insensitive)", () => {
  assert.equal(classifySchoolDoc({ accountType: "school" }), "already_correct");
  assert.equal(classifySchoolDoc({ accountType: "School" }), "already_correct");
  assert.equal(classifySchoolDoc({ accountType: " SCHOOL " }), "already_correct");
});

test("explicit non-empty values are conflicts, never candidates", () => {
  assert.equal(classifySchoolDoc({ accountType: "individual" }), "conflict");
  assert.equal(classifySchoolDoc({ accountType: "schools" }), "conflict");
  assert.equal(classifySchoolDoc({ accountType: "org" }), "conflict");
  assert.equal(classifySchoolDoc({ accountType: 42 }), "conflict");
});

test("summary counts total/already/missing/conflicts and caps id lists", () => {
  const docs = [
    { id: "a", data: { accountType: "school" } },
    { id: "b", data: {} },
    { id: "c", data: { accountType: null } },
    { id: "d", data: { accountType: "individual" } },
  ];
  const out = summarizeSchoolDocs(docs, 1);
  assert.equal(out.total, 4);
  assert.equal(out.alreadyCorrect, 1);
  assert.equal(out.missing, 2);
  assert.equal(out.conflicts, 1);
  assert.equal(out.wouldUpdate, 2);
  assert.deepEqual(out.updateIds, ["b"]);
  assert.deepEqual(out.conflictIds, ["d"]);
  assert.equal(out.truncated, true);
});

test("summary handles empty input", () => {
  const out = summarizeSchoolDocs([]);
  assert.equal(out.total, 0);
  assert.equal(out.wouldUpdate, 0);
  assert.equal(out.truncated, false);
});

test('legacy individual workspace namespaces can never be auto-migrated into schools', () => {
  assert.equal(classifySchoolDoc({}, 'individual_user'), 'conflict');
  const out = summarizeSchoolDocs([{ id: 'individual_user', data: {} }]);
  assert.equal(out.wouldUpdate, 0);
  assert.equal(out.conflicts, 1);
});
