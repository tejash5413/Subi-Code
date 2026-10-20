// test/approvedModels.test.js — Phase 4 approved-model tests (fakes only).
const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../src/services/approvedModelService");

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
function deps(store, n = { i: 0 }) {
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
    ids: () => `mdl_test-${++n.i}`,
  };
}
const approval = (over = {}) => ({
  upstreamModelId: "anthropic/claude-sonnet-4",
  displayName: "Claude Sonnet",
  enabled: false,
  studentEnabled: false,
  teacherEnabled: false,
  capabilities: { inputModalities: ["text", "image"], outputModalities: ["text"], toolCalling: true },
  contextLength: 200000,
  ...over,
});

test("approve creates fail-closed record with server key", async () => {
  const s = fakeStore();
  const d = deps(s);
  const out = await svc.approveModel(approval(), "admin1", d);
  assert.ok(out.modelKey.startsWith("mdl_"));
  assert.equal(out.enabled, false);
  assert.equal(out.roles.student.enabled, false);
  assert.equal(out.roles.teacher.enabled, false);
  assert.equal(d.audits._list[0].action, "model.approved");
  assert.ok(s._state[`approvedModelUpstream/${svc.upstreamHash("anthropic/claude-sonnet-4")}`]);
});

test("duplicate upstream rejected atomically", async () => {
  const s = fakeStore();
  const d = deps(s);
  await svc.approveModel(approval(), "a", d);
  await assert.rejects(svc.approveModel(approval({ displayName: "Other" }), "a", d), (e) => e.code === "DUPLICATE_MODEL");
  const keys = Object.keys(s._state).filter((k) => k.startsWith("approvedModels/"));
  assert.equal(keys.length, 1);
});

test("strict input validation", async () => {
  const s = fakeStore();
  const d = deps(s);
  for (const bad of [
    null,
    {},
    approval({ upstreamModelId: "" }),
    approval({ displayName: "" }),
    approval({ enabled: "yes" }),
    approval({ modelKey: "mdl_evil" }),
    approval({ quota: 5 }),
  ]) {
    await assert.rejects(svc.approveModel(bad, "a", d), (e) => e.code === "INVALID_REQUEST");
  }
  // unknown capability dropped, not rejected
  const out = await svc.approveModel(approval({ upstreamModelId: "x/y", capabilities: { inputModalities: ["telepathy"], toolCalling: "yes" } }), "a", d);
  assert.deepEqual(out.capabilities.inputModalities, []);
  assert.equal(out.capabilities.toolCalling, false);
  assert.equal(out.capabilities.agentTerminal, undefined);
});

test("agentTerminal compatibility is a strict three-state enum", async () => {
  const s = fakeStore();
  const d = deps(s);
  const verified = await svc.approveModel(
    approval({ upstreamModelId: "v/m", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "verified" } }),
    "a", d
  );
  assert.equal(verified.capabilities.agentTerminal, "verified");
  const bad = await svc.approveModel(
    approval({ upstreamModelId: "b/m", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "sometimes" } }),
    "a", d
  );
  assert.equal(bad.capabilities.agentTerminal, undefined);
  const updated = await svc.updateApprovedModel(verified.modelKey, { capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "unsupported" } }, "a", d);
  assert.equal(updated.capabilities.agentTerminal, "unsupported");
});

test("agentVerify compatibility is an explicit verified/unsupported/unknown enum", async () => {
  const s = fakeStore();
  const d = deps(s);
  const verified = await svc.approveModel(
    approval({ upstreamModelId: "v/m", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentVerify: "verified" } }),
    "a", d
  );
  assert.equal(verified.capabilities.agentVerify, "verified");
  const unknown = await svc.approveModel(
    approval({ upstreamModelId: "u/m", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentVerify: "unknown" } }),
    "a", d
  );
  assert.equal(unknown.capabilities.agentVerify, "unknown");
  const bad = await svc.approveModel(
    approval({ upstreamModelId: "b/m", capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentVerify: "sometimes" } }),
    "a", d
  );
  assert.equal(bad.capabilities.agentVerify, undefined);
});

test("approval no longer requires legacy assignment flags", async () => {
  const s = fakeStore();
  const d = deps(s);
  // New minimal payload: master approval only, no Global/Student/Teacher/usage flags.
  const out = await svc.approveModel(
    {
      upstreamModelId: "openai/gpt-new",
      displayName: "GPT New",
      capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
      contextLength: 64000,
      pricing: { input: "0.000001", output: "0.000002" },
    },
    "a",
    d
  );
  assert.ok(out.modelKey.startsWith("mdl_"));
  assert.equal(out.displayName, "GPT New");
  assert.equal(out.upstreamModelId, "openai/gpt-new");
  // Legacy payloads from older clients remain accepted.
  const legacy = await svc.approveModel(
    approval({ upstreamModelId: "openai/gpt-old", enabled: true, studentEnabled: true, teacherEnabled: false }),
    "a",
    d
  );
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.roles.student.enabled, true);
  assert.equal(legacy.roles.teacher.enabled, false);
});

test("update mutable fields; immutables enforced; createdAt preserved", async () => {
  const s = fakeStore();
  const d = deps(s);
  const created = await svc.approveModel(approval(), "a", d);
  const before = s._state[`approvedModels/${created.modelKey}`].createdAt;
  // immutable fields are rejected outright (exact-body validation)
  await assert.rejects(
    svc.updateApprovedModel(
      created.modelKey,
      { displayName: "Sonnet!", upstreamModelId: "evil/x", modelKey: "mdl_evil" },
      "a",
      d
    ),
    (e) => e.code === "INVALID_REQUEST"
  );
  const out = await svc.updateApprovedModel(
    created.modelKey,
    { displayName: "Sonnet!", enabled: true, studentEnabled: true },
    "a",
    d
  );
  assert.equal(out.displayName, "Sonnet!");
  assert.equal(out.enabled, true);
  assert.equal(out.roles.student.enabled, true);
  assert.equal(out.upstreamModelId, "anthropic/claude-sonnet-4");
  assert.equal(out.modelKey, created.modelKey);
  assert.deepEqual(s._state[`approvedModels/${created.modelKey}`].createdAt, before);
  assert.equal(d.audits._list[d.audits._list.length - 1].action, "model.enabled");
  await assert.rejects(svc.updateApprovedModel("mdl_nope", { enabled: true }, "a", d), (e) => e.code === "INVALID_REQUEST");
  await assert.rejects(svc.updateApprovedModel(created.modelKey, {}, "a", d), (e) => e.code === "INVALID_REQUEST");
});

test("pricing stored as reference; invalid pricing sanitized to null", async () => {
  const s = fakeStore();
  const d = deps(s);
  const out = await svc.approveModel(
    approval({ upstreamModelId: "p/1", pricing: { input: "0.00000125", output: "0.00000425" } }),
    "a",
    d
  );
  assert.equal(out.pricing.input, "0.00000125");
  assert.equal(out.pricing.output, "0.00000425");
  const bad = await svc.approveModel(
    approval({ upstreamModelId: "p/2", pricing: { input: "evil", output: -1 } }),
    "a",
    d
  );
  assert.equal(bad.pricing.input, null);
  assert.equal(bad.pricing.output, null);
  // legacy docs without pricing read back as nulls (filter passes)
  const legacy = await svc.approveModel(approval({ upstreamModelId: "p/3" }), "a", d);
  assert.deepEqual(legacy.pricing, { input: null, output: null });
});

test("usage flags default ON; update toggles each path independently", async () => {
  const s = fakeStore();
  const d = deps(s);
  const created = await svc.approveModel(approval({ upstreamModelId: "u/1" }), "a", d);
  assert.deepEqual(created.usage, { schoolwiseEnabled: true, individualEnabled: true });
  const off = await svc.updateApprovedModel(created.modelKey, { schoolwiseEnabled: false }, "a", d);
  assert.deepEqual(off.usage, { schoolwiseEnabled: false, individualEnabled: true });
  const off2 = await svc.updateApprovedModel(
    created.modelKey,
    { individualEnabled: false, schoolwiseEnabled: true },
    "a",
    d
  );
  assert.deepEqual(off2.usage, { schoolwiseEnabled: true, individualEnabled: false });
  // invalid usage values rejected
  await assert.rejects(
    svc.updateApprovedModel(created.modelKey, { schoolwiseEnabled: "yes" }, "a", d),
    (e) => e.code === "INVALID_REQUEST"
  );
  await assert.rejects(
    svc.approveModel(approval({ upstreamModelId: "u/2", schoolwiseEnabled: 1 }), "a", d),
    (e) => e.code === "INVALID_REQUEST"
  );
});

test("managed eligibility respects usage basis; missing basis unfiltered", async () => {
  const s = fakeStore();
  const d = deps(s);
  await svc.approveModel(
    approval({ upstreamModelId: "m/school-off", displayName: "School Off", enabled: true, studentEnabled: true, schoolwiseEnabled: false }),
    "a",
    d
  );
  await svc.approveModel(
    approval({ upstreamModelId: "m/indiv-off", displayName: "Indiv Off", enabled: true, studentEnabled: true, individualEnabled: false }),
    "a",
    d
  );
  await svc.approveModel(approval({ upstreamModelId: "m/both-on", displayName: "Both On", enabled: true, studentEnabled: true }), "a", d);
  const bySchool = await svc.listEligibleManagedModels("student", { ...d, basis: "school_default_enabled" });
  assert.deepEqual(
    bySchool.map((m) => m.displayName).sort(),
    ["Both On", "Indiv Off"]
  );
  const byIndiv = await svc.listEligibleManagedModels("student", { ...d, basis: "individual_enabled" });
  assert.deepEqual(
    byIndiv.map((m) => m.displayName).sort(),
    ["Both On", "School Off"]
  );
  assert.ok(!byIndiv.some((m) => m.upstreamModelId));
  // legacy: no basis → both visible (backward compatible)
  const legacy = await svc.listEligibleManagedModels("student", d);
  assert.equal(legacy.length, 3);
});

test("managed eligibility AND-semantics; safe projection", async () => {
  const s = fakeStore();
  const d = deps(s);
  await svc.approveModel(approval({ upstreamModelId: "a/1", enabled: true, studentEnabled: true }), "a", d);
  await svc.approveModel(approval({ upstreamModelId: "a/2", enabled: true, teacherEnabled: true }), "a", d);
  await svc.approveModel(approval({ upstreamModelId: "a/3", enabled: false, studentEnabled: true, teacherEnabled: true }), "a", d);
  const st = await svc.listEligibleManagedModels("student", d);
  assert.deepEqual(st.map((m) => m.displayName), ["Claude Sonnet"]);
  const te = await svc.listEligibleManagedModels("teacher", d);
  assert.equal(te.length, 1);
  assert.equal(JSON.stringify(st).includes("upstreamModelId"), false);
  assert.equal(JSON.stringify(st).includes("roles"), false);
  assert.equal(JSON.stringify(st).includes("updatedBy"), false);
  await assert.rejects(svc.listEligibleManagedModels("superadmin", d), (e) => e.code === "INVALID_REQUEST");
});
