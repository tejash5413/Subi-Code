// test/accessService.test.js — Phase 3A resolver + policy tests (fakes only).
const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../src/services/accessService");

function fakeStore(docs = {}, { throwOnRead = false } = {}) {
  const state = { ...docs };
  return {
    _state: state,
    collection(name) {
      return {
        doc: (id) => ({
          async get() {
            if (throwOnRead) throw new Error("firestore down");
            const key = `${name}/${id}`;
            return { exists: key in state, data: () => state[key] };
          },
        }),
      };
    },
    async runTransaction(fn) {
      const tx = {
        get: ref => ref.get(),
        set: (ref, data) => {
          state[ref._key] = { ...(state[ref._key] || {}), ...data };
        },
      };
      return fn(tx);
    },
    _ref(name, id) {
      return { _key: `${name}/${id}` };
    },
  };
}
// patch: collection().doc() must expose _key for txn writes
function storeWithKeys(docs, opts) {
  const s = fakeStore(docs, opts);
  const orig = s.collection;
  s.collection = (name) => ({
    doc: (id) => ({
      _key: `${name}/${id}`,
      async get() {
        return orig(name).doc(id).get();
      },
    }),
  });
  return s;
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
const schoolOn = { roles: { student: { enabled: true }, teacher: { enabled: true } } };

test("missing global denies", async () => {
  const r = await svc.resolveSubiAccess(
    { accountType: 'school', uid: "u", schoolId: "s", role: "student" },
    deps(storeWithKeys({}))
  );
  assert.deepEqual(r, { allowed: false, reason: "GLOBAL_DISABLED", basis: "global_disabled" });
});

test("global OFF denies", async () => {
  const s = storeWithKeys({ "systemConfig/subiAccess": { enabled: false } });
  const r = await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "student" }, deps(s));
  assert.deepEqual(r, { allowed: false, reason: "GLOBAL_DISABLED", basis: "global_disabled" });
});

test("global ON + missing school denies both roles", async () => {
  const s = storeWithKeys({ "systemConfig/subiAccess": G });
  for (const role of ["student", "teacher"]) {
    const r = await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role }, deps(s));
    assert.deepEqual(r, { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" });
  }
});

test("student ON allows student; OFF denies", async () => {
  const on = storeWithKeys({
    "systemConfig/subiAccess": G,
    "schoolPolicies/s": { roles: { student: { enabled: true }, teacher: { enabled: false } } },
  });
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "student" }, deps(on)),
    { allowed: true, basis: "school_default_enabled" }
  );
  const off = storeWithKeys({
    "systemConfig/subiAccess": G,
    "schoolPolicies/s": { roles: { student: { enabled: false }, teacher: { enabled: true } } },
  });
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "student" }, deps(off)),
    { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" }
  );
});

test("teacher ON allows teacher; OFF denies", async () => {
  const s = storeWithKeys({ "systemConfig/subiAccess": G, "schoolPolicies/s": schoolOn });
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "teacher" }, deps(s)),
    { allowed: true, basis: "school_default_enabled" }
  );
  const s2 = storeWithKeys({
    "systemConfig/subiAccess": G,
    "schoolPolicies/s": { roles: { student: { enabled: true }, teacher: { enabled: false } } },
  });
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "teacher" }, deps(s2)),
    { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" }
  );
});

test("malformed docs fail closed; unknown role denied", async () => {
  const badGlobal = storeWithKeys({ "systemConfig/subiAccess": { enabled: "yes" } });
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "student" }, deps(badGlobal)),
    { allowed: false, reason: "GLOBAL_DISABLED", basis: "global_disabled" }
  );
  const badSchool = storeWithKeys({
    "systemConfig/subiAccess": G,
    "schoolPolicies/s": { roles: "oops" },
  });
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "student" }, deps(badSchool)),
    { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" }
  );
  const ok = storeWithKeys({ "systemConfig/subiAccess": G, "schoolPolicies/s": schoolOn });
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "schooladmin" }, deps(ok)),
    { allowed: false, reason: "INVALID_ROLE" }
  );
  assert.deepEqual(
    await svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "", role: "student" }, deps(ok)),
    { allowed: false, reason: "INVALID_ROLE" }
  );
});

test("Firestore error → UNAVAILABLE", async () => {
  const s = storeWithKeys({}, { throwOnRead: true });
  await assert.rejects(svc.resolveSubiAccess({ accountType: 'school', uid: "u", schoolId: "s", role: "student" }, deps(s)), (e) => e.code === "UNAVAILABLE");
});

test("individual seam defaults to continue (3B inserts here)", async () => {
  const out = await svc.checkIndividualOverride({ uid: "u", schoolId: "s", role: "student" }, deps(storeWithKeys({})));
  assert.deepEqual(out, { decision: "continue" });
});

test("setGlobalAccess validates + audits", async () => {
  const s = storeWithKeys({});
  const d = deps(s);
  await assert.rejects(svc.setGlobalAccess({ enabled: "yes", adminUid: "a" }, d), (e) => e.code === "INVALID_REQUEST");
  const out = await svc.setGlobalAccess({ enabled: true, adminUid: "a" }, d);
  assert.deepEqual(out, { enabled: true });
  assert.equal(s._state["systemConfig/subiAccess"].enabled, true);
  assert.equal(d.audits._list[0].action, "subi_access.enabled");
});

test("setSchoolAccess validates + audits", async () => {
  const s = storeWithKeys({});
  const d = deps(s);
  await assert.rejects(
    svc.setSchoolAccess({ schoolId: "s", studentEnabled: 1, teacherEnabled: false, adminUid: "a" }, d),
    (e) => e.code === "INVALID_REQUEST"
  );
  const out = await svc.setSchoolAccess({ schoolId: "s", studentEnabled: true, teacherEnabled: false, adminUid: "a" }, d);
  assert.equal(out.roles.student.enabled, true);
  assert.equal(out.roles.teacher.enabled, false);
  assert.equal(d.audits._list[0].action, "school_role_access.changed");
});
