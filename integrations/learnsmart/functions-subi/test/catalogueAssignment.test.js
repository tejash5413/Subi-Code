// test/catalogueAssignment.test.js — assignment simplification (fakes only).
// School/Individual SAVE accepts catalogue selections; the backend ensures
// internal mdl_* registry records (reuse or validated create) and stores
// keys. No manual approval step. Unknown input fails closed before writes.
const test = require("node:test");
const assert = require("node:assert/strict");

const approvedModels = require("../src/services/approvedModelService");
const policies = require("../src/services/modelPolicyService");

function fakeStore() {
  const state = {};
  // Serialized transactions like Firestore (and the repo's route harness):
  // concurrent ensures converge on one record via re-read inside the tx.
  let tail = Promise.resolve();
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
    runTransaction(fn) {
      const cur = tail.then(async () => {
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
      });
      tail = cur.catch(() => {});
      return cur;
    },
  };
}

function counterIds(prefix = "mdl_test") {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

function deps(store, extra) {
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
    ids: counterIds(),
    ...(extra || {}),
  };
}

const CATALOG = [
  {
    upstreamModelId: "prov/alpha",
    name: "Alpha One",
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 64000,
    pricing: { input: "0.1", output: "0.2" },
  },
  {
    upstreamModelId: "prov/beta",
    name: "Beta Two",
    capabilities: { inputModalities: ["text", "image"], outputModalities: ["text"], toolCalling: false },
    contextLength: 32000,
    pricing: { input: null, output: null },
  },
];

function approvedCount(store) {
  return Object.keys(store._state).filter((k) => k.startsWith("approvedModels/")).length;
}

// ---------- ensureCatalogueModels ----------

test("new catalogue model creates a validated registry record, unmarked by default", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  const out = await approvedModels.ensureCatalogueModels(
    [{ upstreamModelId: "prov/alpha" }],
    { ...d, adminUid: "admin-1" }
  );
  assert.deepEqual(out.keys, ["mdl_test-1"]);
  assert.deepEqual(out.created, ["mdl_test-1"]);
  assert.deepEqual(out.reused, []);
  const doc = s._state["approvedModels/mdl_test-1"];
  assert.equal(doc.displayName, "Alpha One");
  assert.equal(doc.upstreamModelId, "prov/alpha");
  assert.equal(doc.enabled, true);
  assert.equal(doc.capabilities.toolCalling, true);
  assert.equal(doc.capabilities.agentTerminal, undefined);
  assert.equal(doc.capabilities.agentVerify, undefined);
  assert.equal(doc.contextLength, 64000);
  const mapKeys = Object.keys(s._state).filter((k) => k.startsWith("approvedModelUpstream/"));
  assert.equal(mapKeys.length, 1);
});

test("existing upstream model reuses the same mdl_* (no duplicate)", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  const first = await approvedModels.ensureCatalogueModels(
    [{ upstreamModelId: "prov/alpha" }],
    { ...d, adminUid: "a" }
  );
  const second = await approvedModels.ensureCatalogueModels(
    [{ upstreamModelId: "prov/alpha" }, { upstreamModelId: "prov/beta" }],
    { ...d, adminUid: "a" }
  );
  assert.deepEqual(second.keys, [first.keys[0], "mdl_test-2"]);
  assert.deepEqual(second.reused, [first.keys[0]]);
  assert.equal(approvedCount(s), 2);
});

test("simultaneous ensure attempts converge on one stable mdl_*", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  const [a, b] = await Promise.all([
    approvedModels.ensureCatalogueModels([{ upstreamModelId: "prov/alpha" }], { ...d, adminUid: "a" }),
    approvedModels.ensureCatalogueModels([{ upstreamModelId: "prov/alpha" }], { ...d, adminUid: "a" }),
  ]);
  assert.equal(a.keys[0], b.keys[0]);
  assert.equal(approvedCount(s), 1);
});

test("unknown upstream rejected before any write; client metadata never trusted", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  await assert.rejects(
    approvedModels.ensureCatalogueModels(
      [{ upstreamModelId: "prov/alpha" }, { upstreamModelId: "evil/forged" }],
      { ...d, adminUid: "a" }
    ),
    (e) => e.code === "UNKNOWN_CATALOGUE_MODEL"
  );
  assert.equal(approvedCount(s), 0, "no orphan registry records on late failure");
  // Client-supplied display/capability metadata is ignored: canonical wins.
  const out = await approvedModels.ensureCatalogueModels(
    [{ upstreamModelId: "prov/beta", displayName: "Forged Name", capabilities: { toolCalling: true }, pricing: { input: "0" } }],
    { ...d, adminUid: "a" }
  );
  const doc = s._state[`approvedModels/${out.keys[0]}`];
  assert.equal(doc.displayName, "Beta Two");
  assert.equal(doc.capabilities.toolCalling, false);
});

test("explicit valid certification preserved; junk marks rejected", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  const out = await approvedModels.ensureCatalogueModels(
    [{ upstreamModelId: "prov/alpha", agentTerminal: "verified", agentVerify: "unknown" }],
    { ...d, adminUid: "a" }
  );
  const doc = s._state[`approvedModels/${out.keys[0]}`];
  assert.equal(doc.capabilities.agentTerminal, "verified");
  assert.equal(doc.capabilities.agentVerify, "unknown");
  for (const bad of [
    { upstreamModelId: "prov/beta", agentTerminal: "superterminal" },
    { upstreamModelId: "prov/beta", agentVerify: 7 },
    { upstreamModelId: "prov/beta", agentTerminal: "" },
  ]) {
    await assert.rejects(
      approvedModels.ensureCatalogueModels([bad], { ...d, adminUid: "a" }),
      (e) => e.code === "INVALID_REQUEST"
    );
  }
  assert.equal(approvedCount(s), 1, "only the valid record exists");
});

// ---------- school SAVE ----------

test("school SAVE maps catalogue selections per role; roles stay independent", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  const out = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1",
      studentModelKeys: [],
      teacherModelKeys: [],
      studentCatalogue: [{ upstreamModelId: "prov/alpha" }, { upstreamModelId: "prov/beta" }],
      teacherCatalogue: [{ upstreamModelId: "prov/beta" }],
      adminUid: "a",
    },
    d
  );
  assert.equal(out.studentModelKeys.length, 2);
  assert.equal(out.teacherModelKeys.length, 1);
  assert.equal(out.teacherModelKeys[0], out.studentModelKeys[1], "beta reused across roles");
  assert.equal(approvedCount(s), 2, "registry ensured once per upstream");
  const served = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student" }, d);
  assert.deepEqual(
    served.models.map((m) => m.displayName).sort(),
    ["Alpha One", "Beta Two"]
  );
  const teacher = await policies.resolveManagedModels({ uid: "t1", schoolId: "s1", role: "teacher" }, d);
  assert.deepEqual(
    teacher.models.map((m) => m.displayName),
    ["Beta Two"]
  );
});

test("school SAVE mixes explicit keys with catalogue; unknown either side rejects", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  s._state["approvedModels/mdl_old"] = {
    schemaVersion: 1,
    modelKey: "mdl_old",
    displayName: "Old",
    upstreamModelId: "prov/old",
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 1000,
    pricing: { input: null, output: null },
    usage: { schoolwiseEnabled: true, individualEnabled: true },
  };
  const out = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1",
      studentModelKeys: ["mdl_old"],
      teacherModelKeys: [],
      studentCatalogue: [{ upstreamModelId: "prov/alpha" }],
      adminUid: "a",
    },
    d
  );
  assert.deepEqual(out.studentModelKeys, ["mdl_old", out.studentModelKeys[1]]);
  await assert.rejects(
    policies.setSchoolModelPolicy(
      { schoolId: "s1", studentModelKeys: ["mdl_nonexistent"], teacherModelKeys: [], adminUid: "a" },
      d
    ),
    (e) => e.code === "UNKNOWN_MODEL_KEY"
  );
  await assert.rejects(
    policies.setSchoolModelPolicy(
      {
        schoolId: "s1",
        studentModelKeys: [],
        teacherModelKeys: [{ upstreamModelId: "prov/not-in-catalogue" }],
        adminUid: "a",
      },
      d
    ),
    (e) => e.code === "INVALID_REQUEST"
  );
});

// ---------- individual SAVE ----------

test("individual custom SAVE stores exactly the selection; replace semantics", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  let out = await policies.setUserModelPolicy(
    {
      uid: "u1",
      modelMode: "custom",
      modelKeys: [],
      catalogueSelections: [{ upstreamModelId: "prov/alpha" }, { upstreamModelId: "prov/beta" }],
      adminUid: "a",
      trustedUser: { schoolId: "s1", role: "student", accountType: "individual" },
    },
    d
  );
  assert.equal(out.modelKeys.length, 2);
  out = await policies.setUserModelPolicy(
    {
      uid: "u1",
      modelMode: "custom",
      modelKeys: [],
      catalogueSelections: [{ upstreamModelId: "prov/beta" }],
      adminUid: "a",
      trustedUser: { schoolId: "s1", role: "student", accountType: "individual" },
    },
    d
  );
  assert.equal(out.modelKeys.length, 1, "replace, not merge");
  const served = await policies.resolveManagedModels(
    { uid: "u1", schoolId: "s1", role: "student", accountType: "individual" },
    d
  );
  assert.deepEqual(
    served.models.map((m) => m.displayName),
    ["Beta Two"]
  );
});

test("individual empty custom serves nothing; inherit rejects catalogue input", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  const out = await policies.setUserModelPolicy(
    {
      uid: "u1",
      modelMode: "custom",
      modelKeys: [],
      catalogueSelections: [],
      adminUid: "a",
      trustedUser: { schoolId: "s1", role: "student", accountType: "individual" },
    },
    d
  );
  assert.deepEqual(out.modelKeys, []);
  const served = await policies.resolveManagedModels(
    { uid: "u1", schoolId: "s1", role: "student", accountType: "individual" },
    d
  );
  assert.equal(served.models.length, 0);
  await assert.rejects(
    policies.setUserModelPolicy(
      {
        uid: "u2",
        modelMode: "inherit",
        modelKeys: [],
        catalogueSelections: [{ upstreamModelId: "prov/alpha" }],
        adminUid: "a",
        trustedUser: {},
      },
      d
    ),
    (e) => e.code === "INVALID_REQUEST"
  );
});

// ---------- bulk (client loop over per-user REPLACE) ----------

test("bulk loop: one registry record reused for every target user", async () => {
  const s = fakeStore();
  const d = deps(s, { catalog: CATALOG });
  const users = ["u1", "u2", "u3"];
  for (const uid of users) {
    const out = await policies.setUserModelPolicy(
      {
        uid,
        modelMode: "custom",
        modelKeys: [],
        catalogueSelections: [{ upstreamModelId: "prov/alpha" }],
        adminUid: "bulk-admin",
        trustedUser: { schoolId: "s1", role: "student", accountType: "individual" },
      },
      d
    );
    assert.equal(out.modelKeys.length, 1);
  }
  assert.equal(approvedCount(s), 1, "single registry record for all users");
  const key = s._state["userModelPolicies/u1"].modelKeys[0];
  for (const uid of users) {
    assert.deepEqual(s._state[`userModelPolicies/${uid}`].modelKeys, [key]);
    const served = await policies.resolveManagedModels(
      { uid, schoolId: "s1", role: "student", accountType: "individual" },
      d
    );
    assert.deepEqual(
      served.models.map((m) => m.modelKey),
      [key]
    );
  }
});
