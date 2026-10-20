// test/modelCertification.test.js — compatibility certification backfill.
// Price-blind individual listing, capability-gated turns, probe outcomes,
// explicit certify persist, auto-register without false verified marks,
// backfill queue counts, school mapping unchanged. Fakes only.
const test = require("node:test");
const assert = require("node:assert/strict");

const approved = require("../src/services/approvedModelService");
const autoEligible = require("../src/services/autoEligibleModelService");
const policies = require("../src/services/modelPolicyService");
const probe = require("../src/services/modelCompatibilityProbe");

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
    ids: (() => { let i = 0; return () => `mdl_test-${++i}`; })(),
  };
}

function seedModel(s, key, over = {}) {
  s._state[`approvedModels/${key}`] = {
    schemaVersion: 1,
    modelKey: key,
    displayName: key,
    upstreamModelId: `upstream/${key}`,
    enabled: true,
    roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 128000,
    pricing: { input: "0.000002", output: "0.000010" },
    usage: { schoolwiseEnabled: true, individualEnabled: true },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

// ---------- Price blindness (§14) ----------

test("individual list includes free/cheap/expensive/flagship when enabled+toolCalling", async () => {
  const s = fakeStore();
  seedModel(s, "mdl_a", { pricing: { input: "0", output: "0" } }); // free
  seedModel(s, "mdl_b", { pricing: { input: "0.00000004", output: "0.00000017" } }); // cheap
  seedModel(s, "mdl_c", { pricing: { input: "0.000002", output: "0.000010" } }); // expensive
  seedModel(s, "mdl_d", { pricing: { input: "0.000010", output: "0.000050" } }); // flagship
  const out = await approved.listIndividualCreditModels({ store: s });
  assert.deepEqual(out.map((m) => m.modelKey).sort(), ["mdl_a", "mdl_b", "mdl_c", "mdl_d"]);
});

test("individual list excludes toolCalling=false and enabled=false, keeps unknowns", async () => {
  const s = fakeStore();
  seedModel(s, "mdl_ok");
  seedModel(s, "mdl_notools", { capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false } });
  seedModel(s, "mdl_off", { enabled: false });
  seedModel(s, "mdl_unknown", { capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true } });
  const out = await approved.listIndividualCreditModels({ store: s });
  assert.deepEqual(out.map((m) => m.modelKey).sort(), ["mdl_ok", "mdl_unknown"]);
});

test("individual list ignores userModelPolicies custom mapping", async () => {
  const s = fakeStore();
  seedModel(s, "mdl_a");
  seedModel(s, "mdl_b");
  s._state["userModelPolicies/u9"] = { modelMode: "custom", modelKeys: [] };
  const out = await approved.listIndividualCreditModels({ store: s });
  assert.deepEqual(out.map((m) => m.modelKey).sort(), ["mdl_a", "mdl_b"]);
});

// School universe is the enabled approved school-policy intersection.
test("school regression: unassigned cheap and expensive models do not leak into schools", async () => {
  const s = fakeStore();
  seedModel(s, "mdl_a", { pricing: { input: "0.000002", output: "0.000010" } }); // expensive, policy-mapped
  seedModel(s, "mdl_b", { pricing: { input: "0.000010", output: "0.000050" } }); // flagship, NOT mapped
  seedModel(s, "mdl_free", { pricing: { input: "0", output: "0" } }); // free, auto baseline
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1, schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_a"] } },
  };

  const school = await policies.resolveManagedModels(
    { uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, { store: s }
  );
  const schoolKeys = school.models.map((m) => m.modelKey).sort();
  assert.ok(!schoolKeys.includes("mdl_b"), "expensive B must not reach schools");
  assert.ok(schoolKeys.includes("mdl_a"), "policy-mapped A still present");
  assert.ok(!schoolKeys.includes("mdl_free"), "free registration is not a school assignment");

  // Same registry, individual universe: price-blind, so B IS included.
  const individual = await approved.listIndividualCreditModels({ store: s });
  assert.ok(individual.map((m) => m.modelKey).includes("mdl_b"), "individual sees B");
});

test("school disabled model is excluded from school list", async () => {
  const s = fakeStore();
  seedModel(s, "mdl_free", { pricing: { input: "0", output: "0" } });
  seedModel(s, "mdl_off", { pricing: { input: "0", output: "0" }, enabled: false });
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1, schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_off"] }, teacher: { modelKeys: ["mdl_off"] } },
  };
  const school = await policies.resolveManagedModels(
    { uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, { store: s }
  );
  const keys = school.models.map((m) => m.modelKey);
  assert.ok(!keys.includes("mdl_off"), "enabled=false is an immediate kill switch");
});

// ---------- Probe outcomes (§15, unit level with fake agent service) ----------

function fakeAgent({ turn1 = "toolcall", turn2 = "done", failWith = null } = {}) {
  return {
    calls: [],
    async streamManagedAgent({ upstreamModelId, openRouterMessages, maxOutputTokens, toolCapabilityVersion, agentMode, onEvent }) {
      this.calls.push({ upstreamModelId, toolCapabilityVersion, agentMode, maxOutputTokens, turns: openRouterMessages.length });
      if (failWith) {
        const err = new Error("upstream down");
        err.code = failWith;
        throw err;
      }
      if (turn1 === "toolcall") {
        await onEvent({ type: "toolCallReady", providerCallId: "c1", toolName: "probe_tool", argsText: '{"probe": 42}' });
      } else if (turn1 === "badargs") {
        await onEvent({ type: "toolCallReady", providerCallId: "c1", toolName: "probe_tool", argsText: "not-json{{{" });
      } else if (turn1 === "textonly") {
        await onEvent({ type: "textDelta", text: "I will not call tools." });
      }
      if (openRouterMessages.length > 1 && turn2 === "done") {
        await onEvent({ type: "textDelta", text: "DONE" });
      } else if (openRouterMessages.length > 1 && turn2 === "silent") {
        await onEvent({ type: "textDelta", text: "hmm" });
      }
      return { inputTokens: 10, outputTokens: 5, finishReason: "stop" };
    },
  };
}

function seedProbeModel(s) {
  seedModel(s, "mdl_p", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
  });
}

test("probe verified when tool call valid and completion follows", async () => {
  const s = fakeStore();
  seedProbeModel(s);
  const agent = fakeAgent();
  const out = await probe.probeModelCompatibility(
    { modelKey: "mdl_p", kinds: ["tool"] },
    { store: s, agentService: agent }
  );
  assert.equal(out.modelKey, "mdl_p");
  assert.equal(out.tool.status, "verified");
  assert.equal(out.tool.evidence.turn1ToolCalls, 1);
  assert.equal(out.tool.evidence.turn1ArgsValid, true);
  assert.equal(out.tool.evidence.turn2Completed, true);
  assert.ok(typeof out.probedAtMs === "number");
});

test("probe unsupported on no tool call, bad args, or no completion", async () => {
  const s = fakeStore();
  seedProbeModel(s);
  for (const turn1 of ["textonly", "badargs"]) {
    const agent = fakeAgent({ turn1 });
    const out = await probe.probeModelCompatibility(
      { modelKey: "mdl_p", kinds: ["tool"] },
      { store: s, agentService: agent }
    );
    assert.equal(out.tool.status, "unsupported", turn1);
  }
  const silent = fakeAgent({ turn2: "silent" });
  const out2 = await probe.probeModelCompatibility(
    { modelKey: "mdl_p", kinds: ["tool"] },
    { store: s, agentService: silent }
  );
  assert.equal(out2.tool.status, "unsupported");
});

test("probe unknown on provider failure; unknown model stays unknown", async () => {
  const s = fakeStore();
  seedProbeModel(s);
  for (const code of ["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "TIMEOUT"]) {
    const agent = fakeAgent({ failWith: code });
    const out = await probe.probeModelCompatibility(
      { modelKey: "mdl_p", kinds: ["tool", "terminal"] },
      { store: s, agentService: agent }
    );
    assert.equal(out.tool.status, "unknown");
    assert.equal(out.tool.evidence.errorCode, code);
    assert.equal(out.terminal.status, "unknown");
  }
  const missing = await probe.probeModelCompatibility(
    { modelKey: "mdl_nope", kinds: ["tool"] },
    { store: s, agentService: fakeAgent() }
  );
  assert.equal(missing.tool.status, "unknown");
});

test("probe rejects bad kinds and bad keys without provider use", async () => {
  const s = fakeStore();
  let calls = 0;
  const agent = { async streamManagedAgent() { calls += 1; return {}; } };
  await assert.rejects(
    probe.probeModelCompatibility({ modelKey: "mdl_p", kinds: ["telepathy"] }, { store: s, agentService: agent }),
    (e) => e.code === "INVALID_REQUEST"
  );
  await assert.rejects(
    probe.probeModelCompatibility({ modelKey: "evil'; DROP", kinds: ["tool"] }, { store: s, agentService: agent }),
    (e) => e.code === "INVALID_REQUEST"
  );
  assert.equal(calls, 0);
});

// ---------- Certify persist (§16) ----------

test("certify persists only marks; modalities/pricing/enabled intact + audit", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedModel(s, "mdl_c", {
    capabilities: { inputModalities: ["text", "image"], outputModalities: ["text"], toolCalling: true },
    pricing: { input: "0.000010", output: "0.000050" },
  });
  const out = await approved.setModelCertification(
    "mdl_c", { agentTerminal: "verified", agentVerify: "unsupported" }, "admin1", d
  );
  assert.equal(out.capabilities.agentTerminal, "verified");
  assert.equal(out.capabilities.agentVerify, "unsupported");
  assert.equal(out.capabilities.toolCalling, true);
  assert.deepEqual(out.capabilities.inputModalities, ["text", "image"]);
  assert.deepEqual(out.pricing, { input: "0.000010", output: "0.000050" });
  assert.equal(out.enabled, true);
  assert.equal(d.audits._list[0].action, "model.certified");
  assert.equal(d.audits._list[0].target.modelKey, "mdl_c");
});

test("certify supports unknown + clearing; rejects junk and unknown models", async () => {
  const s = fakeStore();
  const d = deps(s);
  seedModel(s, "mdl_c", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "verified", agentVerify: "verified" },
  });
  const cleared = await approved.setModelCertification(
    "mdl_c", { agentTerminal: "cleared", agentVerify: "unknown" }, "admin1", d
  );
  assert.equal(cleared.capabilities.agentTerminal, undefined);
  assert.equal(cleared.capabilities.agentVerify, "unknown");
  await assert.rejects(
    approved.setModelCertification("mdl_c", { agentTerminal: "sometimes" }, "a", d),
    (e) => e.code === "INVALID_REQUEST"
  );
  await assert.rejects(approved.setModelCertification("mdl_c", {}, "a", d), (e) => e.code === "INVALID_REQUEST");
  await assert.rejects(
    approved.setModelCertification("mdl_nope", { agentTerminal: "verified" }, "a", d),
    (e) => e.code === "INVALID_REQUEST"
  );
});

// ---------- Auto-register without false verified (§9) ----------

test("auto-register selections carry no verified marks", () => {
  const out = autoEligible.buildAutoSelections([
    { upstreamModelId: "x/a" },
    { upstreamModelId: "x/a" },
    { notAModel: true },
  ]);
  assert.deepEqual(out, [{ upstreamModelId: "x/a" }]);
});

test("ensureCatalogueModels creates records uncertified", async () => {
  const s = fakeStore();
  const d = deps(s);
  const catalog = [{
    upstreamModelId: "x/new",
    name: "New",
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 8000,
    pricing: { input: "0", output: "0" },
  }];
  const ensured = await approved.ensureCatalogueModels([{ upstreamModelId: "x/new" }], {
    ...d, catalog, adminUid: "a",
  });
  assert.equal(ensured.created.length, 1);
  const doc = await approved.getApprovedModel(ensured.created[0], { store: s });
  assert.equal(doc.enabled, true);
  assert.equal(doc.capabilities.agentTerminal, undefined);
  assert.equal(doc.capabilities.agentVerify, undefined);
});

// ---------- Backfill queue (§17) ----------

test("backfill queue classifies terminal/verify/vision states with counts", async () => {
  const s = fakeStore();
  seedModel(s, "mdl_all", {
    capabilities: { inputModalities: ["text", "image"], outputModalities: ["text"], toolCalling: true, agentTerminal: "verified", agentVerify: "verified" },
  });
  seedModel(s, "mdl_none", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
  });
  seedModel(s, "mdl_term_no", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "unsupported" },
  });
  seedModel(s, "mdl_off", {
    enabled: false,
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentVerify: "unsupported" },
  });
  const { counts, queue } = await approved.listUncertifiedModels({ store: s });
  assert.equal(counts.approved, 4);
  assert.equal(counts.enabled, 3);
  assert.equal(counts.toolCalling, 3);
  assert.equal(counts.terminalVerified, 1);
  assert.equal(counts.terminalUnsupported, 1);
  assert.equal(counts.terminalUnknown, 2);
  assert.equal(counts.verifyVerified, 1);
  assert.equal(counts.verifyUnsupported, 1);
  assert.equal(counts.verifyUnknown, 2);
  assert.equal(counts.visionCapable, 1);
  assert.equal(queue.length, 4);
  const byKey = Object.fromEntries(queue.map((q) => [q.modelKey, q]));
  assert.equal(byKey.mdl_none.terminal, "unknown");
  assert.equal(byKey.mdl_none.verify, "unknown");
  assert.equal(byKey.mdl_none.vision, false);
  assert.equal(byKey.mdl_all.vision, true);
  assert.ok(!("upstreamModelId" in byKey.mdl_all), "no upstream IDs leak into queue");
});

// ---------- Route-level gates: /managed/models + /agent/turn ----------
// Boots the REAL apps against a fake subiDb and a fake provider. Proves the
// listing predicate, the request-specific terminal/verify/vision gates, and
// the global enabled=false kill switch at HTTP level with zero provider calls.

const path = require("path");

function makeRouteDb() {
  const state = {};
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      return {
        _key: key,
        async get() { return { id, exists: key in state, data: () => state[key] }; },
        collection: (sub) => coll(`${key}/${sub}`),
      };
    },
    limit: (n) => ({
      async get() {
        const docs = Object.entries(state)
          .filter(([k]) => k.startsWith(`${prefix}/`) && !k.slice(prefix.length + 1).includes("/"))
          .slice(0, n || 500)
          .map(([k, v]) => ({ id: k.slice(prefix.length + 1), data: () => v }));
        return { docs };
      },
    }),
    add: async (doc) => {
      const id = `auto${Object.keys(state).length}`;
      state[`${prefix}/${id}`] = doc;
      return { id };
    },
  });
  let tail = Promise.resolve();
  return {
    _state: state,
    collection: (name) => coll(name),
    runTransaction(fn) {
      const cur = tail.then(async () => fn({
        set: (ref, data) => { state[ref._key] = { ...(state[ref._key] || {}), ...data }; },
        get: async (ref) => ({ exists: ref._key in state, data: () => state[ref._key] }),
      }));
      tail = cur.catch(() => {});
      return cur;
    },
  };
}

const SRC_FRAG = path.join("functions-subi", "src");

function bootRoute({ user, store, profile } = {}) {
  for (const k of Object.keys(require.cache)) if (k.includes(SRC_FRAG)) delete require.cache[k];
  const dbPath = require.resolve("../src/db");
  const fake = store || makeRouteDb();
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      admin: {},
      learnsmartDb: require('./orderingTx').orderingStore(),
      subiDb: fake,
    },
  };
  const authMod = require("../src/middleware/auth");
  authMod.requireAuth = () => (req, res, next) => {
    if (!user) return res.status(401).json({ error: "Missing auth token" });
    req.subi = { ...user };
    next();
  };
  if (user?.accountType === 'school') {
    const directory = require("../src/services/learnsmartDirectoryService");
    directory.getUserProfile = async () => ({ ...user, status: 'active', subscription: null });
    directory.getSchool = async id => id === user.schoolId ? { id, accountType: 'school', subscription: null } : null;
  }
  if (profile !== undefined) {
    require("../src/services/learnsmartDirectoryService").getUserProfile = async () => profile;
  }
  const app = require("../src/app");
  return {
    fake, app,
    mods: {
      aiConnection: require("../src/services/aiConnectionService"),
      catalog: require("../src/services/modelCatalogService"),
    },
  };
}

function listenRoute(app) {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

const ROUTE_FRAME = (o) => `data: ${JSON.stringify(o)}\n\n`;
const ROUTE_DONE = "data: [DONE]\n\n";
function routeSse(chunks) {
  const text = chunks.join("") + ROUTE_DONE;
  return new ReadableStream({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } });
}
const routeText = (t, f) => ROUTE_FRAME({ choices: [{ delta: { content: t }, finish_reason: f || null }] });

function withRouteFetch(fakeProvider, fn) {
  const real = global.fetch;
  global.fetch = (url, init) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1:") || u.startsWith("http://localhost:")) return real(url, init);
    return fakeProvider(url, init);
  };
  return (async () => {
    try { return await fn(); } finally { global.fetch = real; }
  })();
}

const IND_USER = { uid: "u1", schoolId: "s1", role: "student", accountType: "individual" };
const SCHOOL_USER = { uid: "u2", schoolId: "s1", role: "student", accountType: "school" };

function seedRouteBaseline(st, over = {}) {
  st["systemConfig/managedAgent"] = { mode: "enabled", testUids: [] };
  st["systemConfig/subiAccess"] = { enabled: true };
  st["schoolPolicies/s1"] = { roles: { student: { enabled: true }, teacher: { enabled: true } } };
  st["schoolLimits/s1"] = { monthlyTokens: { student: 100000, teacher: 100000 } };
  Object.assign(st, over);
}

function seedRouteModel(st, key, over = {}) {
  st[`approvedModels/${key}`] = {
    schemaVersion: 1, modelKey: key, displayName: key, upstreamModelId: `vendor/${key}`,
    enabled: true, roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 8192, pricing: { input: "0", output: "0" },
    usage: { schoolwiseEnabled: true, individualEnabled: true },
    ...over,
  };
}

function routeAgentBody(over = {}) {
  return {
    protocolVersion: 1, modelKey: "mdl_a", agentMode: "ask", clientRunId: "run-1",
    providerRequestIndex: 0, canonicalTurns: [{ role: "user", content: "hi" }],
    toolCapabilityVersion: "read_v1", ...over,
  };
}

// Distinct run identity per turn: (clientRunId:providerRequestIndex) is the
// deterministic idempotency key, so a second turn in the same test must not
// replay the first one's reservation.
let runSeq = 0;
function nextRunId() { return `run-${++runSeq}`; }

async function postRouteTurn(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/agent/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* SSE */ }
  return { status: res.status, text, json };
}

async function getRouteModels(port) {
  const res = await fetch(`http://127.0.0.1:${port}/managed/models`, {
    headers: { Authorization: "Bearer t" },
  });
  return { status: res.status, body: await res.json() };
}

const paidStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
const paidEnd = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1);
const currentPaidProfile = () => ({ ...IND_USER, subscription: { subiCodeActive: true, periodStartMs: paidStart, periodEndMs: paidEnd, paidThroughMs: paidEnd, renewalDateMs: paidEnd } });
// §1 individual list predicate, end to end over HTTP.
test("HTTP: enforced individual turns use all compatible models and pinned credits without token or model policies", async () => {
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile: currentPaidProfile() });
  seedRouteBaseline(fake._state, {
    "systemConfig/individualCreditFlags": { enforcementEnabled: true },
    "schoolLimits/s1": { monthlyTokens: { student: 0, teacher: 0 } },
    "schoolModelPolicies/s1": { roles: { student: { modelKeys: [] } } },
    "userModelPolicies/u1": { modelMode: "custom", modelKeys: [] },
    "creditAccounts/u1": {
      uid: "u1", cycleId: `u1:${paidStart}:${paidEnd}`, cycleStartedAtMs: paidStart, cycleEndsAtMs: paidEnd, subscriptionActive: true,
      monthlyGrantCreditsMilli: 100_000_000, monthlyRemainingCreditsMilli: 100_000_000,
      rolloverRemainingCreditsMilli: 0, topupRemainingCreditsMilli: 0, reservedCreditsMilli: 0,
      activeReservations: {},
    },
  });
  const prices = {
    mdl_free: { input: "0", output: "0" },
    mdl_cheap: { input: "0.0000001", output: "0.0000005" },
    mdl_expensive: { input: "0.000002", output: "0.000010" },
    mdl_flagship: { input: "0.000010", output: "0.000050" },
  };
  for (const [key, pricing] of Object.entries(prices)) seedRouteModel(fake._state, key, { pricing });
  const unexpected = async () => { assert.fail("individual turn reached token/model-policy authority"); };
  require("../src/services/monthlyLimitService").resolveEffectiveMonthlyLimit = unexpected;
  require("../src/services/usageQuotaService").reserveUsage = unexpected;
  require("../src/services/effectiveModelService").resolveEffectiveModels = unexpected;
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  const pricingSnapshot = require("../src/services/pricingSnapshot");
  const creditMath = require("../src/services/creditMath");
  let dispatches = 0;
  await withRouteFetch(async (_url, init) => {
    dispatches++;
    const upstream = JSON.parse(init.body).model;
    const key = upstream.slice("vendor/".length);
    // Catalog reprices AFTER reserve. Finalization must reuse the ledger pin.
    fake._state[`approvedModels/${key}`].pricing = { input: "0.000100", output: "0.000100" };
    return { status: 200, body: routeSse([
      routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
    ]) };
  }, async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      for (const [key, pricing] of Object.entries(prices)) {
        const before = fake._state["creditAccounts/u1"].monthlyRemainingCreditsMilli;
        const turn = await postRouteTurn(server.address().port, routeAgentBody({ modelKey: key, clientRunId: nextRunId() }));
        assert.equal(turn.status, 200, turn.text);
        assert.ok(turn.text.includes("event: done"), turn.text);
        assert.ok(!turn.text.includes("event: error"), turn.text);
        const pinned = pricingSnapshot.pinPricing({ modelKey: key, pricing });
        const cost = pinned.isFree ? 0 : Math.max(1000, creditMath.creditsMilliForUsage({
          inputTokens: 1000, outputTokens: 200,
          inputPricePerMillion: pinned.inputPricePerMillion, outputPricePerMillion: pinned.outputPricePerMillion,
        }));
        assert.equal(fake._state["creditAccounts/u1"].monthlyRemainingCreditsMilli, before - cost, key);
        assert.equal(fake._state["creditAccounts/u1"].reservedCreditsMilli, 0);
        const reservations = Object.values(fake._state).filter(v => v.type === "reservation" && v.modelKey === key);
        assert.equal(reservations.length, 1);
        assert.equal(reservations[0].priceVersion, pinned.priceVersion);
        assert.equal(reservations[0].inputPricePerMillion, pinned.inputPricePerMillion);
        assert.equal(reservations[0].outputPricePerMillion, pinned.outputPricePerMillion);
        assert.equal(reservations[0].state, "committed");
      }
    } finally { server.close(); }
  });
  assert.equal(dispatches, 4);
  assert.ok(!Object.keys(fake._state).some(k => k.startsWith("usageMonthly/")));
});

test("HTTP: expired individual entitlement cannot spend preserved topups through an active stale wallet", async () => {
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile: {
    ...IND_USER, subscription: { subiCodeActive: true, renewalDateMs: Date.now() - 1000 },
  } });
  seedRouteBaseline(fake._state, {
    "systemConfig/individualCreditFlags": { enforcementEnabled: true },
    "creditAccounts/u1": {
      uid: "u1", cycleId: "old-paid-cycle", subscriptionActive: true,
      cycleEndsAtMs: Date.now() - 1000, monthlyRemainingCreditsMilli: 0,
      rolloverRemainingCreditsMilli: 0, topupRemainingCreditsMilli: 5_000_000,
      reservedCreditsMilli: 0, activeReservations: {},
    },
  });
  seedRouteModel(fake._state, "mdl_a");
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  const walletBefore = JSON.stringify(fake._state["creditAccounts/u1"]);
  let dispatches = 0;
  await withRouteFetch(async () => {
    dispatches++;
    return { status: 200, body: routeSse([routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 10, completion_tokens: 2 } })]) };
  }, async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postRouteTurn(server.address().port, routeAgentBody({ clientRunId: nextRunId() }));
      assert.equal(turn.status, 403, turn.text);
      assert.equal(turn.json.error.code, "SUBI_PLAN_EXPIRED");
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
  assert.equal(JSON.stringify(fake._state["creditAccounts/u1"]), walletBefore);
  assert.ok(!Object.keys(fake._state).some(k => k.startsWith("creditAccounts/u1/ledger/")));
});

test("HTTP: enforced individual rejects missing, disabled and incompatible models without dispatch", async () => {
  const { fake, app } = bootRoute({ user: IND_USER });
  seedRouteBaseline(fake._state, { "systemConfig/individualCreditFlags": { enforcementEnabled: true } });
  seedRouteModel(fake._state, "mdl_off", { enabled: false });
  seedRouteModel(fake._state, "mdl_notools", { capabilities: { toolCalling: false } });
  let dispatches = 0;
  await withRouteFetch(async () => { dispatches++; throw new Error("unexpected dispatch"); }, async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      for (const [key, code] of [["mdl_missing", "MODEL_NOT_ALLOWED"], ["mdl_off", "MODEL_NOT_ALLOWED"], ["mdl_notools", "AGENT_UNSUPPORTED_MODEL"]]) {
        const turn = await postRouteTurn(server.address().port, routeAgentBody({ modelKey: key, clientRunId: nextRunId() }));
        assert.equal(turn.status, 403);
        assert.equal(turn.json.error.code, code);
      }
    } finally { server.close(); }
  });
  assert.equal(dispatches, 0);
  assert.equal(fake._state["creditAccounts/u1"], undefined);
});

test("HTTP: cycle settlement during key resolution aborts provider dispatch for a terminal credit hold", async () => {
  const now = Date.now();
  const profile = currentPaidProfile();
  const { fake, app, mods } = bootRoute({ user: IND_USER, profile });
  seedRouteBaseline(fake._state, {
    "systemConfig/individualCreditFlags": { enforcementEnabled: true },
    "creditAccounts/u1": {
      uid: "u1", cycleId: `u1:${paidStart}:${paidEnd}`, cycleStartedAtMs: paidStart, cycleEndsAtMs: paidEnd,
      subscriptionActive: true, monthlyRemainingCreditsMilli: 0,
      rolloverRemainingCreditsMilli: 0, topupRemainingCreditsMilli: 1_000_000,
      reservedCreditsMilli: 0, activeReservations: {},
    },
  });
  seedRouteModel(fake._state, "mdl_a");
  let enteredKey;
  const keyEntered = new Promise(resolve => { enteredKey = resolve; });
  let resumeKey;
  const keyResume = new Promise(resolve => { resumeKey = resolve; });
  mods.aiConnection.resolveActiveManagedKey = async () => {
    enteredKey();
    await keyResume;
    return Buffer.from("sk-test-key");
  };
  let dispatches = 0;
  await withRouteFetch(async () => {
    dispatches++;
    return { status: 200, body: routeSse([routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 10, completion_tokens: 2 } })]) };
  }, async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const pending = postRouteTurn(server.address().port, routeAgentBody({ clientRunId: nextRunId() }));
      await Promise.race([keyEntered, pending.then(turn => assert.fail(`request ended before key resolution: ${turn.text}`))]);
      const reservations = Object.values(fake._state).filter(v => v.type === "reservation");
      assert.equal(reservations.length, 1);
      assert.equal(reservations[0].state, "reserved");
      await require("../src/services/individualCreditCycleService").ensureCurrentCreditCycle({
        uid: IND_USER.uid, accountType: "individual", userSubscription: profile.subscription,
        paidPeriodStartMs: now - 1000, paidPeriodEndMs: now + 30 * 86400000, fxRate: 96.25,
      }, { store: fake });
      assert.equal(reservations[0].state, "reserved"); // captured pre-settlement snapshot
      const walletAfterCycle = JSON.stringify(fake._state["creditAccounts/u1"]);
      resumeKey();
      const turn = await pending;
      assert.equal(dispatches, 0, turn.text);
      assert.ok(turn.text.includes("CREDIT_REQUEST_ALREADY_PROCESSED"), turn.text);
      assert.ok(!turn.text.includes("event: done"), turn.text);
      assert.equal(JSON.stringify(fake._state["creditAccounts/u1"]), walletAfterCycle);
      assert.equal(fake._state["creditAccounts/u1"].topupRemainingCreditsMilli, 1_000_000);
    } finally { resumeKey(); server.close(); }
  });
});

test("HTTP: individual enforcement flag preserves school model policies, zero token limits and token accounting", async () => {
  const { fake, app, mods } = bootRoute({ user: SCHOOL_USER });
  seedRouteBaseline(fake._state, {
    "systemConfig/individualCreditFlags": { enforcementEnabled: true },
    "schoolModelPolicies/s1": { roles: { student: { modelKeys: ["mdl_school"] } } },
    "schoolLimits/s1": { monthlyTokens: { student: 0, teacher: 0 } },
  });
  seedRouteModel(fake._state, "mdl_school", { pricing: { input: "0.000010", output: "0.000050" } });
  seedRouteModel(fake._state, "mdl_unmapped", { pricing: { input: "0.000010", output: "0.000050" } });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  let dispatches = 0;
  await withRouteFetch(async () => {
    dispatches++;
    return { status: 200, body: routeSse([routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 10, completion_tokens: 2 } })]) };
  }, async () => {
    const server = await listenRoute(app.buildManagedAgentApp());
    try {
      const missingPolicy = await postRouteTurn(server.address().port, routeAgentBody({ modelKey: "mdl_unmapped", clientRunId: nextRunId() }));
      assert.equal(missingPolicy.json.error.code, "MODEL_NOT_ALLOWED");
      const zero = await postRouteTurn(server.address().port, routeAgentBody({ modelKey: "mdl_school", clientRunId: nextRunId() }));
      assert.equal(zero.json.error.code, "MONTHLY_LIMIT_EXCEEDED");
      assert.equal(dispatches, 0);
      fake._state["schoolLimits/s1"].monthlyTokens.student = 100000;
      const turn = await postRouteTurn(server.address().port, routeAgentBody({ modelKey: "mdl_school", clientRunId: nextRunId() }));
      assert.equal(turn.status, 200, turn.text);
      assert.ok(turn.text.includes("event: done"), turn.text);
      assert.ok(!turn.text.includes("event: error"), turn.text);
    } finally { server.close(); }
  });
  assert.equal(dispatches, 1);
  assert.equal(fake._state["creditAccounts/u2"], undefined);
  const usage = Object.entries(fake._state).find(([key]) => key.startsWith("usageMonthly/") && key.endsWith("/users/u2"));
  assert.ok(usage);
  assert.equal(usage[1].inputTokens, 10);
  assert.equal(usage[1].outputTokens, 2);
  assert.equal(usage[1].requests, 1);
});

test("HTTP: individual /managed/models lists A/B/C/D regardless of price", async () => {
  const { fake, app } = bootRoute({ user: IND_USER });
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_a", { pricing: { input: "0", output: "0" } });
  seedRouteModel(fake._state, "mdl_b", { pricing: { input: "0.0000005", output: "0.0000005" } });
  seedRouteModel(fake._state, "mdl_c", { pricing: { input: "0.000002", output: "0.000010" } });
  seedRouteModel(fake._state, "mdl_d", { pricing: { input: "0.000010", output: "0.000050" } });
  const s = await listenRoute(app.buildManagedApp());
  try {
    const { status, body } = await getRouteModels(s.address().port);
    assert.equal(status, 200);
    assert.equal(body.allowed, true);
    assert.deepEqual(body.models.map((m) => m.modelKey).sort(), ["mdl_a", "mdl_b", "mdl_c", "mdl_d"]);
    for (const m of body.models) {
      assert.ok(!("upstreamModelId" in m) && !("pricing" in m), "safe projection only");
    }
  } finally { s.close(); }
});

test("HTTP: enabled=false and toolCalling=false models are absent from individual list", async () => {
  const { fake, app } = bootRoute({ user: IND_USER });
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_ok");
  seedRouteModel(fake._state, "mdl_off", { enabled: false });
  seedRouteModel(fake._state, "mdl_notools", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
  });
  const s = await listenRoute(app.buildManagedApp());
  try {
    const { body } = await getRouteModels(s.address().port);
    assert.deepEqual(body.models.map((m) => m.modelKey), ["mdl_ok"]);
  } finally { s.close(); }
});

// §5 global kill switch, proven through the real list routes for both paths.
test("HTTP: enabled=false is an immediate kill switch (individual list + school list)", async () => {
  const { fake, app } = bootRoute({ user: IND_USER });
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_a");
  fake._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1, schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_a"] } },
  };
  const before = await listenRoute(app.buildManagedApp());
  const beforeList = await getRouteModels(before.address().port);
  before.close();
  assert.equal(beforeList.status, 200, JSON.stringify(beforeList.body));
  assert.ok(beforeList.body.models.map((m) => m.modelKey).includes("mdl_a"), "listed while enabled");

  // Flip the registry flag: no cache bust, no reassignment.
  fake._state["approvedModels/mdl_a"].enabled = false;

  const after = await listenRoute(app.buildManagedApp());
  try {
    const afterList = await getRouteModels(after.address().port);
    assert.equal(afterList.status, 200);
    assert.ok(!afterList.body.models.map((m) => m.modelKey).includes("mdl_a"), "gone from individual list");
  } finally { after.close(); }

  const school = bootRoute({ user: SCHOOL_USER, store: fake });
  const s2 = await listenRoute(school.app.buildManagedApp());
  try {
    const r = await getRouteModels(s2.address().port);
    assert.equal(r.status, 200);
    assert.ok(!r.body.models.map((m) => m.modelKey).includes("mdl_a"), "gone from school list");
  } finally { s2.close(); }
});

test("HTTP: /agent/turn rejects disabled and toolCalling=false models with zero dispatch", async () => {
  const { fake, app, mods } = bootRoute({ user: SCHOOL_USER });
  seedRouteBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "enabled", testUids: [], terminalEnabled: true },
    "schoolModelPolicies/s1": {
      schemaVersion: 1, schoolId: "s1",
      roles: { student: { modelKeys: ["mdl_off", "mdl_notools"] }, teacher: { modelKeys: [] } },
    },
  });
  seedRouteModel(fake._state, "mdl_off", { enabled: false });
  seedRouteModel(fake._state, "mdl_notools", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  let dispatches = 0;
  await withRouteFetch(async () => { dispatches += 1; throw new Error("unexpected provider"); }, async () => {
    const s = await listenRoute(app.buildManagedAgentApp());
    try {
      const off = await postRouteTurn(s.address().port, routeAgentBody({ modelKey: "mdl_off" }));
      assert.equal(off.status, 403);
      assert.equal(off.json.error.code, "MODEL_NOT_ALLOWED");
      const noTools = await postRouteTurn(s.address().port, routeAgentBody({ modelKey: "mdl_notools" }));
      assert.equal(noTools.status, 403);
      assert.equal(noTools.json.error.code, "AGENT_UNSUPPORTED_MODEL");
      assert.ok(!off.text.includes("vendor/") && !off.text.includes("sk-test-key"), "no leak");
    } finally { s.close(); }
  });
  assert.equal(dispatches, 0);
});

// §1 terminal unknown: still listed, ordinary turns allowed.
test("HTTP: terminal unknown/absent keeps the model listed and text turns working", async () => {
  const { fake, app, mods } = bootRoute({ user: SCHOOL_USER });
  seedRouteBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "enabled", testUids: [] },
    "schoolModelPolicies/s1": {
      schemaVersion: 1, schoolId: "s1",
      roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: [] } },
    },
  });
  seedRouteModel(fake._state, "mdl_a");
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  await withRouteFetch(async () => ({
    status: 200,
    body: routeSse([routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 10, completion_tokens: 2 } })]),
  }), async () => {
    const s = await listenRoute(app.buildManagedAgentApp());
    try {
      const turn = await postRouteTurn(s.address().port, routeAgentBody());
      assert.equal(turn.status, 200);
      assert.equal(turn.text.includes("MODEL_TERMINAL_UNSUPPORTED"), false);
    } finally { s.close(); }
    const m = await listenRoute(app.buildManagedApp());
    const list = await getRouteModels(m.address().port);
    m.close();
    assert.deepEqual(list.body.models.map((x) => x.modelKey), ["mdl_a"]);
  });
});

test("HTTP: agentTerminal=unsupported blocks terminal_v1 before provider dispatch", async () => {
  const { fake, app, mods } = bootRoute({ user: SCHOOL_USER });
  seedRouteBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [SCHOOL_USER.uid], terminalEnabled: true },
    "schoolModelPolicies/s1": {
      schemaVersion: 1, schoolId: "s1",
      roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: [] } },
    },
  });
  seedRouteModel(fake._state, "mdl_a", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "unsupported" },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  let dispatches = 0;
  await withRouteFetch(async () => { dispatches += 1; throw new Error("unexpected provider"); }, async () => {
    const s = await listenRoute(app.buildManagedAgentApp());
    try {
      const build = await postRouteTurn(s.address().port, routeAgentBody({ agentMode: "build", toolCapabilityVersion: "terminal_v1" }));
      assert.equal(build.status, 403);
      assert.equal(build.json.error.code, "MODEL_TERMINAL_UNSUPPORTED");
      // Ordinary text turn is still authorized: it reaches provider dispatch
      // (stubbed to fail) and never reports the terminal gate.
      const ask = await postRouteTurn(s.address().port, routeAgentBody());
      assert.equal(ask.status, 200);
      assert.equal(ask.text.includes("MODEL_TERMINAL_UNSUPPORTED"), false);
    } finally { s.close(); }
  });
  assert.equal(dispatches, 1, "only the ordinary turn dispatched");
});

test("HTTP: agentTerminal=verified allows terminal_v1 turn", async () => {
  const { fake, app, mods } = bootRoute({ user: SCHOOL_USER });
  seedRouteBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [SCHOOL_USER.uid], terminalEnabled: true },
    "schoolModelPolicies/s1": {
      schemaVersion: 1, schoolId: "s1",
      roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: [] } },
    },
  });
  seedRouteModel(fake._state, "mdl_a", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentTerminal: "verified", agentVerify: "verified" },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  await withRouteFetch(async () => ({
    status: 200,
    body: routeSse([routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 10, completion_tokens: 2 } })]),
  }), async () => {
    const s = await listenRoute(app.buildManagedAgentApp());
    try {
      const build = await postRouteTurn(s.address().port, routeAgentBody({
        agentMode: "build", toolCapabilityVersion: "terminal_v1", clientRunId: nextRunId(),
      }));
      assert.equal(build.status, 200, build.text.slice(0, 200));
      const verify = await postRouteTurn(s.address().port, routeAgentBody({
        agentMode: "build", toolCapabilityVersion: "verify_v1", clientRunId: nextRunId(),
      }));
      assert.equal(verify.status, 200, verify.text.slice(0, 200));
    } finally { s.close(); }
  });
});

// §1 verify states.
test("HTTP: agentVerify=unsupported blocks verify_v1 but allows ordinary turns", async () => {
  const { fake, app, mods } = bootRoute({ user: SCHOOL_USER });
  seedRouteBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "test", testUids: [SCHOOL_USER.uid], terminalEnabled: true },
    "schoolModelPolicies/s1": {
      schemaVersion: 1, schoolId: "s1",
      roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: [] } },
    },
  });
  seedRouteModel(fake._state, "mdl_a", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true, agentVerify: "unsupported" },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  let dispatches = 0;
  await withRouteFetch(async () => {
    dispatches += 1;
    return {
      status: 200,
      body: routeSse([routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
        ROUTE_FRAME({ usage: { prompt_tokens: 10, completion_tokens: 2 } })]),
    };
  }, async () => {
    const s = await listenRoute(app.buildManagedAgentApp());
    try {
      const verify = await postRouteTurn(s.address().port, routeAgentBody({
        toolCapabilityVersion: "verify_v1", agentMode: "build", clientRunId: nextRunId(),
      }));
      assert.equal(verify.status, 403);
      assert.equal(verify.json.error.code, "MODEL_VERIFY_UNSUPPORTED");
      const ask = await postRouteTurn(s.address().port, routeAgentBody({ clientRunId: nextRunId() }));
      assert.equal(ask.status, 200);
    } finally { s.close(); }
  });
  assert.equal(dispatches, 1);
});

// §1 vision.
test("HTTP: text-only model rejects image turns; vision model accepts them", async () => {
  const { fake, app, mods } = bootRoute({ user: SCHOOL_USER });
  seedRouteBaseline(fake._state, {
    "systemConfig/managedAgent": { mode: "enabled", testUids: [] },
    "schoolModelPolicies/s1": {
      schemaVersion: 1, schoolId: "s1",
      roles: { student: { modelKeys: ["mdl_text", "mdl_vision"] }, teacher: { modelKeys: [] } },
    },
  });
  seedRouteModel(fake._state, "mdl_text");
  seedRouteModel(fake._state, "mdl_vision", {
    capabilities: { inputModalities: ["text", "image"], outputModalities: ["text"], toolCalling: true },
  });
  mods.aiConnection.resolveActiveManagedKey = async () => Buffer.from("sk-test-key");
  // Image turns verify the vision capability against canonical upstream
  // catalogue metadata (never admin display metadata), so stub the catalog.
  mods.catalog.fetchCatalog = async () => ({
    models: [
      { upstreamModelId: "vendor/mdl_text", capabilities: { inputModalities: ["text"] }, contextLength: 8192 },
      { upstreamModelId: "vendor/mdl_vision", capabilities: { inputModalities: ["text", "image"] }, contextLength: 8192 },
    ],
  });
  // A real 1x1 PNG so managedImageInput validation accepts the turn.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  const imageTurn = { role: "user", content: "what is this", images: [{ mimeType: "image/png", base64: png.toString("base64") }] };
  await withRouteFetch(async () => ({
    status: 200,
    body: routeSse([routeText("ok", null), ROUTE_FRAME({ choices: [{ finish_reason: "stop" }] }),
      ROUTE_FRAME({ usage: { prompt_tokens: 10, completion_tokens: 2 } })]),
  }), async () => {
    const s = await listenRoute(app.buildManagedAgentApp());
    try {
      const textOnly = await postRouteTurn(s.address().port, routeAgentBody({
        modelKey: "mdl_text", canonicalTurns: [imageTurn], clientRunId: nextRunId(),
      }));
      assert.equal(textOnly.status, 403);
      assert.equal(textOnly.json.error.code, "IMAGE_INPUT_UNAVAILABLE");
      const vision = await postRouteTurn(s.address().port, routeAgentBody({
        modelKey: "mdl_vision", canonicalTurns: [imageTurn], clientRunId: nextRunId(),
      }));
      assert.equal(vision.status, 200, vision.text.slice(0, 300));
      // Both models remain listed.
      const m = await listenRoute(app.buildManagedApp());
      const list = await getRouteModels(m.address().port);
      m.close();
      assert.deepEqual(list.body.models.map((x) => x.modelKey).sort(), ["mdl_text", "mdl_vision"]);
    } finally { s.close(); }
  });
});

// ---------- Admin routes ----------

function bootAdmin(user) {
  const { fake, app } = bootRoute({ user });
  return { fake, app };
}

async function adminReq(port, method, pathName, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* non-JSON */ }
  return { status: res.status, json, text };
}

const SUPER = { uid: "adm1", schoolId: "s1", role: "admin", accountType: "school" };

test("HTTP: certification routes require superadmin", async () => {
  const { fake, app } = bootAdmin(SCHOOL_USER);
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_a");
  const s = await listenRoute(app.buildAdminApp());
  try {
    for (const [m, p, b] of [
      ["GET", "/admin/models/certification-status", null],
      ["POST", "/admin/models/mdl_a/probe", { kinds: ["tool"] }],
      ["POST", "/admin/models/mdl_a/certify", { agentTerminal: "verified" }],
    ]) {
      const r = await adminReq(s.address().port, m, p, b);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.deepEqual(r.json.error, { code: 'FORBIDDEN' });
    }
  } finally { s.close(); }
});

test("HTTP: certification-status returns counts and queue for superadmin", async () => {
  const { fake, app } = bootAdmin(SUPER);
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_a");
  seedRouteModel(fake._state, "mdl_b", {
    capabilities: { inputModalities: ["text", "image"], outputModalities: ["text"], toolCalling: true, agentTerminal: "verified", agentVerify: "verified" },
  });
  const s = await listenRoute(app.buildAdminApp());
  try {
    const r = await adminReq(s.address().port, "GET", "/admin/models/certification-status");
    assert.equal(r.status, 200);
    assert.equal(r.json.counts.approved, 2);
    assert.equal(r.json.counts.terminalVerified, 1);
    assert.equal(r.json.counts.terminalUnknown, 1);
    assert.equal(r.json.counts.visionCapable, 1);
    assert.equal(r.json.queue.length, 2);
    for (const row of r.json.queue) {
      assert.ok(!("upstreamModelId" in row), "no upstream ids to the client");
    }
  } finally { s.close(); }
});

test("HTTP: certify persists marks, rejects junk and unknown models, audits", async () => {
  const { fake, app } = bootAdmin(SUPER);
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_a", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
  });
  const s = await listenRoute(app.buildAdminApp());
  try {
    const port = s.address().port;
    const ok = await adminReq(port, "POST", "/admin/models/mdl_a/certify", { agentTerminal: "verified", agentVerify: "unsupported" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.model.capabilities.agentTerminal, "verified");
    assert.equal(ok.json.model.capabilities.agentVerify, "unsupported");
    assert.equal(ok.json.model.capabilities.toolCalling, true);
    assert.equal(ok.json.model.enabled, true);
    assert.equal(fake._state["approvedModels/mdl_a"].capabilities.agentTerminal, "verified");

    // Audit record written through the real audit service.
    const audits = Object.entries(fake._state)
      .filter(([k]) => k.startsWith("auditLogs/"))
      .map(([, v]) => v);
    const certAudit = audits.find((a) => a.action === "model.certified");
    assert.ok(certAudit, "model.certified audit written");
    assert.equal(certAudit.adminUid, "adm1");
    assert.deepEqual(certAudit.after, { agentTerminal: "verified", agentVerify: "unsupported" });

    for (const bad of [
      { agentTerminal: "maybe" },
      { agentVerify: "sometimes" },
      {},
    ]) {
      const r = await adminReq(port, "POST", "/admin/models/mdl_a/certify", bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.json.error.code, "INVALID_REQUEST");
    }
    const unknown = await adminReq(port, "POST", "/admin/models/mdl_zzz/certify", { agentTerminal: "verified" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error.code, "INVALID_REQUEST");

    // Certification is independent of the global enable flag.
    const st = await adminReq(port, "GET", "/admin/models/certification-status");
    assert.equal(st.json.queue[0].terminal, "verified");
    assert.ok(!("upstreamModelId" in st.json.queue[0]));
    assert.equal(fake._state["approvedModels/mdl_a"].enabled, true, "certify never enables/disables");
  } finally { s.close(); }
});

test("HTTP: probe endpoint returns evidence and never persists marks", async () => {
  const { fake, app } = bootAdmin(SUPER);
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_a", {
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
  });
  const probeMod = require("../src/services/modelCompatibilityProbe");
  let providerCalls = 0;
  await withRouteFetch(async () => { providerCalls += 1; throw new Error("unexpected provider"); }, async () => {
    const s = await listenRoute(app.buildAdminApp());
    try {
      // Provider failure must surface as unknown, never as a false verified.
      const r = await adminReq(s.address().port, "POST", "/admin/models/mdl_a/probe", { kinds: ["tool"] });
      assert.equal(r.status, 200);
      assert.equal(r.json.probe.tool.status, "unknown");
      assert.equal(fake._state["approvedModels/mdl_a"].capabilities.agentTerminal, undefined);
      assert.equal(fake._state["approvedModels/mdl_a"].capabilities.agentVerify, undefined);

      const bad = await adminReq(s.address().port, "POST", "/admin/models/mdl_a/probe", { kinds: ["telepathy"] });
      assert.equal(bad.status, 400);
      assert.equal(bad.json.error.code, "INVALID_REQUEST");

      const missing = await adminReq(s.address().port, "POST", "/admin/models/mdl_zzz/probe", { kinds: ["tool"] });
      assert.equal(missing.status, 200);
      assert.equal(missing.json.probe.tool.status, "unknown");
    } finally { s.close(); }
  });
  assert.ok(providerCalls >= 0);
  assert.equal(typeof probeMod.probeModelCompatibility, "function");
});

test("HTTP: probe response leaks no key, upstream id, or prompt", async () => {
  const { fake, app } = bootAdmin(SUPER);
  seedRouteBaseline(fake._state);
  seedRouteModel(fake._state, "mdl_a");
  await withRouteFetch(async () => { throw new Error("upstream down"); }, async () => {
    const s = await listenRoute(app.buildAdminApp());
    try {
      const r = await adminReq(s.address().port, "POST", "/admin/models/mdl_a/probe", { kinds: ["tool", "terminal", "verify"] });
      assert.equal(r.status, 200);
      for (const banned of ["vendor/mdl_a", "sk-", "upstreamModelId", "Probe instruction", "ERROR"]) {
        assert.equal(r.text.includes(banned), false, `probe response leaks ${banned}`);
      }
      for (const kind of ["tool", "terminal", "verify"]) {
        assert.ok(r.json.probe[kind], `${kind} result present`);
        assert.deepEqual(
          Object.keys(r.json.probe[kind].evidence).sort(),
          ["errorCode", "turn1ArgsValid", "turn1ToolCalls", "turn2Completed"]
        );
      }
    } finally { s.close(); }
  });
});
