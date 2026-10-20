// test/modelPolicyReadiness.test.js — cutover readiness (read-only, fakes only).
// Asserts GO/NO-GO rules, missing-vs-empty, stale detection, safe shape.
const test = require("node:test");
const assert = require("node:assert/strict");

const readiness = require("../src/services/modelPolicyReadinessService");
const effectiveModels = require("../src/services/effectiveModelService");

function fakeStore() {
  const state = {};
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      return {
        _key: key,
        async get() {
          return { id, exists: key in state, data: () => state[key] };
        },
      };
    },
    limit: (n) => ({
      async get() {
        const docs = Object.entries(state)
          .filter(([k]) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/"))
          .slice(0, n)
          .map(([k, v]) => ({ id: k.slice(prefix.length + 1), data: () => v }));
        return { docs };
      },
    }),
  });
  return { _state: state, collection: (name) => coll(name) };
}

const directory = { getSchool: async (id) => ({ id, name: `School ${id}` }) };
const deps = (store) => ({ store, directory });

function seedApproved(store, key, over = {}) {
  store._state[`approvedModels/${key}`] = {
    schemaVersion: 1,
    modelKey: key,
    displayName: key,
    upstreamModelId: `upstream/${key}`,
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
    contextLength: 128000,
    ...over,
  };
}

function seedAccess(store, schoolId, student = true, teacher = true) {
  store._state[`schoolPolicies/${schoolId}`] = {
    roles: { student: { enabled: student }, teacher: { enabled: teacher } },
  };
}

function seedModelPolicy(store, schoolId, student, teacher) {
  store._state[`schoolModelPolicies/${schoolId}`] = {
    schemaVersion: 1,
    schoolId,
    roles: { student: { modelKeys: student }, teacher: { modelKeys: teacher } },
    updatedAt: new Date(),
  };
}

test("no relevant schools → informational NO_GO after cutover", async () => {
  const s = fakeStore();
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.cutoverEnabled, true);
  assert.equal(out.ready, false);
  assert.equal(out.status, "NO_GO");
  assert.equal(out.summary.relevantSchools, 0);
  assert.ok(out.reasons.some((r) => r.includes("already enabled")));
  assert.ok(out.reasons.some((r) => r.includes("nothing to cut over")));
});

test("relevant school + missing policy → NO_GO", async () => {
  const s = fakeStore();
  seedAccess(s, "s1", true, false);
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.ready, false);
  assert.equal(out.status, "NO_GO");
  assert.equal(out.summary.missingPolicies, 1);
  assert.equal(out.schools[0].policyExists, false);
  assert.equal(out.schools[0].studentState, "missing");
  assert.equal(out.schools[0].ready, false);
});

test("explicit empty policy doc → data valid (overall NO_GO only for cutover state)", async () => {
  const s = fakeStore();
  seedAccess(s, "s1", true, true);
  seedModelPolicy(s, "s1", [], []);
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.schools[0].studentState, "explicit-empty");
  assert.equal(out.schools[0].teacherState, "explicit-empty");
  assert.equal(out.schools[0].ready, true);
  assert.equal(out.ready, false);
  assert.equal(out.status, "NO_GO");
  assert.ok(out.reasons.some((r) => r.includes("already enabled")));
});

test("configured lists resolve with preview display names", async () => {
  const s = fakeStore();
  seedApproved(s, "mdl_a", { displayName: "Gemini" });
  seedApproved(s, "mdl_b", { displayName: "Claude" });
  seedAccess(s, "s1", true, true);
  seedModelPolicy(s, "s1", ["mdl_a"], ["mdl_a", "mdl_b"]);
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.schools[0].ready, true);
  assert.deepEqual(
    out.schools[0].previewStudent.map((m) => m.displayName),
    ["Gemini"]
  );
  assert.deepEqual(
    out.schools[0].previewTeacher.map((m) => m.displayName),
    ["Gemini", "Claude"]
  );
});

test("stale student / teacher keys → NO_GO with counts and keys", async () => {
  const s = fakeStore();
  seedApproved(s, "mdl_a");
  seedAccess(s, "s1", true, true);
  seedModelPolicy(s, "s1", ["mdl_a", "mdl_ghost"], ["mdl_gone"]);
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.status, "NO_GO");
  assert.equal(out.schools[0].studentStaleCount, 1);
  assert.deepEqual(out.schools[0].studentStaleKeys, ["mdl_ghost"]);
  assert.equal(out.schools[0].teacherStaleCount, 1);
  assert.equal(out.summary.staleSchoolAssignments, 2);
});

test("custom valid, custom empty valid, custom outside school valid", async () => {
  const s = fakeStore();
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_b");
  seedAccess(s, "s1", true, true);
  seedModelPolicy(s, "s1", ["mdl_a"], ["mdl_a"]);
  s._state["userModelPolicies/u1"] = { modelMode: "custom", modelKeys: ["mdl_b"] }; // off-school but approved
  s._state["userModelPolicies/u2"] = { modelMode: "custom", modelKeys: [] };
  s._state["userModelPolicies/u3"] = { modelMode: "inherit", modelKeys: [] };
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.individual.malformedPolicies, 0);
  assert.equal(out.individual.customUsers, 2);
  assert.equal(out.individual.customEmptyUsers, 1);
  assert.equal(out.individual.explicitInheritUsers, 1);
  assert.equal(out.individual.staleCustomUsers, 0);
});

test("custom stale + malformed policies → NO_GO", async () => {
  const s = fakeStore();
  seedApproved(s, "mdl_a");
  seedAccess(s, "s1", true, true);
  seedModelPolicy(s, "s1", ["mdl_a"], ["mdl_a"]);
  s._state["userModelPolicies/u1"] = { modelMode: "custom", modelKeys: ["mdl_a", "mdl_ghost"] };
  s._state["userModelPolicies/u2"] = { modelMode: "superuser", modelKeys: [] };
  s._state["userModelPolicies/u3"] = { modelMode: "custom", modelKeys: "nope" };
  s._state["userModelPolicies/u4"] = { modelMode: "custom", modelKeys: Array.from({ length: 101 }, () => "mdl_a") };
  s._state["userModelPolicies/u5"] = { uid: "other", modelMode: "inherit", modelKeys: [] };
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.status, "NO_GO");
  assert.equal(out.individual.staleCustomUsers, 1);
  assert.equal(out.individual.malformedPolicies, 4);
  assert.ok(out.individual.staleCustomList.some((e) => e.uid === "u1"));
});

test("legacy approved flags do not affect validation", async () => {
  const s = fakeStore();
  seedApproved(s, "mdl_old", {
    enabled: false,
    roles: { student: { enabled: false }, teacher: { enabled: false } },
    usage: { schoolwiseEnabled: false, individualEnabled: false },
  });
  seedAccess(s, "s1", true, true);
  seedModelPolicy(s, "s1", ["mdl_old"], []);
  s._state["userModelPolicies/u1"] = { modelMode: "custom", modelKeys: ["mdl_old"] };
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.summary.staleSchoolAssignments, 0);
  assert.equal(out.individual.staleCustomUsers, 0);
  assert.equal(out.individual.malformedPolicies, 0);
});

test("cutover flag state exported true; safe response shape", async () => {  assert.equal(effectiveModels.MODEL_POLICY_CUTOVER, true);
  const s = fakeStore();
  seedApproved(s, "mdl_a", { displayName: "Gemini" });
  seedAccess(s, "s1", true, false);
  seedModelPolicy(s, "s1", ["mdl_a"], []);
  const out = await readiness.runReadiness(deps(s));
  // Post-cutover the check is informational: flag reported, NO-GO reasoned.
  assert.equal(out.cutoverEnabled, true);
  assert.equal(out.ready, false);
  assert.equal(out.status, "NO_GO");
  assert.ok(out.reasons.some((r) => r.includes("already enabled")));
  const dumped = JSON.stringify(out);
  for (const banned of ["upstreamModelId", "upstream/", "pricing", "apiKey", "secret", "password", "privateKey", "idToken"]) {
    assert.equal(dumped.includes(banned), false, `leaked ${banned}`);
  }
  // school names are safe display metadata
  assert.equal(out.schools[0].schoolName, "School s1");
});

test("capability-mark coverage: unmarked approvals surface for picker remediation", async () => {
  const s = fakeStore();
  seedApproved(s, "mdl_ok", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "verified", agentVerify: "verified" },
  });
  seedApproved(s, "mdl_bare", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
  });
  seedAccess(s, "s1", true, true);
  seedModelPolicy(s, "s1", ["mdl_ok", "mdl_bare"], ["mdl_bare"]);
  const out = await readiness.runReadiness(deps(s));
  assert.equal(out.summary.approvedModels, 2);
  assert.equal(out.summary.modelsMissingTerminalMark, 1);
  assert.equal(out.summary.modelsMissingVerifyMark, 1);
  assert.deepEqual(out.capabilityMarks.missingTerminalMarkKeys, ["mdl_bare"]);
  assert.deepEqual(out.capabilityMarks.missingVerifyMarkKeys, ["mdl_bare"]);
  const byKey = Object.fromEntries(out.schools[0].previewStudent.map((m) => [m.modelKey, m]));
  assert.equal(byKey.mdl_ok.hasTerminalMark, true);
  assert.equal(byKey.mdl_ok.hasVerifyMark, true);
  assert.equal(byKey.mdl_bare.hasTerminalMark, false);
  assert.equal(byKey.mdl_bare.hasVerifyMark, false);
  // Informational only: mark gaps never drive GO/NO_GO or leak authority fields.
  assert.ok(!JSON.stringify(out.capabilityMarks).includes("upstream"));
});
