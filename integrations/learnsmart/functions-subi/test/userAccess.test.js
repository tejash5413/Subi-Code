// test/userAccess.test.js — Phase 3B individual override tests (fakes only).
const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../src/services/accessService");

function storeWithKeys(docs = {}, { throwOnRead = false } = {}) {
  const state = { ...docs };
  const store = {
    _state: state,
    collection: (name) => ({
      doc: (id) => ({
        _key: `${name}/${id}`,
        async get() {
          if (throwOnRead) throw new Error("firestore down");
          const key = `${name}/${id}`;
          return { exists: key in state, data: () => state[key] };
        },
      }),
    }),
    async runTransaction(fn) {
      const tx = {
        set: (ref, data) => {
          state[ref._key] = { ...(state[ref._key] || {}), ...data };
        },
      };
      await fn(tx);
    },
  };
  return store;
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
const G = { enabled: true };
const OFF = { roles: { student: { enabled: false }, teacher: { enabled: false } } };
const ON = { roles: { student: { enabled: true }, teacher: { enabled: true } } };
const base = (extra = {}) => ({
  "systemConfig/subiAccess": G,
  "schoolPolicies/s1": ON,
  ...extra,
});
const resolve = (store, role = "student", uid = "u1") =>
  svc.resolveSubiAccess({ accountType: 'school', uid, schoolId: "s1", role }, deps(store));

test("Global OFF + Individual Enabled → denied", async () => {
  const s = storeWithKeys({
    "systemConfig/subiAccess": { enabled: false },
    "userPolicies/u1": { accessMode: "enabled" },
  });
  assert.deepEqual(await resolve(s), { allowed: false, reason: "GLOBAL_DISABLED", basis: "global_disabled" });
});

test("Global ON + Enabled + School OFF → allowed", async () => {
  const s = storeWithKeys(base({ "schoolPolicies/s1": OFF, "userPolicies/u1": { accessMode: "enabled" } }));
  assert.deepEqual(await resolve(s), { allowed: true, basis: "individual_enabled" });
});

test("Global ON + Enabled + missing school → allowed", async () => {
  const s = storeWithKeys({
    "systemConfig/subiAccess": G,
    "userPolicies/u1": { accessMode: "enabled" },
  });
  assert.deepEqual(await resolve(s), { allowed: true, basis: "individual_enabled" });
});

test("Global ON + Disabled + School ON → denied", async () => {
  const s = storeWithKeys(base({ "userPolicies/u1": { accessMode: "disabled" } }));
  assert.deepEqual(await resolve(s), { allowed: false, reason: "USER_DISABLED", basis: "individual_disabled" });
});

test("Global ON + Inherit + School ON → allowed; OFF → denied", async () => {
  const on = storeWithKeys(base({ "userPolicies/u1": { accessMode: "inherit" } }));
  assert.deepEqual(await resolve(on), { allowed: true, basis: "school_default_enabled" });
  const off = storeWithKeys(base({ "schoolPolicies/s1": OFF, "userPolicies/u1": { accessMode: "inherit" } }));
  assert.deepEqual(await resolve(off), { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" });
});

test("Global ON + missing policy + School ON/OFF", async () => {
  const on = storeWithKeys(base());
  assert.deepEqual(await resolve(on), { allowed: true, basis: "school_default_enabled" });
  const off = storeWithKeys(base({ "schoolPolicies/s1": OFF }));
  assert.deepEqual(await resolve(off), { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" });
});

test("Malformed user policy → fail closed", async () => {
  const s = storeWithKeys(base({ "userPolicies/u1": { accessMode: "superuser" } }));
  assert.deepEqual(await resolve(s), { allowed: false, reason: "USER_DISABLED", basis: "policy_invalid" });
});

test("teacher role independent", async () => {
  const s = storeWithKeys(
    base({
      "schoolPolicies/s1": { roles: { student: { enabled: false }, teacher: { enabled: true } } },
      "userPolicies/u1": { accessMode: "inherit" },
    })
  );
  assert.deepEqual(await resolve(s, "teacher"), { allowed: true, basis: "school_default_enabled" });
  assert.deepEqual(await resolve(s, "student"), { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" });
});

test("get/setUserAccess round-trip with audit", async () => {
  const s = storeWithKeys(base());
  const d = deps(s);
  assert.deepEqual(await svc.getUserAccess("u1", d), {
    uid: "u1",
    accessMode: "inherit",
    lastKnownSchoolId: null,
    lastKnownRole: null,
    updatedAt: null,
  });
  await assert.rejects(
    svc.setUserAccess({ uid: "u1", accessMode: "bogus", adminUid: "a" }, d),
    (e) => e.code === "INVALID_REQUEST"
  );
  const out = await svc.setUserAccess(
    { uid: "u1", accessMode: "enabled", adminUid: "a", trustedUser: { schoolId: "s1", role: "student" } },
    d
  );
  assert.equal(out.accessMode, "enabled");
  assert.equal(s._state["userPolicies/u1"].accessMode, "enabled");
  assert.equal(s._state["userPolicies/u1"].lastKnownSchoolId, "s1");
  assert.equal(d.audits._list[0].action, "user_access.enabled");
  // inherit preserved as explicit doc (not deleted)
  await svc.setUserAccess({ uid: "u1", accessMode: "inherit", adminUid: "a" }, d);
  assert.equal(s._state["userPolicies/u1"].accessMode, "inherit");
  assert.equal(d.audits._list[1].action, "user_access.inherit");
});

test("evaluateBatch shares one core (no N+1 global reads)", async () => {
  const s = storeWithKeys(
    base({
      "schoolPolicies/s2": OFF,
      "userPolicies/u1": { accessMode: "enabled" },
      "userPolicies/u2": { accessMode: "disabled" },
    })
  );
  let globalReads = 0;
  const orig = s.collection;
  s.collection = (name) => ({
    doc: (id) => ({
      _key: `${name}/${id}`,
      async get() {
        if (name === "systemConfig") globalReads += 1;
        return orig(name).doc(id).get();
      },
    }),
  });
  const out = await svc.evaluateBatch(
    [
      { accountType: 'school', uid: "u1", schoolId: "s1", role: "student" },
      { accountType: 'school', uid: "u2", schoolId: "s1", role: "student" },
      { accountType: 'school', uid: "u3", schoolId: "s2", role: "teacher" },
    ],
    deps(s)
  );
  assert.equal(globalReads, 1);
  assert.deepEqual(
    out.map((r) => [r.effectiveAllowed, r.effectiveBasis, r.individualAccessMode]),
    [
      [true, "individual_enabled", "enabled"],
      [false, "individual_disabled", "disabled"],
      [false, "school_default_disabled", "inherit"],
    ]
  );
  assert.equal(out[0].schoolDefaultEnabled, true);
  assert.equal(out[2].schoolDefaultEnabled, false);
});

test("individual read failure → UNAVAILABLE", async () => {
  const s = storeWithKeys(base(), { throwOnRead: true });
  await assert.rejects(resolve(s), (e) => e.code === "UNAVAILABLE");
});

test("interpretIndividualMode and evaluateEffective agree (single mapping)", async () => {
  const cases = [
    [null, "continue"],
    [{ accessMode: "inherit" }, "continue"],
    [{ accessMode: "enabled" }, "allow"],
    [{ accessMode: "disabled" }, "deny"],
    [{ accessMode: "superuser" }, "deny"],
    [{}, "deny"],
  ];
  for (const [policy, step] of cases) {
    assert.equal(svc.interpretIndividualMode(policy), step, JSON.stringify(policy));
  }
  // checkIndividualOverride mirrors the same mapping through the store
  const docs = {};
  cases.forEach(([policy], i) => {
    if (policy) docs[`userPolicies/u${i}`] = policy;
  });
  const s = storeWithKeys({ ...base(), ...docs });
  const d = deps(s);
  const expected = { continue: "continue", allow: "allow", deny: "deny" };
  for (let i = 0; i < cases.length; i += 1) {
    const out = await svc.checkIndividualOverride({ uid: `u${i}`, schoolId: "s1", role: "student" }, d);
    assert.equal(out.decision, expected[cases[i][1]], `case ${i}`);
  }
  // resolver outcomes match the mapping end to end
  const allowStore = storeWithKeys(base({ "userPolicies/x": { accessMode: "enabled" } }));
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "x", schoolId: "s1", role: "student" }, deps(allowStore)),
    { allowed: true, basis: "individual_enabled" }
  );
});
