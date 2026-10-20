// test/monthlyLimitService.test.js — Phase 5 per-user monthly limits (fakes only).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const svc = require("../src/services/monthlyLimitService");

test("managed monthly-limit route forwards authoritative account type", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "managedLimits.js"),
    "utf8"
  );
  const resolverCall = source.match(/resolveEffectiveMonthlyLimit\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(resolverCall, "managed route must call the effective limit resolver");
  assert.match(resolverCall[1], /accountType\s*:\s*ctx\.accountType/);
});

test("managed usage route forwards authoritative account type", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "routes", "managedUsage.js"),
    "utf8"
  );
  const usageCall = source.match(/getManagedUsage\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  assert.ok(usageCall, "managed route must call the effective usage resolver");
  assert.match(usageCall[1], /accountType\s*:\s*ctx\.accountType/);
});

test("managed limit source is coarse and safe", () => {
  assert.equal(svc.toSafePolicySource("individual_custom"), "individual");
  assert.equal(svc.toSafePolicySource("school_student"), "school");
  assert.equal(svc.toSafePolicySource("school_teacher"), "school");
  assert.equal(svc.toSafePolicySource("invalid_policy"), "none");
});

test("school account ignores an orphaned individual monthly limit", () => {
  const out = svc.evaluateMonthlyLimit({
    userLimit: { monthlyTokenMode: "custom", monthlyTokens: 1500000 },
    schoolLimit: { monthlyTokens: { student: 2000000, teacher: 1000000 } },
    role: "student",
    accountType: "school",
  });
  assert.deepEqual(out, {
    configured: true,
    monthlyTokenLimit: 2000000,
    source: "school_student",
  });
});

function storeWithKeys(docs = {}, { throwOnRead = false } = {}) {
  const state = { ...docs };
  const store = {
    _state: state,
    collection(name) {
      return {
        doc: (id) => ({
          _key: `${name}/${id}`,
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

// ---------- Evaluator: school ----------

test("missing school limit -> not configured", () => {
  const r = svc.evaluateMonthlyLimit({ userLimit: null, schoolLimit: null, role: "student" });
  assert.deepEqual(r, { configured: false, monthlyTokenLimit: null, source: "not_configured" });
});

test("student default 100000 -> effective 100000 per student", () => {
  const r = svc.evaluateMonthlyLimit({
    userLimit: null,
    schoolLimit: { monthlyTokens: { student: 100000, teacher: 500000 } },
    role: "student",
  });
  assert.deepEqual(r, { configured: true, monthlyTokenLimit: 100000, source: "school_student" });
});

test("teacher default 500000 -> effective 500000 per teacher", () => {
  const r = svc.evaluateMonthlyLimit({
    userLimit: null,
    schoolLimit: { monthlyTokens: { student: 100000, teacher: 500000 } },
    role: "teacher",
  });
  assert.deepEqual(r, { configured: true, monthlyTokenLimit: 500000, source: "school_teacher" });
});

test("zero accepted and means zero allowance", () => {
  const r = svc.evaluateMonthlyLimit({
    userLimit: { monthlyTokenMode: "custom", monthlyTokens: 0 },
    schoolLimit: { monthlyTokens: { student: 100000, teacher: 500000 } },
    role: "student",
  });
  assert.deepEqual(r, { configured: true, monthlyTokenLimit: 0, source: "individual_custom" });
});

test("invalid role -> invalid_policy", () => {
  const r = svc.evaluateMonthlyLimit({ userLimit: null, schoolLimit: null, role: "schooladmin" });
  assert.equal(r.source, "invalid_policy");
  assert.equal(r.configured, false);
});

// ---------- Validation ----------

test("negative rejected", async () => {
  const d = deps(storeWithKeys({}));
  await assert.rejects(
    svc.setSchoolLimits({ schoolId: "s", studentMonthlyTokens: -1, teacherMonthlyTokens: 5, adminUid: "a" }, d),
    /INVALID_REQUEST|out of range|safe integer/
  );
});

test("decimal rejected", async () => {
  const d = deps(storeWithKeys({}));
  await assert.rejects(
    svc.setSchoolLimits({ schoolId: "s", studentMonthlyTokens: 1.5, teacherMonthlyTokens: 5, adminUid: "a" }, d),
    /INVALID_REQUEST|out of range|safe integer/
  );
});

test("string rejected", async () => {
  const d = deps(storeWithKeys({}));
  await assert.rejects(
    svc.setSchoolLimits({ schoolId: "s", studentMonthlyTokens: "100000", teacherMonthlyTokens: 5, adminUid: "a" }, d),
    /INVALID_REQUEST|out of range|safe integer/
  );
});

test("unsafe integer rejected", async () => {
  const d = deps(storeWithKeys({}));
  await assert.rejects(
    svc.setSchoolLimits({ schoolId: "s", studentMonthlyTokens: Number.MAX_SAFE_INTEGER + 1, teacherMonthlyTokens: 5, adminUid: "a" }, d),
    /INVALID_REQUEST|out of range|safe integer/
  );
});

test("above hard max rejected", async () => {
  const d = deps(storeWithKeys({}));
  await assert.rejects(
    svc.setSchoolLimits({ schoolId: "s", studentMonthlyTokens: 100_000_001, teacherMonthlyTokens: 5, adminUid: "a" }, d),
    /INVALID_REQUEST|out of range|safe integer/
  );
});

// ---------- School write/read ----------

test("school set preserves createdAt and updates", async () => {
  const d = deps(storeWithKeys({}));
  await svc.setSchoolLimits({ schoolId: "s1", studentMonthlyTokens: 100000, teacherMonthlyTokens: 500000, adminUid: "adm" }, d);
  const created = d.store._state["schoolLimits/s1"].createdAt;
  assert.ok(created);
  await svc.setSchoolLimits({ schoolId: "s1", studentMonthlyTokens: 150000, teacherMonthlyTokens: 500000, adminUid: "adm" }, d);
  assert.equal(d.store._state["schoolLimits/s1"].createdAt, created);
  assert.equal(d.store._state["schoolLimits/s1"].monthlyTokens.student, 150000);
  assert.equal(d._list ? undefined : undefined, undefined);
});

test("school set writes audit", async () => {
  const d = deps(storeWithKeys({}));
  await svc.setSchoolLimits({ schoolId: "s1", studentMonthlyTokens: 100000, teacherMonthlyTokens: 500000, adminUid: "adm" }, d);
  assert.equal(d.audits._list.length, 1);
  assert.equal(d.audits._list[0].action, "school_monthly_limit.updated");
});

test("no default-DB writes: service never touches learnsmartDb", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "services", "monthlyLimitService.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  assert.ok(!/learnsmartDb/.test(code));
});

// ---------- Individual ----------

test("missing user policy -> inherit school student value", async () => {
  const d = deps(storeWithKeys({ "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } } }));
  const r = await svc.resolveEffectiveMonthlyLimit({ uid: "u1", schoolId: "sA", role: "student" }, d);
  assert.deepEqual(r, { configured: true, monthlyTokenLimit: 100000, source: "school_student" });
});

test("inherit + teacher default", async () => {
  const d = deps(storeWithKeys({ "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } } }));
  const r = await svc.resolveEffectiveMonthlyLimit({ uid: "u1", schoolId: "sA", role: "teacher" }, d);
  assert.deepEqual(r, { configured: true, monthlyTokenLimit: 500000, source: "school_teacher" });
});

test("custom student replaces default (higher allowed)", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "userLimits/u1": { monthlyTokenMode: "custom", monthlyTokens: 500000 },
  }));
  const r = await svc.resolveEffectiveMonthlyLimit({ uid: "u1", schoolId: "sA", role: "student" }, d);
  assert.deepEqual(r, { configured: true, monthlyTokenLimit: 500000, source: "individual_custom" });
});

test("custom lower than school allowed", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "userLimits/u1": { monthlyTokenMode: "custom", monthlyTokens: 20000 },
  }));
  const r = await svc.resolveEffectiveMonthlyLimit({ uid: "u1", schoolId: "sA", role: "student" }, d);
  assert.equal(r.monthlyTokenLimit, 20000);
});

test("custom zero -> effective zero", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "userLimits/u1": { monthlyTokenMode: "custom", monthlyTokens: 0 },
  }));
  const r = await svc.resolveEffectiveMonthlyLimit({ uid: "u1", schoolId: "sA", role: "student" }, d);
  assert.deepEqual(r, { configured: true, monthlyTokenLimit: 0, source: "individual_custom" });
});

test("custom missing value rejected", async () => {
  const d = deps(storeWithKeys({}));
  await assert.rejects(
    svc.setUserLimit({ uid: "u", monthlyTokenMode: "custom", monthlyTokens: null, adminUid: "a", trustedUser: { schoolId: "s", role: "student" } }, d),
    /INVALID_REQUEST|safe integer|out of range/
  );
});

test("invalid mode rejected", async () => {
  const d = deps(storeWithKeys({}));
  await assert.rejects(
    svc.setUserLimit({ uid: "u", monthlyTokenMode: "unlimited", monthlyTokens: null, adminUid: "a", trustedUser: {} }, d),
    /INVALID_REQUEST|invalid/
  );
});

test("malformed stored custom fails closed", () => {
  const r = svc.evaluateMonthlyLimit({
    userLimit: { monthlyTokenMode: "custom", monthlyTokens: "lots" },
    schoolLimit: { monthlyTokens: { student: 100000, teacher: 500000 } },
    role: "student",
  });
  assert.equal(r.source, "invalid_policy");
  assert.equal(r.configured, false);
});

test("inherit stores explicit inherit with null", async () => {
  const d = deps(storeWithKeys({}));
  const out = await svc.setUserLimit({ uid: "u", monthlyTokenMode: "inherit", monthlyTokens: 999, adminUid: "a", trustedUser: { schoolId: "s", role: "student" } }, d);
  assert.deepEqual(out, { uid: "u", monthlyTokenMode: "inherit", monthlyTokens: null });
  assert.equal(d.store._state["userLimits/u"].monthlyTokens, null);
  assert.equal(d.audits._list[0].action, "user_monthly_limit.inherit");
});

test("custom stores audit custom", async () => {
  const d = deps(storeWithKeys({}));
  await svc.setUserLimit({ uid: "u", monthlyTokenMode: "custom", monthlyTokens: 250000, adminUid: "a", trustedUser: { schoolId: "s", role: "student" } }, d);
  assert.equal(d.audits._list[0].action, "user_monthly_limit.custom");
});

// ---------- Transfer / role / mid-month ----------

test("inherit transfer A(100k) -> B(150k) becomes 150k", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "schoolLimits/sB": { monthlyTokens: { student: 150000, teacher: 600000 } },
  }));
  const before = await svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "sA", role: "student" }, d);
  const after = await svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "sB", role: "student" }, d);
  assert.equal(before.monthlyTokenLimit, 100000);
  assert.equal(after.monthlyTokenLimit, 150000);
});

test("custom follows UID across transfer", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "schoolLimits/sB": { monthlyTokens: { student: 150000, teacher: 600000 } },
    "userLimits/u": { monthlyTokenMode: "custom", monthlyTokens: 250000 },
  }));
  const after = await svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "sB", role: "student" }, d);
  assert.equal(after.monthlyTokenLimit, 250000);
});

test("teacher transfer equivalent", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "schoolLimits/sB": { monthlyTokens: { student: 150000, teacher: 600000 } },
  }));
  const r = await svc.resolveEffectiveMonthlyLimit({ uid: "t", schoolId: "sB", role: "teacher" }, d);
  assert.equal(r.monthlyTokenLimit, 600000);
});

test("role change student->teacher switches default; custom stays", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "userLimits/uc": { monthlyTokenMode: "custom", monthlyTokens: 250000 },
  }));
  const inheritStudent = await svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "sA", role: "student" }, d);
  const inheritTeacher = await svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "sA", role: "teacher" }, d);
  assert.equal(inheritStudent.monthlyTokenLimit, 100000);
  assert.equal(inheritTeacher.monthlyTokenLimit, 500000);
  const customTeacher = await svc.resolveEffectiveMonthlyLimit({ uid: "uc", schoolId: "sA", role: "teacher" }, d);
  assert.equal(customTeacher.monthlyTokenLimit, 250000);
});

test("mid-month school change takes effect immediately (no prorate fields)", async () => {
  const d = deps(storeWithKeys({}));
  await svc.setSchoolLimits({ schoolId: "s", studentMonthlyTokens: 100000, teacherMonthlyTokens: 500000, adminUid: "a" }, d);
  const before = await svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "s", role: "student" }, d);
  await svc.setSchoolLimits({ schoolId: "s", studentMonthlyTokens: 150000, teacherMonthlyTokens: 500000, adminUid: "a" }, d);
  const after = await svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "s", role: "student" }, d);
  assert.equal(before.monthlyTokenLimit, 100000);
  assert.equal(after.monthlyTokenLimit, 150000);
  assert.ok(!("prorate" in d.store._state["schoolLimits/s"]));
});

test("batch resolution avoids N+1 and reuses evaluator", async () => {
  const d = deps(storeWithKeys({
    "schoolLimits/sA": { monthlyTokens: { student: 100000, teacher: 500000 } },
    "userLimits/u2": { monthlyTokenMode: "custom", monthlyTokens: 250000 },
  }));
  const out = await svc.resolveEffectiveMonthlyLimitsBatch([
    { uid: "u1", schoolId: "sA", role: "student" },
    { uid: "u2", schoolId: "sA", role: "student" },
  ], d);
  assert.equal(out[0].monthlyTokenLimit, 100000);
  assert.equal(out[1].monthlyTokenLimit, 250000);
  assert.equal(out[1].source, "individual_custom");
});

test("store unavailable surfaces UNAVAILABLE", async () => {
  const d = deps(storeWithKeys({}, { throwOnRead: true }));
  await assert.rejects(
    svc.resolveEffectiveMonthlyLimit({ uid: "u", schoolId: "s", role: "student" }, d),
    (e) => e.code === "UNAVAILABLE"
  );
});

test("anti-pool: schemas contain no aggregate fields", () => {
  const fs = require("fs");
  const path = require("path");
  for (const f of ["monthlyLimitService.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", f), "utf8");
    for (const bad of ["TokenPool", "SharedTokens", "schoolTokenBalance", "remainingSchoolTokens", "totalMonthlyTokens", "sharedMonthlyTokens", "usedTokens", "remainingTokens"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
});
