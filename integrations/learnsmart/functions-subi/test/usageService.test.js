// test/usageService.test.js — SUBI usage accounting tests (fakes only).
// Counters only; never message text. Missing docs read as zeros.
const test = require("node:test");
const assert = require("node:assert/strict");

const usage = require("../src/services/usageService");

function fakeStore() {
  const state = {};
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      const ref = {
        _key: key,
        async get() {
          return { id, exists: key in state, data: () => state[key] };
        },
        collection: (sub) => coll(`${key}/${sub}`),
      };
      return ref;
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
  return {
    _state: state,
    collection: (name) => coll(name),
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

const rec = (over = {}) => ({
  uid: "u1",
  schoolId: "s1",
  role: "student",
  modelKey: "mdl_a",
  inputTokens: 100,
  outputTokens: 50,
  ...over,
});

test("record accumulates school + user counters, roles, models", async () => {
  const s = fakeStore();
  const out = await usage.recordUsage(rec(), { store: s });
  assert.equal(out.uid, "u1");
  assert.match(out.month, /^\d{4}-\d{2}$/);
  const school = await usage.getSchoolUsage({ schoolId: "s1", month: out.month }, { store: s });
  assert.deepEqual(
    [school.inputTokens, school.outputTokens, school.requests],
    [100, 50, 1]
  );
  assert.deepEqual(school.byRole.student, { inputTokens: 100, outputTokens: 50, requests: 1 });
  assert.deepEqual(school.byRole.teacher, { inputTokens: 0, outputTokens: 0, requests: 0 });
  assert.deepEqual(school.byModel["mdl_a"], { inputTokens: 100, outputTokens: 50, requests: 1 });
  const user = await usage.getUserUsage({ uid: "u1", schoolId: "s1", month: out.month }, { store: s });
  assert.deepEqual([user.inputTokens, user.outputTokens, user.requests], [100, 50, 1]);
  assert.equal(user.lastKnownRole, "student");
  // second call accumulates
  await usage.recordUsage(rec({ inputTokens: 10, outputTokens: 5, modelKey: "mdl_b" }), { store: s });
  const school2 = await usage.getSchoolUsage({ schoolId: "s1", month: out.month }, { store: s });
  assert.deepEqual(
    [school2.inputTokens, school2.outputTokens, school2.requests],
    [110, 55, 2]
  );
  assert.deepEqual(Object.keys(school2.byModel).sort(), ["mdl_a", "mdl_b"]);
});

test("record rejects invalid input", async () => {
  const s = fakeStore();
  for (const bad of [
    rec({ role: "admin" }),
    rec({ modelKey: "upstream/x" }),
    rec({ inputTokens: -1 }),
    rec({ outputTokens: 1.5 }),
    rec({ inputTokens: "100" }),
    rec({ inputTokens: 10_000_001 }),
    rec({ uid: "" }),
    rec({ schoolId: "" }),
  ]) {
    await assert.rejects(usage.recordUsage(bad, { store: s }), (e) => e.code === "INVALID_REQUEST");
  }
});

test("readers default month; reject bad/future months", async () => {
  const s = fakeStore();
  const now = await usage.getSchoolUsage({ schoolId: "s1" }, { store: s });
  assert.equal(now.month, usage.currentMonthIST());
  assert.deepEqual([now.inputTokens, now.requests], [0, 0]);
  for (const bad of ["2026", "2026-13", "sept", "9999-99"]) {
    await assert.rejects(
      usage.getSchoolUsage({ schoolId: "s1", month: bad }, { store: s }),
      (e) => e.code === "INVALID_REQUEST"
    );
  }
  const [y, m] = usage.currentMonthIST().split("-").map(Number);
  const future = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  await assert.rejects(
    usage.getSchoolUsage({ schoolId: "s1", month: future }, { store: s }),
    (e) => e.code === "INVALID_REQUEST"
  );
  await assert.rejects(usage.getSchoolUsage({ schoolId: "" }, { store: s }), (e) => e.code === "INVALID_REQUEST");
  await assert.rejects(
    usage.getUserUsage({ uid: "u1", schoolId: "" }, { store: s }),
    (e) => e.code === "INVALID_REQUEST"
  );
});

test("malformed stored docs read as zeros, never NaN", async () => {
  const s = fakeStore();
  const month = "2026-01";
  s._state[`usageMonthly/${month}/schools/s1`] = {
    inputTokens: "oops",
    outputTokens: -5,
    requests: null,
    byRole: { student: { inputTokens: "x" } },
    byModel: { "mdl_a": { inputTokens: "x" }, "mdl_dead": null },
  };
  const out = await usage.getSchoolUsage({ schoolId: "s1", month }, { store: s });
  assert.deepEqual([out.inputTokens, out.outputTokens, out.requests], [0, 0, 0]);
  assert.deepEqual(out.byRole.student, { inputTokens: 0, outputTokens: 0, requests: 0 });
  assert.deepEqual(out.byModel["mdl_a"], { inputTokens: 0, outputTokens: 0, requests: 0 });
  assert.equal(out.byModel["mdl_dead"], undefined);
});

test("list orders by total desc with offset cursor paging", async () => {
  const s = fakeStore();
  const month = "2026-02";
  const seed = (uid, total) => {
    s._state[`usageMonthly/${month}/schools/s1/users/${uid}`] = {
      uid,
      inputTokens: total,
      outputTokens: 0,
      requests: 1,
    };
  };
  seed("u_low", 10);
  seed("u_high", 300);
  seed("u_mid", 100);
  const d = { store: s };
  const p1 = await usage.listSchoolUserUsage({ schoolId: "s1", month, limit: 2 }, d);
  assert.deepEqual(p1.users.map((u) => u.uid), ["u_high", "u_mid"]);
  assert.ok(p1.nextCursor);
  const p2 = await usage.listSchoolUserUsage({ schoolId: "s1", month, limit: 2, cursor: p1.nextCursor }, d);
  assert.deepEqual(p2.users.map((u) => u.uid), ["u_low"]);
  assert.equal(p2.nextCursor, null);
  await assert.rejects(
    usage.listSchoolUserUsage({ schoolId: "s1", month, cursor: "nope" }, d),
    (e) => e.code === "INVALID_REQUEST"
  );
});

test("store failure surfaces INTERNAL, not silent zeros", async () => {
  const s = fakeStore();
  s.runTransaction = async () => {
    throw new Error("down");
  };
  await assert.rejects(usage.recordUsage(rec(), { store: s }), (e) => e.code === "INTERNAL");
});
