// test/modelPolicy.test.js — Model Redesign assignment tests (fakes only).
// Covers: school policies, individual inherit/custom, access interaction,
// transfer, role change, legacy-flags-ignored, safe managed response.
const test = require("node:test");
const assert = require("node:assert/strict");

const policies = require("../src/services/modelPolicyService");

test("managed model source is coarse and safe", () => {
  assert.equal(policies.toSafePolicySource("individual_custom"), "individual");
  assert.equal(policies.toSafePolicySource("school_student"), "school");
  assert.equal(policies.toSafePolicySource("school_teacher"), "school");
  assert.equal(policies.toSafePolicySource("unexpected"), "none");
});

test("school account ignores an orphaned individual model policy", () => {
  const out = policies.evaluateModelPolicy({
    userPolicy: { modelMode: "custom", modelKeys: ["mdl_custom"] },
    schoolPolicy: { roles: { student: { modelKeys: ["mdl_school"] } } },
    role: "student",
    accountType: "school",
  });
  assert.deepEqual(out, { mode: "school_student", modelKeys: ["mdl_school"] });
});
const access = require("../src/services/accessService");

function fakeStore() {
  const state = {};
  return {
    _state: state,
    collection: (name) => ({
      doc: (id) => ({
        _key: `${name}/${id}`,
        async get() {
          const key = `${name}/${id}`;
          return { id, exists: key in state, data: () => state[key] };
        },
      }),
      limit: () => ({
        async get() {
          const docs = Object.entries(state)
            .filter(([k]) => k.startsWith(`${name}/`))
            .map(([k, v]) => ({ id: k.slice(name.length + 1), data: () => v }));
          return { docs };
        },
      }),
    }),
    async runTransaction(fn) {
      const tx = {
        set: (ref, data) => {
          state[ref._key] = { ...(state[ref._key] || {}), ...data };
        },
        get: async (ref) => {
          const key = ref._key;
          return { exists: key in state, data: () => state[key] };
        },
      };
      await fn(tx);
    },
  };
}

function deps(store) {
  const audits = [];
  return {
    store,
    audits: {
      async logAudit(e) {
        audits.push(e);
        return { id: "a" };
      },
      _list: audits,
    },
  };
}

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
    pricing: { input: null, output: null },
    usage: { schoolwiseEnabled: true, individualEnabled: true },
    ...over,
  };
}

test("unassigned approved model is never returned", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a", { displayName: "Assigned" });
  seedApproved(s, "mdl_b", { displayName: "Unassigned" });
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1,
    schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: [] } },
  };
  const out = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(out.models.map((m) => m.modelKey), ["mdl_a"]);
});

function seedAccess(store, { global = true, schoolStudent = true, schoolTeacher = true, userMode = null } = {}) {
  store._state["systemConfig/subiAccess"] = { enabled: global };
  store._state["schoolPolicies/s1"] = {
    roles: { student: { enabled: schoolStudent }, teacher: { enabled: schoolTeacher } },
  };
  if (userMode) {
    store._state["userPolicies/u1"] = { accessMode: userMode };
  }
}

// ---------- evaluator ----------

test("evaluateModelPolicy modes: inherit/custom/none", () => {
  const school = { roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_b"] } } };
  assert.deepEqual(
    policies.evaluateModelPolicy({ userPolicy: null, schoolPolicy: school, role: "student" }),
    { mode: "school_student", modelKeys: ["mdl_a"] }
  );
  assert.deepEqual(
    policies.evaluateModelPolicy({
      userPolicy: { modelMode: "inherit", modelKeys: ["mdl_x"] },
      schoolPolicy: school,
      role: "teacher",
    }),
    { mode: "school_teacher", modelKeys: ["mdl_b"] }
  );
  assert.deepEqual(
    policies.evaluateModelPolicy({
      userPolicy: { modelMode: "custom", modelKeys: ["mdl_z"] },
      schoolPolicy: school,
      role: "student",
    }),
    { mode: "individual_custom", modelKeys: ["mdl_z"] }
  );
  // custom [] is valid (no models)
  assert.deepEqual(
    policies.evaluateModelPolicy({
      userPolicy: { modelMode: "custom", modelKeys: [] },
      schoolPolicy: school,
      role: "student",
    }),
    { mode: "individual_custom", modelKeys: [] }
  );
  // missing school / missing branch -> []
  assert.deepEqual(
    policies.evaluateModelPolicy({ userPolicy: null, schoolPolicy: null, role: "student" }),
    { mode: "school_student", modelKeys: [] }
  );
  assert.deepEqual(
    policies.evaluateModelPolicy({
      userPolicy: null,
      schoolPolicy: { roles: { student: { modelKeys: ["mdl_a"] } } },
      role: "teacher",
    }),
    { mode: "school_teacher", modelKeys: [] }
  );
  // malformed user / invalid role fail closed
  assert.deepEqual(
    policies.evaluateModelPolicy({
      userPolicy: { modelMode: "superuser", modelKeys: ["mdl_a"] },
      schoolPolicy: school,
      role: "student",
    }),
    { mode: "none", modelKeys: [] }
  );
  assert.deepEqual(
    policies.evaluateModelPolicy({ userPolicy: null, schoolPolicy: school, role: "admin" }),
    { mode: "none", modelKeys: [] }
  );
});

// ---------- school policies ----------

test("school: student A,B and teacher A,B,C resolve per role", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a", { displayName: "Gemini" });
  seedApproved(s, "mdl_b", { displayName: "Claude" });
  seedApproved(s, "mdl_c", { displayName: "MiniMax" });
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a", "mdl_b"], teacherModelKeys: ["mdl_a", "mdl_b", "mdl_c"], adminUid: "admin" },
    d
  );
  const st = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(st.models.map((m) => m.displayName), ["Gemini", "Claude"]);
  const te = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "teacher" }, d);
  assert.deepEqual(te.models.map((m) => m.displayName), ["Gemini", "Claude", "MiniMax"]);
  assert.equal(d.audits._list[0].action, "school_models.updated");
});

test("school: missing policy and missing branch fail closed", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  const missing = await policies.resolveManagedModels({ uid: "u1", schoolId: "nope", role: "student" }, d);
  assert.deepEqual(missing.models, []);
  // policy with only a student branch: teacher gets []
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1,
    schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a"] } },
  };
  const te = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "teacher" }, d);
  assert.deepEqual(te.models, []);
});

test("school: unknown keys rejected; stale keys dropped on read", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  await assert.rejects(
    policies.setSchoolModelPolicy(
      { schoolId: "s1", studentModelKeys: ["mdl_a", "mdl_ghost"], teacherModelKeys: [], adminUid: "a" },
      d
    ),
    (e) => e.code === "UNKNOWN_MODEL_KEY"
  );
  // raw stale assignment (e.g. model removed later): dropped, valid survive
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1,
    schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a", "mdl_gone"] }, teacher: { modelKeys: [] } },
  };
  const out = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(out.models.map((m) => m.modelKey), ["mdl_a"]);
  const safe = await policies.resolveApprovedSafe(["mdl_a", "mdl_gone"], d);
  assert.deepEqual(safe.staleModelKeys, ["mdl_gone"]);
});

test("school: 100-key cap enforced; duplicates deduped first-seen", async () => {
  const s = fakeStore();
  const d = deps(s);
  for (let i = 0; i < 101; i += 1) seedApproved(s, `mdl_k${i}`);
  const big = Array.from({ length: 101 }, (_, i) => `mdl_k${i}`);
  await assert.rejects(
    policies.setSchoolModelPolicy({ schoolId: "s1", studentModelKeys: big, teacherModelKeys: [], adminUid: "a" }, d),
    (e) => e.code === "REQUEST_TOO_LARGE"
  );
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_b");
  const out = await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_b", "mdl_a", "mdl_b"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  assert.deepEqual(out.studentModelKeys, ["mdl_b", "mdl_a"]);
});

// ---------- individual policies ----------

test("individual: missing policy inherits; custom exact incl [] and off-school keys", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a", { displayName: "Gemini" });
  seedApproved(s, "mdl_b", { displayName: "Claude" });
  seedApproved(s, "mdl_c", { displayName: "MiniMax" });
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a", "mdl_b"], teacherModelKeys: ["mdl_a"], adminUid: "a" },
    d
  );
  // missing user policy -> inherit
  const inh = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(inh.models.map((m) => m.displayName), ["Gemini", "Claude"]);
  // custom replaces (superset incl. off-school key, smaller, empty)
  await policies.setUserModelPolicy(
    { uid: "u1", modelMode: "custom", modelKeys: ["mdl_a", "mdl_c"], adminUid: "a", trustedUser: { schoolId: "s1", role: "student" } },
    d
  );
  const custom = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(custom.models.map((m) => m.displayName), ["Gemini", "MiniMax"]);
  assert.equal(d.audits._list[d.audits._list.length - 1].action, "user_models.custom");
  await policies.setUserModelPolicy(
    { uid: "u1", modelMode: "custom", modelKeys: [], adminUid: "a", trustedUser: { schoolId: "s1", role: "student" } },
    d
  );
  const empty = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(empty.models, []);
  // restore inherit: explicit inherit doc, empty keys
  const back = await policies.setUserModelPolicy(
    { uid: "u1", modelMode: "inherit", modelKeys: ["mdl_a"], adminUid: "a", trustedUser: { schoolId: "s1", role: "student" } },
    d
  );
  assert.deepEqual(back, {
    uid: "u1",
    modelMode: "inherit",
    modelKeys: [],
    createdModelKeys: [],
    reusedModelKeys: [],
    reenabledModelKeys: [],
    verifiedModelKeys: [],
  });
  assert.equal(d.audits._list[d.audits._list.length - 1].action, "user_models.inherit");
  const again = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(again.models.map((m) => m.displayName), ["Gemini", "Claude"]);
});

test("individual: malformed stored mode fails closed", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1,
    schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: [] } },
  };
  s._state["userModelPolicies/u1"] = { modelMode: "superuser", modelKeys: ["mdl_a"] };
  const out = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(out, { mode: "none", models: [], assignedCount: 0, autoIncludedCount: 0, staleModelKeys: [], disabledModelKeys: [] });
});

// ---------- access interaction ----------

test("access+models: Arun case — school access OFF, individual access Enabled, model inherit", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a", { displayName: "Gemini" });
  seedApproved(s, "mdl_b", { displayName: "Claude" });
  seedAccess(s, { global: true, schoolStudent: false, schoolTeacher: true, userMode: "enabled" });
  const acc = await access.resolveSubiAccess({ accountType: 'school', uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.equal(acc.allowed, true);
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a", "mdl_b"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  const models = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(models.models.map((m) => m.displayName), ["Gemini", "Claude"]);
});

test("access+models: global OFF and individual disabled block regardless of assignment", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: ["mdl_a"], adminUid: "a" },
    d
  );
  seedAccess(s, { global: false, userMode: "enabled" });
  const g = await access.resolveSubiAccess({ accountType: 'school', uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.equal(g.allowed, false);
  seedAccess(s, { global: true, userMode: "disabled" });
  const u = await access.resolveSubiAccess({ accountType: 'school', uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.equal(u.allowed, false);
});

// ---------- legacy flags ignored, except master disable ----------

test("legacy role/usage flags cannot block explicit new assignment", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_old", {
    displayName: "Legacy",
    enabled: true,
    roles: { student: { enabled: false }, teacher: { enabled: false } },
    usage: { schoolwiseEnabled: false, individualEnabled: false },
  });
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_old"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  const viaSchool = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.equal(viaSchool.models.length, 1);
  assert.equal(viaSchool.models[0].displayName, "Legacy");
  await policies.setUserModelPolicy(
    { uid: "u9", modelMode: "custom", modelKeys: ["mdl_old"], adminUid: "a", trustedUser: { schoolId: "s1", role: "teacher" } },
    d
  );
  const viaCustom = await policies.resolveManagedModels({ uid: "u9", schoolId: "s1", role: "teacher" }, d);
  assert.equal(viaCustom.models.length, 1);
});

test("disabled model selected+saved re-enables; manual disable hides until next save", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_off", { displayName: "Off", enabled: false });
  const saved = await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_off"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  // Unified assignment certification: explicit selection re-enables.
  assert.deepEqual(saved.reenabledModelKeys, ["mdl_off"]);
  assert.deepEqual(saved.verifiedModelKeys, ["mdl_off"]);
  const served = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.equal(served.models.length, 1);
  assert.equal(served.models[0].displayName, "Off");
  // Registry manual Disable afterward stays authoritative (hidden again).
  const approvedModels = require("../src/services/approvedModelService");
  await approvedModels.updateApprovedModel("mdl_off", { enabled: false }, "a", d);
  const hidden = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.equal(hidden.models.length, 0);
  assert.deepEqual(hidden.disabledModelKeys, ["mdl_off"]);
  // Assignment intact: explicit re-save re-enables with no reassign.
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_off"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  const restored = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.equal(restored.models.length, 1);
});

// ---------- transfer + role change ----------

test("inherit follows school transfer; custom survives", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a", { displayName: "A" });
  seedApproved(s, "mdl_b", { displayName: "B" });
  seedApproved(s, "mdl_c", { displayName: "C" });
  s._state["schoolModelPolicies/sA"] = {
    schemaVersion: 1, schoolId: "sA",
    roles: { student: { modelKeys: ["mdl_a", "mdl_b"] }, teacher: { modelKeys: [] } },
  };
  s._state["schoolModelPolicies/sB"] = {
    schemaVersion: 1, schoolId: "sB",
    roles: { student: { modelKeys: ["mdl_c"] }, teacher: { modelKeys: [] } },
  };
  const before = await policies.resolveManagedModels({ uid: "u1", schoolId: "sA", role: "student" }, d);
  assert.deepEqual(before.models.map((m) => m.displayName), ["A", "B"]);
  const after = await policies.resolveManagedModels({ uid: "u1", schoolId: "sB", role: "student" }, d);
  assert.deepEqual(after.models.map((m) => m.displayName), ["C"]);
  await policies.setUserModelPolicy(
    { uid: "u1", modelMode: "custom", modelKeys: ["mdl_a", "mdl_c"], adminUid: "a", trustedUser: { schoolId: "sA", role: "student" } },
    d
  );
  const moved = await policies.resolveManagedModels({ uid: "u1", schoolId: "sB", role: "student" }, d);
  assert.deepEqual(moved.models.map((m) => m.displayName), ["A", "C"]);
});

test("inherit switches on role change; custom unchanged", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a", { displayName: "A" });
  seedApproved(s, "mdl_b", { displayName: "B" });
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1, schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_b"] } },
  };
  const st = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(st.models.map((m) => m.displayName), ["A"]);
  const te = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "teacher" }, d);
  assert.deepEqual(te.models.map((m) => m.displayName), ["B"]);
  await policies.setUserModelPolicy(
    { uid: "u1", modelMode: "custom", modelKeys: ["mdl_a"], adminUid: "a", trustedUser: { schoolId: "s1", role: "student" } },
    d
  );
  const teCustom = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "teacher" }, d);
  assert.deepEqual(teCustom.models.map((m) => m.displayName), ["A"]);
});

// ---------- safe response ----------

test("managed models expose only safe projection", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a", { displayName: "A", pricing: { input: "1", output: "2" } });
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  const out = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(Object.keys(out.models[0]).sort(), ["capabilities", "contextLength", "displayName", "modelKey"]);
  const dumped = JSON.stringify(out);
  for (const banned of ["upstreamModelId", "upstream/", "pricing", "roles", "usage", "updatedBy", "schoolModel", "userModel"]) {
    assert.equal(dumped.includes(banned), false, `leaked ${banned}`);
  }
});

test("store failure surfaces UNAVAILABLE", async () => {
  const s = fakeStore();
  const d = deps(s);
  s.collection = () => {
    throw new Error("down");
  };
  await assert.rejects(
    policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d),
    (e) => e.code === "UNAVAILABLE"
  );
});
