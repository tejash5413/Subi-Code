// test/modelAssignmentSync.test.js — School/Individual assignment live-sync
// repair tests (fakes only, no network/Firestore).
//
// Covers: school-default Student/Teacher resolution + isolation, custom
// Individual override + reset-to-inherit freshness (no stale C), fresh
// assignment immediately visible, disabled/removed exclusion,
// assignment-vs-certification separation (uncertified models still listed
// by the managed resolver; agent preflights stay authoritative), and
// save-time catalogue freshness bypass (stale display cache never fails a
// mutation for a model the live catalogue contains).
const test = require("node:test");
const assert = require("node:assert/strict");

const policies = require("../src/services/modelPolicyService");
const catalogService = require("../src/services/modelCatalogService");

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
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 128000,
    pricing: { input: null, output: null },
    usage: { schoolwiseEnabled: true, individualEnabled: true },
    ...over,
  };
}

function seedSchool(store, studentKeys, teacherKeys) {
  store._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1,
    schoolId: "s1",
    roles: { student: { modelKeys: studentKeys }, teacher: { modelKeys: teacherKeys } },
  };
}

test("school-default Student receives current Students list (Teacher list isolated)", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_b");
  seedSchool(s, ["mdl_a"], ["mdl_b"]);
  const st = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.equal(st.mode, "school_student");
  assert.deepEqual(st.models.map((m) => m.modelKey), ["mdl_a"]);
  const te = await policies.resolveManagedModels({ uid: "u2", schoolId: "s1", role: "teacher", accountType: "school" }, d);
  assert.equal(te.mode, "school_teacher");
  assert.deepEqual(te.models.map((m) => m.modelKey), ["mdl_b"]);
});

test("newly saved Student model is immediately visible (no second save)", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_new");
  seedSchool(s, ["mdl_a"], []);
  const before = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.deepEqual(before.models.map((m) => m.modelKey), ["mdl_a"]);
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a", "mdl_new"], teacherModelKeys: [], adminUid: "admin" },
    d
  );
  const after = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.deepEqual(after.models.map((m) => m.modelKey), ["mdl_a", "mdl_new"]);
  // Teacher branch untouched by the Student save.
  const te = await policies.resolveManagedModels({ uid: "u2", schoolId: "s1", role: "teacher", accountType: "school" }, d);
  assert.deepEqual(te.models.map((m) => m.modelKey), []);
});

test("removed model disappears immediately after save", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_b");
  seedSchool(s, ["mdl_a", "mdl_b"], []);
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: [], adminUid: "admin" },
    d
  );
  const after = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.deepEqual(after.models.map((m) => m.modelKey), ["mdl_a"]);
});

test("custom Individual override wins; reset to inherit restores school list with no stale C", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_b");
  seedApproved(s, "mdl_c");
  seedSchool(s, ["mdl_a", "mdl_b"], []);
  await policies.setUserModelPolicy(
    { uid: "u9", modelMode: "custom", modelKeys: ["mdl_c"], adminUid: "admin", trustedUser: { schoolId: "s1", role: "student", accountType: "individual" } },
    d
  );
  const custom = await policies.resolveManagedModels({ uid: "u9", schoolId: "s1", role: "student", accountType: "individual" }, d);
  assert.equal(custom.mode, "individual_custom");
  assert.deepEqual(custom.models.map((m) => m.modelKey), ["mdl_c"]);
  await policies.setUserModelPolicy(
    { uid: "u9", modelMode: "inherit", modelKeys: [], adminUid: "admin", trustedUser: { schoolId: "s1", role: "student", accountType: "individual" } },
    d
  );
  const again = await policies.resolveManagedModels({ uid: "u9", schoolId: "s1", role: "student", accountType: "individual" }, d);
  assert.equal(again.mode, "school_student");
  assert.deepEqual(again.models.map((m) => m.modelKey), ["mdl_a", "mdl_b"]);
});

test("disabled model excluded; removed (unknown) model excluded as stale", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_off", { enabled: false });
  seedSchool(s, ["mdl_a", "mdl_off", "mdl_gone"], []);
  const out = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.deepEqual(out.models.map((m) => m.modelKey), ["mdl_a"]);
  assert.deepEqual(out.disabledModelKeys, ["mdl_off"]);
  assert.deepEqual(out.staleModelKeys, ["mdl_gone"]);
});

test("assignment vs certification: uncertified model still listed for managed chat", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_plain", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
  });
  seedSchool(s, ["mdl_plain"], []);
  const out = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  // No certification filter at assignment time: present for ordinary chat.
  // Agent capability gates (toolCalling/agentVerify/terminal) stay enforced
  // per-turn by the managed agent/chat preflights, not here.
  assert.deepEqual(out.models.map((m) => m.modelKey), ["mdl_plain"]);
});

test("assignment certifies: new record enabled+verified, existing unverified stamped, verified preserved", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_new"); // no marks at all
  seedApproved(s, "mdl_old", { capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } });
  seedApproved(s, "mdl_done", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentVerify: "verified", agentTerminal: "verified" },
  });
  const beforeDone = JSON.parse(JSON.stringify(s._state["approvedModels/mdl_done"]));
  const out = await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_new", "mdl_old", "mdl_done"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  const fresh = (k) => s._state[`approvedModels/${k}`];
  assert.equal(fresh("mdl_new").enabled, true);
  assert.equal(fresh("mdl_new").capabilities.agentVerify, "verified");
  assert.equal(fresh("mdl_new").capabilities.agentTerminal, "verified");
  assert.equal(fresh("mdl_old").capabilities.agentVerify, "verified");
  assert.equal(fresh("mdl_old").capabilities.agentTerminal, "verified");
  // Unrelated fields preserved byte-for-byte on the stamped record.
  assert.equal(fresh("mdl_old").capabilities.toolCalling, true);
  assert.deepEqual(fresh("mdl_old").capabilities.inputModalities, ["text"]);
  assert.equal(fresh("mdl_old").displayName, "mdl_old");
  // Already-verified record rewritten only if needed; effective content same.
  assert.deepEqual(fresh("mdl_done").capabilities, beforeDone.capabilities);
  assert.deepEqual(out.verifiedModelKeys.sort(), ["mdl_new", "mdl_old"]);
  // All three serve immediately.
  const served = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.deepEqual(served.models.map((m) => m.modelKey).sort(), ["mdl_done", "mdl_new", "mdl_old"]);
});

test("unselection removes policy only; registry stays enabled+verified", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: [], teacherModelKeys: [], adminUid: "a" },
    d
  );
  const rec = s._state["approvedModels/mdl_a"];
  assert.equal(rec.enabled, true, "registry not disabled by unselect");
  assert.equal(rec.capabilities.agentVerify, "verified", "registry not unverified by unselect");
  const served = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.deepEqual(served.models, []);
});

test("same upstream saved twice reuses one registry record (idempotent)", async () => {
  const s = fakeStore();
  const catalog = [
    { upstreamModelId: "prov/dup", name: "Dup", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } },
  ];
  const dd = { ...deps(s), catalog };
  const first = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1", studentModelKeys: [], teacherModelKeys: [],
      studentCatalogue: [{ upstreamModelId: "prov/dup" }], adminUid: "a",
    },
    dd
  );
  const second = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1", studentModelKeys: [], teacherModelKeys: [],
      teacherCatalogue: [{ upstreamModelId: "prov/dup" }], adminUid: "a",
    },
    dd
  );
  assert.equal(first.createdModelKeys.length, 1);
  assert.deepEqual(second.createdModelKeys, [], "second save reuses");
  assert.equal(second.teacherModelKeys[0], first.studentModelKeys[0]);
  const registryKeys = Object.keys(s._state).filter((k) => k.startsWith("approvedModels/"));
  assert.equal(registryKeys.length, 1, "no duplicate registry records");
});

test("atomic failure: unknown key fails whole save with zero writes", async () => {
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
  assert.equal("schoolModelPolicies/s1" in s._state, false, "no policy doc written");
});

test("stale-tab overwrite rejected with POLICY_CONFLICT; fresh token succeeds", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  seedApproved(s, "mdl_b");
  const first = await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  // A second admin saves in between (bumps updatedAt; forced +60s so the
  // test is deterministic even at millisecond clock resolution).
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: ["mdl_b"], adminUid: "b" },
    d
  );
  s._state["schoolModelPolicies/s1"].updatedAt = new Date(Date.now() + 60000);
  // Stale tab (holding the first updatedAt) must fail before any write.
  await assert.rejects(
    policies.setSchoolModelPolicy(
      {
        schoolId: "s1", studentModelKeys: [], teacherModelKeys: [],
        adminUid: "a", expectedUpdatedAt: first.updatedAt,
      },
      d
    ),
    (e) => e.code === "POLICY_CONFLICT"
  );
  const kept = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "teacher", accountType: "school" }, d);
  assert.deepEqual(kept.models.map((m) => m.modelKey), ["mdl_b"], "newer branch preserved");
  // Fresh token succeeds.
  const current = await policies.getSchoolModelPolicy("s1", d);
  const ok = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: ["mdl_b"],
      adminUid: "a", expectedUpdatedAt: current.updatedAt,
    },
    d
  );
  assert.deepEqual(ok.studentModelKeys, ["mdl_a"]);
});

test("individual stale overwrite rejected; missing doc never conflicts", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  const first = await policies.setUserModelPolicy(
    {
      uid: "u9", modelMode: "custom", modelKeys: ["mdl_a"], adminUid: "a",
      trustedUser: { schoolId: "s1", role: "student", accountType: "individual" },
    },
    d
  );
  assert.ok(first.updatedAt === undefined, "user setter returns no updatedAt (token via GET)");
  await assert.rejects(
    policies.setUserModelPolicy(
      {
        uid: "u9", modelMode: "inherit", modelKeys: [], adminUid: "b",
        trustedUser: { schoolId: "s1", role: "student", accountType: "individual" },
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      },
      d
    ),
    (e) => e.code === "POLICY_CONFLICT"
  );
});

test("policy cap 100 enforced; SUBI named-database routing kept", async () => {
  const s = fakeStore();
  const d = deps(s);
  const big = Array.from({ length: 101 }, (_, i) => `mdl_${String(i).padStart(3, "0")}-x`);
  await assert.rejects(
    policies.setSchoolModelPolicy({ schoolId: "s1", studentModelKeys: big, teacherModelKeys: [], adminUid: "a" }, d),
    (e) => e.code === "REQUEST_TOO_LARGE"
  );
  // Named-database guard is enforced by scripts/check-boundaries.js
  // (boundary check OK); service defaultDeps routes to subiDb.
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "src", "services", "modelPolicyService.js"),
    "utf8"
  );
  assert.ok(src.includes('store: subiDb'), "policy service defaults to the named subi database");
  assert.equal((src.match(/admin\.firestore\(\)/g) || []).length, 0, "never the default database");
});

test("mixed existing/new: registry-only stale upstream + current catalogue succeeds", async () => {
  // §17: mdl_A's upstream vanished from the catalogue; mdl_B + C-upstream
  // are current. The save must succeed with all three canonical keys.
  const s = fakeStore();
  const catalog = [
    { upstreamModelId: "prov/b", name: "B", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } },
    { upstreamModelId: "prov/c", name: "C", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } },
  ];
  const d = { ...deps(s), catalog };
  seedApproved(s, "mdl_a", { upstreamModelId: "prov/vanished" });
  seedApproved(s, "mdl_b", { upstreamModelId: "prov/b" });
  const out = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1",
      studentModelKeys: ["mdl_a", "mdl_b"],
      teacherModelKeys: [],
      studentCatalogue: [{ upstreamModelId: "prov/c" }],
      adminUid: "a",
    },
    d
  );
  assert.deepEqual(out.studentModelKeys.slice(0, 2), ["mdl_a", "mdl_b"]);
  assert.equal(out.studentModelKeys.length, 3, "mdl_A + mdl_B + canonical mdl_C");
  assert.equal(out.createdModelKeys.length, 1);
  const served = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.deepEqual(served.models.map((m) => m.modelKey).sort(), [...out.studentModelKeys].sort());
});

test("truly unknown catalogue ID fails UNKNOWN_CATALOGUE_MODEL with zero writes", async () => {
  const s = fakeStore();
  const catalog = [
    { upstreamModelId: "prov/real", name: "Real", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } },
  ];
  const d = { ...deps(s), catalog };
  seedApproved(s, "mdl_a");
  await assert.rejects(
    policies.setSchoolModelPolicy(
      {
        schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: [],
        studentCatalogue: [{ upstreamModelId: "not-a-real-current-model" }],
        adminUid: "a",
      },
      d
    ),
    (e) => e.code === "UNKNOWN_CATALOGUE_MODEL"
  );
  assert.equal("schoolModelPolicies/s1" in s._state, false, "no partial writes");
  assert.equal(Object.keys(s._state).filter((k) => k.startsWith("approvedModels/")).length, 1);
});

test("hidden-filter save: 17 existing + 1 new persist as 18", async () => {
  // §20: search/filter shows 4 rows, but the save payload carries the full
  // 17-key draft plus the new pick — all persist.
  const s = fakeStore();
  const items = [];
  for (let i = 0; i < 17; i += 1) {
    seedApproved(s, `mdl_k${i}`);
    items.push(`mdl_k${i}`);
  }
  const d = deps(s);
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: items, teacherModelKeys: [], adminUid: "a" },
    d
  );
  seedApproved(s, "mdl_extra");
  const out = await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: [...items, "mdl_extra"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  assert.equal(out.studentModelKeys.length, 18);
  const served = await policies.resolveManagedModels({ uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, d);
  assert.equal(served.models.length, 18);
});

test("duplicate identity (key + upstream of same model) resolves once, no duplicate record", async () => {
  const s = fakeStore();
  const catalog = [
    { upstreamModelId: "prov/dup", name: "Dup", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } },
  ];
  const d = { ...deps(s), catalog };
  seedApproved(s, "mdl_dup", { upstreamModelId: "prov/dup" });
  const out = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1", studentModelKeys: ["mdl_dup"], teacherModelKeys: [],
      studentCatalogue: [{ upstreamModelId: "prov/dup" }],
      adminUid: "a",
    },
    d
  );
  assert.deepEqual(out.studentModelKeys, ["mdl_dup"], "canonical key preferred, no duplicate");
  assert.deepEqual(out.createdModelKeys, []);
  const registryKeys = Object.keys(s._state).filter((k) => k.startsWith("approvedModels/"));
  assert.deepEqual(registryKeys, ["approvedModels/mdl_dup"]);
});

test("upstream IDs with /, :, -, . and mixed naming normalize consistently", async () => {
  const tricky = [
    "openai/gpt-4.1-mini",
    "anthropic:claude-3.7-sonnet",
    "x-ai/grok-4.1-fast-non-reasoning",
    "google/gemini-2.5-flash-lite-preview-06-17",
  ];
  const s = fakeStore();
  const catalog = tricky.map((id) => ({
    upstreamModelId: id,
    name: id,
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
  }));
  const d = { ...deps(s), catalog };
  const out = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1", studentModelKeys: [], teacherModelKeys: [],
      studentCatalogue: tricky.map((upstreamModelId) => ({ upstreamModelId })),
      adminUid: "a",
    },
    d
  );
  assert.equal(out.studentModelKeys.length, 4);
  assert.equal(new Set(out.studentModelKeys).size, 4);
  // Saving the same upstream set twice reuses (hash mapping is stable).
  const again = await policies.setSchoolModelPolicy(
    {
      schoolId: "s1", studentModelKeys: [], teacherModelKeys: [],
      studentCatalogue: tricky.map((upstreamModelId) => ({ upstreamModelId: `  ${upstreamModelId}  ` })),
      adminUid: "a",
    },
    d
  );
  assert.deepEqual([...again.studentModelKeys].sort(), [...out.studentModelKeys].sort());
});

test("Timestamp wire shapes compare equal in the concurrency guard", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedApproved(s, "mdl_a");
  await policies.setSchoolModelPolicy(
    { schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: [], adminUid: "a" },
    d
  );
  // Every Firestore Timestamp JSON wire shape must match one fixed stored
  // value (stored token reset each round so shapes compare equally).
  const fms = Date.now() + 3600000;
  const shapesOf = (ms) => [
    new Date(ms),
    ms,
    new Date(ms).toISOString(),
    { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1000000 },
    { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1000000 },
    { seconds: String(Math.floor(ms / 1000)), nanoseconds: String((ms % 1000) * 1000000) },
  ];
  for (const shape of shapesOf(fms)) {
    s._state["schoolModelPolicies/s1"].updatedAt = new Date(fms);
    const ok = await policies.setSchoolModelPolicy(
      {
        schoolId: "s1", studentModelKeys: ["mdl_a"], teacherModelKeys: [],
        adminUid: "a", expectedUpdatedAt: shape,
      },
      d
    );
    assert.deepEqual(ok.studentModelKeys, ["mdl_a"]);
  }
});

test("save-time catalogue fetch bypasses the stale display cache", async () => {
  catalogService.clearCacheForTests();
  const staleOnly = [
    { upstreamModelId: "vendor/old", name: "Old", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } },
  ];
  const fresh = [
    ...staleOnly,
    { upstreamModelId: "vendor/new", name: "New", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } },
  ];
  const fakeFetch = async (items) => async () => ({
    status: 200,
    headers: { get: () => "application/json" },
    body: null,
    text: async () => JSON.stringify({ data: items.map((m) => ({ id: m.upstreamModelId, name: m.name, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"] })) }),
  });
  const keyResolver = async () => Buffer.from("k");
  // Seed the display cache with the stale list.
  const first = await catalogService.fetchCatalog({ fetchImpl: await fakeFetch(staleOnly), keyResolver });
  assert.equal(first.cached, false);
  assert.equal(first.models.some((m) => m.upstreamModelId === "vendor/new"), false);
  // Default read path serves the stale cache.
  const cached = await catalogService.fetchCatalog();
  assert.equal(cached.cached, true);
  assert.equal(cached.models.some((m) => m.upstreamModelId === "vendor/new"), false);
  // Mutation path bypasses it and sees the new model.
  const live = await catalogService.fetchCatalog({ refresh: true, fetchImpl: await fakeFetch(fresh), keyResolver });
  assert.equal(live.models.some((m) => m.upstreamModelId === "vendor/new"), true);
  catalogService.clearCacheForTests();
});
