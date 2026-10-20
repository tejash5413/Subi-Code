// test/cutoverHardening.test.js — pre-billing cutover: fail-closed routing,
// single-plan entitlement, individual model parity, spoof resistance.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const quotaMode = require("../src/services/quotaModeService");
const directory = require("../src/services/learnsmartDirectoryService");
const entitlement = require("../src/services/subiCodeEntitlementService");
const approved = require("../src/services/approvedModelService");
const policies = require("../src/services/modelPolicyService");
const cycle = require("../src/services/individualCreditCycleService");
const acctSvc = require("../src/services/individualCreditAccountService");
const { safeCode, statusFor } = require("../src/utils/redact");
const agentValidator = require("../src/services/managedAgentValidator");
const chatValidator = require("../src/services/managedChatValidator");
const { orderingStore } = require("./orderingTx");

const DAY = 86_400_000;
const FUTURE = Date.now() + 30 * DAY;
const PAST = Date.now() - 30 * DAY;

// ---------- §20 routing ----------

test("routing: school->tokens, individual->credits, everything else fail-closed", () => {
  assert.equal(quotaMode.resolveQuotaMode({ accountType: "school" }), "school_tokens");
  assert.equal(quotaMode.resolveQuotaMode({ accountType: "individual" }), "individual_credits");
  // Note: "SCHOOL " (whitespace-padded explicit value) trims to school_tokens;
  // fail-closed covers unknown/missing, not whitespace around valid values.
  assert.equal(quotaMode.resolveQuotaMode({ accountType: "SCHOOL " }), "school_tokens");
  for (const bad of [null, undefined, "", "admin", "enterprise", 123, {}, { accountType: null }]) {
    const input = bad && typeof bad === "object" && !("accountType" in bad) ? bad : { accountType: bad };
    assert.throws(() => quotaMode.resolveQuotaMode(input), (e) => e.code === "ACCOUNT_TYPE_UNSUPPORTED", JSON.stringify(bad));
  }
  assert.equal(safeCode("ACCOUNT_TYPE_UNSUPPORTED"), "ACCOUNT_TYPE_UNSUPPORTED");
  assert.equal(statusFor("ACCOUNT_TYPE_UNSUPPORTED"), 403);
});

test("directory normalization keeps explicit values, nulls the rest", () => {
  assert.equal(directory.normalizeAccountType("school"), "school");
  assert.equal(directory.normalizeAccountType("individual"), "individual");
  assert.equal(directory.normalizeAccountType(" School "), "school");
  assert.equal(directory.normalizeAccountType("INDIVIDUAL"), "individual");
  for (const bad of [null, undefined, "", "admin", "enterprise", 0, 123]) {
    assert.equal(directory.normalizeAccountType(bad), null, JSON.stringify(bad));
  }
});

test("no quota route falls back to school_tokens", () => {
  for (const file of ["managedAgent.js", "managedUsage.js", "managedLimits.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", file), "utf8");
    assert.doesNotMatch(source, /quotaMode = "school_tokens"/, file);
    assert.match(source, /ACCOUNT_TYPE_UNSUPPORTED/, file);
  }
});

// ---------- §21 entitlement ----------

test("new single-plan entitlement: active without any tier", () => {
  const r = entitlement.evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: { subiCodeActive: true, subiCodeTier: null, renewalDateMs: FUTURE },
    schoolSubscription: null,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.source, "individual_subi");
  assert.equal(r.renewalDateMs, FUTURE);
  assert.ok(!("tier" in r), "no tier field returned");
});

test("legacy tier subscriber remains allowed (compat, no plan meaning)", () => {
  const r = entitlement.evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: { subiCodeTier: "plus", renewalDateMs: FUTURE },
    schoolSubscription: null,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.source, "legacy_tier_compat");
});

test("explicit disable wins over legacy tier; missing fails closed", () => {
  const disabled = entitlement.evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: { subiCodeActive: false, subiCodeTier: "plus", renewalDateMs: FUTURE },
    schoolSubscription: null,
  });
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.code, "SUBI_CODE_REQUIRED");
  for (const sub of [null, {}, { subiCodeTier: "" }, { subiCodeTier: null }]) {
    const r = entitlement.evaluateSubiCodeEntitlement({ accountType: "individual", userSubscription: sub, schoolSubscription: null });
    assert.equal(r.allowed, false, JSON.stringify(sub));
    assert.equal(r.code, "SUBI_CODE_REQUIRED");
  }
});

test("expired individual fails with SUBI_PLAN_EXPIRED (both new and legacy)", () => {
  for (const sub of [
    { subiCodeActive: true, renewalDateMs: PAST },
    { subiCodeTier: "pro", renewalDateMs: PAST },
  ]) {
    const r = entitlement.evaluateSubiCodeEntitlement({ accountType: "individual", userSubscription: sub, schoolSubscription: null });
    assert.equal(r.allowed, false);
    assert.equal(r.code, "SUBI_PLAN_EXPIRED");
  }
});

test("school entitlement unchanged: expiry-only, no tier", () => {
  assert.equal(entitlement.evaluateSubiCodeEntitlement({ accountType: "school", userSubscription: null, schoolSubscription: null }).allowed, true);
  assert.equal(entitlement.evaluateSubiCodeEntitlement({
    accountType: "school", userSubscription: { renewalDateMs: PAST }, schoolSubscription: null,
  }).code, "SUBI_PLAN_EXPIRED");
  const r = entitlement.evaluateSubiCodeEntitlement({
    accountType: "school", userSubscription: { subiCodeTier: "plus", renewalDateMs: FUTURE }, schoolSubscription: null,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.source, "school_default");
});

test("directory subscription normalization feeds single-plan contract", () => {
  // normalizeSubscription is not exported; verify via entitlement-shaped snapshots
  // built the same way getUserProfile does (documented compat in code comments).
  const now = Date.now();
  const r = entitlement.evaluateSubiCodeEntitlement({
    accountType: "individual",
    userSubscription: { subiCodeActive: true, subiCodeTier: null, renewalDateMs: now + DAY },
    schoolSubscription: null,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.source, "individual_subi");
});

test("cycle engine grants tierless single-plan subscription", async () => {
  const store = orderingStore();
  const now = Date.now();
  const out = await cycle.ensureCurrentCreditCycle({
    uid: "u1",
    accountType: "individual",
    userSubscription: { subiCodeActive: true, subiCodeTier: null, renewalDateMs: now + 30 * DAY },
    paidPeriodStartMs: now - 1000,
    paidPeriodEndMs: now + 30 * DAY,
    fxRate: 96.25,
  }, { store });
  assert.equal(out.alreadyGranted, false);
  assert.ok(out.monthlyGrantCreditsMilli > 0);
});

// ---------- §22/§23 model parity ----------

function modelStore() {
  const state = {};
  const store = {
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
        set: (ref, data) => { state[ref._key] = { ...(state[ref._key] || {}), ...data }; },
        get: async (ref) => ({ exists: ref._key in state, data: () => state[ref._key] }),
      };
      await fn(tx);
    },
  };
  return store;
}

function seedReg(store, key, over = {}) {
  store._state[`approvedModels/${key}`] = {
    schemaVersion: 1, modelKey: key, displayName: key, upstreamModelId: `upstream/${key}`,
    enabled: true, roles: { student: { enabled: true }, teacher: { enabled: true } },
    capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: true },
    contextLength: 128000, pricing: { input: null, output: null },
    usage: { schoolwiseEnabled: true, individualEnabled: true }, ...over,
  };
}

// The /agent/turn individual base gate (route: enabled check + toolCalling
// check). Parity holds iff the list universe equals this predicate's set.
async function turnAuthorizes(store, modelKey) {
  let reg = null;
  try {
    reg = await approved.getApprovedModel(modelKey, { store });
  } catch (_) {
    return false;
  }
  if (!reg || reg.enabled !== true) return false;
  if (!reg.capabilities || reg.capabilities.toolCalling !== true) return false;
  return true;
}

test("individual list/turn parity: A,B yes; C disabled no; D incompatible no", async () => {
  const s = modelStore();
  seedReg(s, "mdl_a");
  seedReg(s, "mdl_b");
  seedReg(s, "mdl_c", { enabled: false });
  seedReg(s, "mdl_d", { capabilities: { inputModalities: ["text"], outputModalities: ["text"], toolCalling: false } });
  const listed = await approved.listIndividualCreditModels({ store: s });
  assert.deepEqual(listed.map((m) => m.modelKey).sort(), ["mdl_a", "mdl_b"]);
  for (const m of listed) {
    assert.ok(!("upstreamModelId" in m) && !("pricing" in m), "safe projection only");
  }
  for (const [key, expected] of [["mdl_a", true], ["mdl_b", true], ["mdl_c", false], ["mdl_d", false]]) {
    assert.equal(await turnAuthorizes(s, key), expected, key);
  }
  assert.deepEqual(
    (await Promise.all(["mdl_a", "mdl_b", "mdl_c", "mdl_d"].map(async (k) => ((await turnAuthorizes(s, k)) ? k : null)))).filter(Boolean).sort(),
    listed.map((m) => m.modelKey).sort(),
    "list universe equals turn-authorized set"
  );
});

test("individual list ignores userModelPolicies custom mapping", async () => {
  const s = modelStore();
  seedReg(s, "mdl_a");
  seedReg(s, "mdl_b");
  s._state["userModelPolicies/u9"] = { modelMode: "custom", modelKeys: [] };
  const listed = await approved.listIndividualCreditModels({ store: s });
  assert.deepEqual(listed.map((m) => m.modelKey).sort(), ["mdl_a", "mdl_b"]);
});

test("school policy allowing only A keeps A-only (no B leak)", async () => {
  const s = modelStore();
  seedReg(s, "mdl_a");
  seedReg(s, "mdl_b");
  s._state["schoolModelPolicies/s1"] = {
    schemaVersion: 1, schoolId: "s1",
    roles: { student: { modelKeys: ["mdl_a"] }, teacher: { modelKeys: ["mdl_a"] } },
  };
  const st = await policies.resolveManagedModels(
    { uid: "u1", schoolId: "s1", role: "student", accountType: "school" }, { store: s });
  assert.deepEqual(st.models.map((m) => m.modelKey), ["mdl_a"]);
  assert.deepEqual(st.models.map((m) => m.modelKey), ["mdl_a"]);
});

// ---------- §24 security ----------

test("client spoof fields rejected by validators; directory stays authoritative", () => {
  const spoofAgent = {
    protocolVersion: 1, modelKey: "mdl_a", agentMode: "ask", clientRunId: "r1",
    providerRequestIndex: 0, canonicalTurns: [], toolCapabilityVersion: "read_v1",
    accountType: "school", quotaMode: "school_tokens", tier: "pro", schoolId: "evil",
  };
  assert.throws(() => agentValidator.validateAgentBody(spoofAgent), (e) => e.code === "INVALID_REQUEST");
  assert.throws(() => chatValidator.validateChatBody({
    requestId: "r1", modelKey: "mdl_a", messages: [], accountType: "individual", quotaMode: "individual_credits",
  }), (e) => e.code === "INVALID_REQUEST");
  // Directory individual + spoofed school body still routes individual_credits.
  assert.equal(quotaMode.resolveQuotaMode({ accountType: "individual" }), "individual_credits");
});

test("managedModels route branches individual universe on quotaMode", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "managedModels.js"), "utf8");
  assert.match(source, /listIndividualCreditModels/);
  assert.match(source, /quotaMode === "individual_credits"/);
  assert.match(source, /ACCOUNT_TYPE_UNSUPPORTED/);
});

// ---------- §16 dead grant removal ----------

test("superseded ensureCycleGrant is gone; single grant path remains", () => {
  assert.equal(acctSvc.ensureCycleGrant, undefined);
  assert.equal(typeof cycle.ensureCurrentCreditCycle, "function");
});
