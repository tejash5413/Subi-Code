// test/usageQuota.test.js — Phase 9A quota core tests (fakes only).
// Reserve/commit/cancel/expire/idempotency/concurrency/rollover/limits.
// No provider calls, no deploys.
const test = require("node:test");
const assert = require("node:assert/strict");

const quota = require("../src/services/usageQuotaService");
const validator = require("../src/services/managedChatValidator");
const { writeDoc } = require("./orderingTx");

function fakeStore() {
  const state = {};
  const coll = (prefix) => ({
    doc: (id) => {
      const key = `${prefix}/${id}`;
      return {
        _key: key,
        async get() {
          return { id, exists: key in state, data: () => state[key] };
        },
        collection: (sub) => coll(`${key}/${sub}`),
      };
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
        // Phase 9B.2M: sentinel-aware merge so pruned nested keys are
        // physically removed like production Firestore.
        set: (ref, data, options) => {
          state[ref._key] = writeDoc(state[ref._key], data, options);
        },
        get: async (ref) => {
          const key = ref._key;
          return { exists: key in state, data: () => state[key] };
        },
      };
      // Real Firestore returns the transaction callback's value.
      return fn(tx);
    },
  };
}

const MONTH = quota.currentMonthIST();
const upath = (uid) => `usageMonthly/${MONTH}/users/${uid}`;
const spath = (sid) => `usageMonthly/${MONTH}/schools/${sid}`;
const rpath = (uid, req) => `usageMonthly/${MONTH}/reservations/${quota.reservationIdFor(uid, req)}`;

function seedLimits(s, { student = 100000, teacher = 100000 } = {}) {
  s._state["schoolLimits/s1"] = { monthlyTokens: { student, teacher } };
}

function seedCustom(s, uid, tokens) {
  s._state[`userLimits/${uid}`] = { monthlyTokenMode: "custom", monthlyTokens: tokens };
}

function seedUsage(s, uid, over = {}) {
  s._state[upath(uid)] = {
    schemaVersion: 1,
    uid,
    period: MONTH,
    inputTokens: 0,
    outputTokens: 0,
    conservativeChargedTokens: 0,
    requests: 0,
    activeReservations: {},
    byModel: {},
    ...over,
  };
}

function baseReserve(over = {}) {
  return {
    uid: "u1",
    schoolId: "s1",
    role: "student",
    modelKey: "mdl_a",
    requestId: "r1",
    inputUpperBound: 1000,
    defaultMaxOutputTokens: quota.DEFAULT_MAX_OUTPUT_TOKENS,
    ...over,
  };
}

// ---------- Estimator ----------

test("estimator is byte-based and conservative across scripts", () => {
  assert.equal(quota.estimateInputUpperBound([{ role: "user", content: "hi" }]), 2 + 64 + 256);
  assert.equal(
    quota.estimateInputUpperBound([{ role: "user", content: "a" }, { role: "assistant", content: "bb" }]),
    3 + 128 + 256
  );
  // Tamil (15 bytes), CJK (9 bytes), emoji (4 bytes): bound >= bytes, never chars/4.
  for (const [text, bytes] of [["தமிழ்", 15], ["日本語", 9], ["😀", 4]]) {
    const bound = quota.estimateInputUpperBound([{ role: "user", content: text }]);
    assert.equal(bound, bytes + 64 + 256);
    assert.ok(bound >= text.length * 3 + 64 + 256 || bound >= bytes, "no under-reserve");
  }
  const mixed = "hi தமிழ் 😀";
  const bound = quota.estimateInputUpperBound([{ role: "user", content: mixed }]);
  assert.equal(bound, Buffer.byteLength(mixed, "utf8") + 64 + 256);
  // 20-message maximum shape + server system bytes included.
  const many = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}` }));
  assert.equal(
    quota.estimateInputUpperBound(many, "sys"),
    Buffer.byteLength(many.map((m) => m.content).join(""), "utf8") +
      Buffer.byteLength("sys", "utf8") + 20 * 64 + 256
  );
  assert.equal(
    quota.estimateInputUpperBound([{ role: "user", content: "hi" }], 2400),
    2 + 2400 + 64 + 256,
    "numeric server-owned schema sizes are counted instead of stringified"
  );
  assert.throws(() => quota.estimateInputUpperBound([]), (e) => e.code === "INVALID_REQUEST");
  assert.equal(quota.DEFAULT_MAX_OUTPUT_TOKENS, 4096);
  assert.equal(quota.MIN_OUTPUT_TOKENS, 64);
  assert.equal(quota.RESERVATION_TTL_SECONDS, 600);
  assert.equal(quota.MAX_ACTIVE_RESERVATIONS, 25);
});

// ---------- Basic reserve math ----------

test("basic reserve: 100k limit, 40k used, 1k input -> maxOut 4096, reserve 5096", async () => {
  const s = fakeStore();
  seedLimits(s);
  seedUsage(s, "u1", { inputTokens: 30000, outputTokens: 10000 });
  const out = await quota.reserveUsage(baseReserve(), { store: s });
  assert.equal(out.maxOutputTokens, 4096);
  assert.equal(out.reservedTokens, 5096);
  assert.equal(out.inputUpperBound, 1000);
  assert.equal(out.period, MONTH);
  assert.equal(out.monthlyTokenLimit, 100000);
  assert.equal(typeof out.reservationId, "string");
});

test("final remaining allowance shrinks max_tokens instead of rejecting", async () => {
  const s = fakeStore();
  seedLimits(s);
  seedUsage(s, "u1", { inputTokens: 90000, outputTokens: 7000 }); // used 97k
  const out = await quota.reserveUsage(baseReserve({ inputUpperBound: 500 }), { store: s });
  assert.equal(out.maxOutputTokens, 2500);
  assert.equal(out.reservedTokens, 3000);
});

test("too little room for minimum output is rejected", async () => {
  const s = fakeStore();
  seedLimits(s);
  seedUsage(s, "u1", { inputTokens: 99500, outputTokens: 0 }); // available 500
  await assert.rejects(quota.reserveUsage(baseReserve({ inputUpperBound: 450 }), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_EXCEEDED");
});

test("exact exhaustion blocks with no reservation", async () => {
  const s = fakeStore();
  seedLimits(s);
  seedUsage(s, "u1", { inputTokens: 100000 });
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_EXCEEDED");
  assert.equal(s._state[rpath("u1", "r1")], undefined);
});

test("not configured and zero limits block", async () => {
  const s = fakeStore();
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_NOT_CONFIGURED");
  seedLimits(s, { student: 0, teacher: 0 });
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_EXCEEDED");
});

// ---------- Concurrency / multi-device / idempotency ----------

test("concurrent reserves serialize: second over-allowance rejected", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 10000, teacher: 10000 });
  await quota.reserveUsage(baseReserve({ requestId: "a", inputUpperBound: 1000 }), { store: s }); // reserves 5096
  // used 0 + active 5096; ask 4905 more -> available 4904 <= 4905? use exact math:
  await assert.rejects(
    quota.reserveUsage(baseReserve({ requestId: "b", inputUpperBound: 4904 }), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_EXCEEDED"
  );
  // smaller second request fits alongside the first
  const ok = await quota.reserveUsage(baseReserve({ requestId: "c", inputUpperBound: 100 }), { store: s });
  assert.ok(ok.reservedTokens > 0);
});

test("multi-device same UID serializes on one user doc", async () => {
  const s = fakeStore();
  seedLimits(s);
  const a = await quota.reserveUsage(baseReserve({ requestId: "devA" }), { store: s });
  const b = await quota.reserveUsage(baseReserve({ requestId: "devB" }), { store: s });
  assert.notEqual(a.reservationId, b.reservationId);
  const doc = s._state[upath("u1")];
  assert.equal(Object.keys(doc.activeReservations).length, 2);
});

test("same requestId while active returns REQUEST_IN_PROGRESS", async () => {
  const s = fakeStore();
  seedLimits(s);
  await quota.reserveUsage(baseReserve(), { store: s });
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_IN_PROGRESS");
  assert.equal(Object.keys(s._state[upath("u1")].activeReservations).length, 1);
});

test("same requestId after terminal returns REQUEST_ALREADY_PROCESSED", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 10, actualOutputTokens: 5, finalState: "completed",
  }, { store: s });
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_ALREADY_PROCESSED");
});

test("commit is idempotent across user, school, and request counts", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const first = await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 100, actualOutputTokens: 50, finalState: "completed",
  }, { store: s });
  assert.equal(first.alreadyTerminal, false);
  const second = await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 100, actualOutputTokens: 50, finalState: "completed",
  }, { store: s });
  assert.equal(second.alreadyTerminal, true);
  assert.deepEqual(
    [s._state[upath("u1")].inputTokens, s._state[upath("u1")].outputTokens, s._state[upath("u1")].requests],
    [100, 50, 1]
  );
  assert.deepEqual(
    [s._state[spath("s1")].inputTokens, s._state[spath("s1")].outputTokens, s._state[spath("s1")].requests],
    [100, 50, 1]
  );
});

test("25 active cap rejects with TOO_MANY_ACTIVE_REQUESTS", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 100000000, teacher: 100000000 });
  const active = {};
  for (let i = 0; i < 25; i += 1) {
    active[`rid${i}`] = { amount: 10, state: "reserved", expiresAt: Date.now() + 600000, modelKey: "mdl_a", schoolId: "s1", role: "student" };
  }
  seedUsage(s, "u1", { activeReservations: active });
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "TOO_MANY_ACTIVE_REQUESTS");
});

// ---------- Lifecycle ----------

test("pre-start failure releases with zero charge", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  const out = await quota.failBeforeStart({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.deepEqual({ released: out.released, charged: out.charged }, { released: true, charged: 0 });
  const doc = s._state[upath("u1")];
  assert.deepEqual([doc.inputTokens, doc.outputTokens, doc.conservativeChargedTokens, doc.requests], [0, 0, 0, 0]);
  assert.deepEqual(Object.keys(doc.activeReservations), []);
  assert.equal(s._state[spath("s1")], undefined);
});

test("started success commits exact actuals, no conservative charge", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve({ inputUpperBound: 1000 }), { store: s });
  assert.equal(r.reservedTokens, 5096);
  await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const c = await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 1200, actualOutputTokens: 1800, finalState: "completed",
  }, { store: s });
  assert.equal(c.committed, 3000);
  assert.equal(c.overReservation, false);
  const doc = s._state[upath("u1")];
  assert.deepEqual([doc.inputTokens, doc.outputTokens, doc.conservativeChargedTokens, doc.requests], [1200, 1800, 0, 1]);
  assert.deepEqual(doc.byModel["mdl_a"], { inputTokens: 1200, outputTokens: 1800, conservativeChargedTokens: 0, requests: 1 });
  assert.deepEqual([s._state[spath("s1")].inputTokens, s._state[spath("s1")].outputTokens, s._state[spath("s1")].requests], [1200, 1800, 1]);
});

test("cancel with known partial usage commits actual", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const out = await quota.cancelUsage({
    reservationId: r.reservationId, period: MONTH, actualInputTokens: 100, actualOutputTokens: 50,
  }, { store: s });
  assert.equal(out.state, "cancelled");
  assert.equal(out.committed, 150);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 0);
});

test("cancel without usage charges full reservation conservatively", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve({ inputUpperBound: 1000 }), { store: s });
  await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const out = await quota.cancelUsage({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.equal(out.charged, 5096);
  const doc = s._state[upath("u1")];
  assert.equal(doc.conservativeChargedTokens, 5096);
  assert.equal(doc.requests, 1);
  assert.equal(s._state[spath("s1")].conservativeChargedTokens, 5096);
  assert.equal(s._state[spath("s1")].requests, 1);
});

test("post-start unknown usage charges conservatively, never zero", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const out = await quota.finalizeStartedUnknownUsage({ reservationId: r.reservationId, period: MONTH, finalState: "failed" }, { store: s });
  assert.ok(out.charged > 0);
  assert.equal(s._state[upath("u1")].inputTokens, 0);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, out.charged);
});

test("stale reserved releases; stale started charges (mandatory)", async () => {
  const s = fakeStore();
  seedLimits(s);
  const past = Date.now() - 1000;
  seedUsage(s, "u1", {
    activeReservations: {
      oldR: { amount: 2000, state: "reserved", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      oldS: { amount: 3000, state: "started", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  });
  s._state[`usageMonthly/${MONTH}/reservations/oldR`] = { reservationId: "oldR", state: "reserved", reservedTokens: 2000, uid: "u1" };
  s._state[`usageMonthly/${MONTH}/reservations/oldS`] = { reservationId: "oldS", state: "started", reservedTokens: 3000, uid: "u1", schoolId: "s1", role: "student", modelKey: "mdl_a" };
  const out = await quota.reserveUsage(baseReserve({ requestId: "fresh" }), { store: s });
  assert.ok(out.reservationId);
  const doc = s._state[upath("u1")];
  assert.equal(doc.conservativeChargedTokens, 3000);
  assert.equal(doc.requests, 1);
  assert.equal(Object.keys(doc.activeReservations).length, 1);
  assert.equal(s._state[`usageMonthly/${MONTH}/reservations/oldR`].state, "expired");
  assert.equal(s._state[`usageMonthly/${MONTH}/reservations/oldS`].state, "expired");
});

test("actual exceeding reservation commits truthfully", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 200000, teacher: 200000 });
  const r = await quota.reserveUsage(baseReserve({ inputUpperBound: 1000 }), { store: s });
  await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const c = await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 6000, actualOutputTokens: 6000, finalState: "completed",
  }, { store: s });
  assert.equal(c.committed, 12000);
  assert.equal(c.overReservation, true);
  assert.equal(s._state[upath("u1")].inputTokens + s._state[upath("u1")].outputTokens, 12000);
});

test("markStarted is idempotent; missing and terminal handled", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  const a = await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const b = await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.deepEqual([a.state, b.state], ["started", "started"]);
  await assert.rejects(quota.markStarted({ reservationId: "nope", period: MONTH }, { store: s }),
    (e) => e.code === "INTERNAL");
  await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 1, actualOutputTokens: 1, finalState: "completed",
  }, { store: s });
  await assert.rejects(quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s }),
    (e) => e.code === "REQUEST_ALREADY_PROCESSED");
});

// ---------- Limits interaction ----------

test("mid-month lower limit blocks immediately; raise re-allows", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 100000, teacher: 100000 });
  seedUsage(s, "u1", { inputTokens: 80000 });
  s._state["schoolLimits/s1"] = { monthlyTokens: { student: 50000, teacher: 100000 } };
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_EXCEEDED");
  s._state["schoolLimits/s1"] = { monthlyTokens: { student: 200000, teacher: 200000 } };
  const out = await quota.reserveUsage(baseReserve(), { store: s });
  assert.ok(out.reservedTokens > 0);
});

test("individual custom limit replaces school default in-txn", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 100000, teacher: 100000 });
  seedCustom(s, "u1", 10000);
  seedUsage(s, "u1", { inputTokens: 9000 }); // available 1000 under custom
  const out = await quota.reserveUsage(baseReserve({ inputUpperBound: 500 }), { store: s });
  assert.equal(out.maxOutputTokens, 500); // 1000-500, shrunk to fit custom
  // custom higher than school allows beyond school default
  seedCustom(s, "u2", 200000);
  const out2 = await quota.reserveUsage(baseReserve({ uid: "u2", requestId: "r2" }), { store: s });
  assert.equal(out2.monthlyTokenLimit, 200000);
});

test("school account reservation ignores an orphaned individual custom limit", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 100000, teacher: 100000 });
  seedCustom(s, "u1", 10000);
  seedUsage(s, "u1", { inputTokens: 9000 });
  const out = await quota.reserveUsage(
    baseReserve({ accountType: "school", inputUpperBound: 500 }),
    { store: s }
  );
  assert.equal(out.monthlyTokenLimit, 100000);
});

test("school default is per UID, never shared", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 100000, teacher: 100000 });
  seedUsage(s, "u1", { inputTokens: 99000 });
  const a = await quota.reserveUsage(baseReserve({ uid: "u2", requestId: "r2" }), { store: s });
  assert.equal(a.monthlyTokenLimit, 100000);
  await assert.rejects(quota.reserveUsage(baseReserve({ uid: "u1", requestId: "r3" }), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_EXCEEDED");
});

test("model switch accumulates one UID total with per-model split", async () => {
  const s = fakeStore();
  seedLimits(s);
  for (const [req, key] of [["r1", "mdl_a"], ["r2", "mdl_b"]]) {
    const r = await quota.reserveUsage(baseReserve({ requestId: req, modelKey: key }), { store: s });
    await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
    await quota.commitUsage({
      reservationId: r.reservationId, period: MONTH,
      actualInputTokens: 100, actualOutputTokens: 50, finalState: "completed",
    }, { store: s });
  }
  const doc = s._state[upath("u1")];
  assert.deepEqual([doc.inputTokens, doc.outputTokens, doc.requests], [200, 100, 2]);
  assert.equal(Object.keys(doc.byModel).length, 2);
});

test("school transfer keeps UID usage; new limit and analytics follow", async () => {
  const s = fakeStore();
  s._state["schoolLimits/s1"] = { monthlyTokens: { student: 100000, teacher: 100000 } };
  s._state["schoolLimits/s2"] = { monthlyTokens: { student: 50000, teacher: 50000 } };
  seedUsage(s, "u1", { inputTokens: 10000 });
  const out = await quota.reserveUsage(baseReserve({ schoolId: "s2", requestId: "r2" }), { store: s });
  assert.equal(out.monthlyTokenLimit, 50000); // current school authority
  await quota.markStarted({ reservationId: out.reservationId, period: MONTH }, { store: s });
  await quota.commitUsage({
    reservationId: out.reservationId, period: MONTH,
    actualInputTokens: 100, actualOutputTokens: 0, finalState: "completed",
  }, { store: s });
  assert.equal(s._state[upath("u1")].inputTokens, 10100); // persists across schools
  assert.equal(s._state[spath("s2")].requests, 1);
  assert.equal(s._state[spath("s1")], undefined);
});

test("role change keeps usage; new role limit applies", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 10000, teacher: 100000 });
  seedUsage(s, "u1", { inputTokens: 9000 });
  await assert.rejects(quota.reserveUsage(baseReserve({ role: "student" }), { store: s }),
    (e) => e.code === "MONTHLY_LIMIT_EXCEEDED");
  const out = await quota.reserveUsage(baseReserve({ role: "teacher", requestId: "r2" }), { store: s });
  assert.equal(out.monthlyTokenLimit, 100000);
});

// ---------- GET /managed/usage view ----------

test("usage view is self-only, safe-shaped, effective with stale", async () => {
  const s = fakeStore();
  seedLimits(s);
  seedUsage(s, "u1", {
    inputTokens: 40000, outputTokens: 2000, requests: 3,
    activeReservations: {
      live: { amount: 5000, state: "reserved", expiresAt: Date.now() + 600000, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      dead: { amount: 7000, state: "started", expiresAt: Date.now() - 1000, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  });
  const out = await quota.getManagedUsage({ uid: "u1", schoolId: "s1", role: "student" }, { store: s });
  // used = 42000 committed + 7000 expired-started; active = 5000; remaining = 100000-49000-5000
  assert.deepEqual(out, {
    configured: true,
    period: MONTH,
    monthlyTokenLimit: 100000,
    usedTokens: 49000,
    remainingTokens: 46000,
  });
  const dumped = JSON.stringify(out);
  for (const banned of ["uid", "upstreamModelId", "pricing", "reservation", "school", "modelKey", "schoolId"]) {
    assert.equal(dumped.includes(`"${banned}"`), false, `leaked ${banned}`);
  }
  // read-only: expired entry still non-terminal in store
  assert.equal(s._state[upath("u1")].activeReservations.dead.state, "started");
});

test("usage view unconfigured and zero shapes", async () => {
  const s = fakeStore();
  seedUsage(s, "u1", { inputTokens: 500 });
  const unconfigured = await quota.getManagedUsage({ uid: "u1", schoolId: "s1", role: "student" }, { store: s });
  assert.deepEqual(unconfigured, {
    configured: false, period: MONTH, monthlyTokenLimit: null, usedTokens: 500, remainingTokens: null,
  });
  s._state["schoolLimits/s1"] = { monthlyTokens: { student: 0, teacher: 0 } };
  const zero = await quota.getManagedUsage({ uid: "u1", schoolId: "s1", role: "student" }, { store: s });
  assert.deepEqual(zero, {
    configured: true, period: MONTH, monthlyTokenLimit: 0, usedTokens: 500, remainingTokens: 0,
  });
  await assert.rejects(quota.getManagedUsage({ uid: "", schoolId: "s1", role: "student" }, { store: s }),
    (e) => e.code === "INVALID_REQUEST");
});

// ---------- Validator authority ----------

test("validator rejects every client token-count field", () => {
  const base = { requestId: "r1", modelKey: "mdl_a", messages: [{ role: "user", content: "hi" }] };
  for (const field of ["inputTokens", "outputTokens", "totalTokens", "usedTokens", "remainingTokens", "reservedTokens", "maxOutputTokens", "monthlyTokenLimit"]) {
    assert.throws(() => validator.validateChatBody({ ...base, [field]: 1 }), (e) => e.code === "INVALID_REQUEST", field);
  }
});

test("reservationId is deterministic per uid+requestId", () => {
  assert.equal(quota.reservationIdFor("u1", "r1"), quota.reservationIdFor("u1", "r1"));
  assert.notEqual(quota.reservationIdFor("u1", "r1"), quota.reservationIdFor("u1", "r2"));
  assert.notEqual(quota.reservationIdFor("u1", "r1"), quota.reservationIdFor("u2", "r1"));
  assert.match(quota.reservationIdFor("u1", "r1"), /^[0-9a-f]{64}$/);
});

// ---------- Phase 9A.1: dispatched risk boundary ----------

test("classifyFinalization: only pre-dispatch releases", () => {
  assert.equal(quota.classifyFinalization({ upstreamDispatched: false, usage: { inputTokens: 999, outputTokens: 999 } }), "release");
  assert.equal(quota.classifyFinalization({ upstreamDispatched: true, usage: { inputTokens: 10, outputTokens: 0 } }), "commit");
  assert.equal(quota.classifyFinalization({ upstreamDispatched: true, usage: { inputTokens: 0, outputTokens: 0 } }), "charge");
  assert.equal(quota.classifyFinalization({ upstreamDispatched: true }), "charge");
  assert.equal(quota.classifyFinalization({ upstreamDispatched: true, usage: null }), "charge");
});

test("markDispatched persists risk boundary; idempotent; owner-checked", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  const d1 = await quota.markDispatched({
    reservationId: r.reservationId, period: MONTH, uid: "u1", schoolId: "s1", role: "student",
  }, { store: s });
  assert.equal(d1.state, "dispatched");
  assert.equal(s._state[rpath("u1", "r1")].state, "dispatched");
  assert.equal(s._state[upath("u1")].activeReservations[r.reservationId].state, "dispatched");
  // No counters moved by dispatch.
  assert.deepEqual(
    [s._state[upath("u1")].inputTokens, s._state[upath("u1")].requests, s._state[spath("s1")] || null],
    [0, 0, null]
  );
  const d2 = await quota.markDispatched({
    reservationId: r.reservationId, period: MONTH, uid: "u1", schoolId: "s1", role: "student",
  }, { store: s });
  assert.equal(d2.state, "dispatched");
  await assert.rejects(
    quota.markDispatched({ reservationId: r.reservationId, period: MONTH, uid: "intruder" }, { store: s }),
    (e) => e.code === "INVALID_REQUEST"
  );
  await assert.rejects(quota.markDispatched({ reservationId: "nope", period: MONTH }, { store: s }),
    (e) => e.code === "INTERNAL");
});

test("markStarted accepts dispatched; full lifecycle reserved→started→completed", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const st = await quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.equal(st.state, "started");
  const c = await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 50, actualOutputTokens: 60, finalState: "completed",
  }, { store: s });
  assert.equal(c.committed, 110);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 0);
});

test("2xx + markStarted outage NEVER releases (mandatory regression)", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve({ inputUpperBound: 1000 }), { store: s });
  await quota.markDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  // Simulate quota-store outage exactly at markStarted: force failure.
  const broken = fakeStore();
  broken.runTransaction = async () => {
    const err = new Error("store down");
    err.code = "UNAVAILABLE";
    throw err;
  };
  await assert.rejects(
    quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: broken }),
    (e) => e.code === "UNAVAILABLE"
  );
  // The durable DISPATCHED record must not take the zero-charge path:
  // failBeforeStart redirects provider-risk states to conservative charge.
  const out = await quota.failBeforeStart({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.equal(out.charged, r.reservedTokens);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, r.reservedTokens);
  // And the route-level decision for dispatched + unknown usage is charge.
  assert.equal(quota.classifyFinalization({ upstreamDispatched: true, usage: { inputTokens: 0, outputTokens: 0 } }), "charge");
});

test("failDispatched terminalizes definite rejections with zero charge", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const out = await quota.failDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.deepEqual({ released: out.released, charged: out.charged }, { released: true, charged: 0 });
  const doc = s._state[upath("u1")];
  assert.deepEqual([doc.inputTokens, doc.outputTokens, doc.conservativeChargedTokens, doc.requests], [0, 0, 0, 0]);
  assert.deepEqual(Object.keys(doc.activeReservations), []);
  assert.equal(s._state[rpath("u1", "r1")].state, "failed");
  assert.equal(s._state[spath("s1")], undefined);
  // Terminal repeat is a safe no-op.
  const again = await quota.failDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.equal(again.charged, 0);
  // Started docs are rejected loudly (route never sends them here).
  const r2 = await quota.reserveUsage(baseReserve({ requestId: "r2" }), { store: s });
  await quota.markDispatched({ reservationId: r2.reservationId, period: MONTH }, { store: s });
  await quota.markStarted({ reservationId: r2.reservationId, period: MONTH }, { store: s });
  await assert.rejects(quota.failDispatched({ reservationId: r2.reservationId, period: MONTH }, { store: s }),
    (e) => e.code === "INTERNAL");
});

test("stale dispatched charges conservatively like stale started", async () => {
  const s = fakeStore();
  seedLimits(s);
  const past = Date.now() - 1000;
  seedUsage(s, "u1", {
    activeReservations: {
      oldD: { amount: 4000, state: "dispatched", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  });
  s._state[`usageMonthly/${MONTH}/reservations/oldD`] = {
    reservationId: "oldD", state: "dispatched", reservedTokens: 4000,
    uid: "u1", schoolId: "s1", role: "student", modelKey: "mdl_a",
  };
  const out = await quota.reserveUsage(baseReserve({ requestId: "fresh" }), { store: s });
  assert.ok(out.reservationId);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 4000);
  assert.equal(s._state[upath("u1")].requests, 1);
  assert.equal(s._state[`usageMonthly/${MONTH}/reservations/oldD`].state, "expired");
  assert.equal(s._state[spath("s1")].conservativeChargedTokens, 4000);
});

test("same-requestId stale dispatched: cleanup commits, then refusal, no double charge", async () => {
  const s = fakeStore();
  seedLimits(s);
  const past = Date.now() - 1000;
  const rid = quota.reservationIdFor("u1", "r1");
  seedUsage(s, "u1", {
    activeReservations: {
      [rid]: { amount: 5096, state: "dispatched", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  });
  s._state[`usageMonthly/${MONTH}/reservations/${rid}`] = {
    reservationId: rid, state: "dispatched", reservedTokens: 5096,
    uid: "u1", schoolId: "s1", role: "student", modelKey: "mdl_a", requestId: "r1", expiresAt: past,
  };
  // First retry: cleanup MUST persist (no throw-inside-txn rollback)...
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_ALREADY_PROCESSED");
  assert.equal(s._state[`usageMonthly/${MONTH}/reservations/${rid}`].state, "expired");
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 5096);
  assert.deepEqual(Object.keys(s._state[upath("u1")].activeReservations), []);
  // Second retry: still refused, exactly-once accounting preserved.
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_ALREADY_PROCESSED");
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 5096);
  assert.equal(s._state[upath("u1")].requests, 1);
});

test("same-requestId stale reserved: cleanup commits, then refusal", async () => {
  const s = fakeStore();
  seedLimits(s);
  const past = Date.now() - 1000;
  const rid = quota.reservationIdFor("u1", "r1");
  seedUsage(s, "u1", {
    activeReservations: {
      [rid]: { amount: 1000, state: "reserved", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  });
  s._state[`usageMonthly/${MONTH}/reservations/${rid}`] = {
    reservationId: rid, state: "reserved", reservedTokens: 1000,
    uid: "u1", schoolId: "s1", role: "student", modelKey: "mdl_a", requestId: "r1", expiresAt: past,
  };
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_ALREADY_PROCESSED");
  assert.equal(s._state[`usageMonthly/${MONTH}/reservations/${rid}`].state, "expired");
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 0);
  assert.equal(s._state[upath("u1")].requests, 0);
});

test("same-requestId stale started: cleanup commits, then refusal, no duplicate", async () => {
  const s = fakeStore();
  seedLimits(s);
  const past = Date.now() - 1000;
  const rid = quota.reservationIdFor("u1", "r1");
  seedUsage(s, "u1", {
    activeReservations: {
      [rid]: { amount: 2000, state: "started", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  });
  s._state[`usageMonthly/${MONTH}/reservations/${rid}`] = {
    reservationId: rid, state: "started", reservedTokens: 2000,
    uid: "u1", schoolId: "s1", role: "student", modelKey: "mdl_a", requestId: "r1", expiresAt: past,
  };
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_ALREADY_PROCESSED");
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 2000);
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_ALREADY_PROCESSED");
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 2000);
  assert.equal(s._state[upath("u1")].requests, 1);
});

test("active dispatched duplicate returns IN_PROGRESS", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  await assert.rejects(quota.reserveUsage(baseReserve(), { store: s }),
    (e) => e.code === "REQUEST_IN_PROGRESS");
});

test("usage view treats expired dispatched/started as used, reserved as free", async () => {
  const s = fakeStore();
  seedLimits(s, { student: 20000, teacher: 20000 });
  const past = Date.now() - 1000;
  seedUsage(s, "u1", {
    inputTokens: 1000,
    activeReservations: {
      d: { amount: 3000, state: "dispatched", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      t: { amount: 4000, state: "started", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      r: { amount: 5000, state: "reserved", expiresAt: past, modelKey: "mdl_a", schoolId: "s1", role: "student" },
      live: { amount: 1000, state: "dispatched", expiresAt: Date.now() + 600000, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  });
  const out = await quota.getManagedUsage({ uid: "u1", schoolId: "s1", role: "student" }, { store: s });
  // used = 1000 + 3000 + 4000; active = 1000; remaining = 20000 - 8000 - 1000
  assert.deepEqual([out.usedTokens, out.remainingTokens], [8000, 11000]);
  // Read-only: nothing mutated.
  assert.equal(s._state[upath("u1")].activeReservations.d.state, "dispatched");
});

// ---------- Phase 9A.1: accepted-upstream accounting ----------

test("accepted + markStarted outage charges via finalizeAcceptedUnknownUsage (mandatory)", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve({ inputUpperBound: 1000 }), { store: s });
  await quota.markDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  // markStarted store outage: force failure with a broken store wrapper.
  const broken = { ...s, runTransaction: async () => { throw Object.assign(new Error("down"), { code: "UNAVAILABLE" }); } };
  await assert.rejects(
    quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: broken }),
    (e) => e.code === "UNAVAILABLE"
  );
  // Real store untouched by the failed write: doc still DISPATCHED.
  assert.equal(s._state[rpath("u1", "r1")].state, "dispatched");
  // Accepted-unknown finalization charges full reservation, exactly once.
  const out = await quota.finalizeAcceptedUnknownUsage({
    reservationId: r.reservationId, period: MONTH, finalState: "failed",
  }, { store: s });
  assert.equal(out.charged, r.reservedTokens);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, r.reservedTokens);
  assert.equal(s._state[upath("u1")].requests, 1);
  assert.equal(s._state[rpath("u1", "r1")].state, "failed");
  assert.equal(s._state[rpath("u1", "r1")].providerAccepted, true);
  const again = await quota.finalizeAcceptedUnknownUsage({
    reservationId: r.reservationId, period: MONTH, finalState: "failed",
  }, { store: s });
  assert.equal(again.alreadyTerminal, true);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, r.reservedTokens);
});

test("accepted + accounting outage leaves durable dispatched for stale recovery", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await quota.markDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const broken = { ...s, runTransaction: async () => { throw Object.assign(new Error("down"), { code: "UNAVAILABLE" }); } };
  // Both markStarted AND conservative finalization fail (full outage):
  await assert.rejects(
    quota.markStarted({ reservationId: r.reservationId, period: MONTH }, { store: broken }),
    (e) => e.code === "UNAVAILABLE"
  );
  await assert.rejects(
    quota.finalizeAcceptedUnknownUsage({ reservationId: r.reservationId, period: MONTH }, { store: broken }),
    (e) => e.code === "UNAVAILABLE"
  );
  // Doc must remain non-terminal DISPATCHED with map entry intact — never
  // released, never zeroed; stale recovery will charge it later.
  assert.equal(s._state[rpath("u1", "r1")].state, "dispatched");
  assert.ok(s._state[upath("u1")].activeReservations[r.reservationId]);
  assert.equal(s._state[upath("u1")].conservativeChargedTokens, 0);
});

test("failBeforeStart on provider-risk doc charges instead of releasing", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve({ inputUpperBound: 1000 }), { store: s });
  await quota.markDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  const out = await quota.failBeforeStart({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.equal(out.charged, r.reservedTokens);
  assert.equal(s._state[rpath("u1", "r1")].state, "failed");
});

test("finalizeAcceptedUnknownUsage validates state and identity", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  await assert.rejects(
    quota.finalizeAcceptedUnknownUsage({ reservationId: r.reservationId, period: MONTH, finalState: "completed" }, { store: s }),
    (e) => e.code === "INVALID_REQUEST"
  );
  const missing = await quota.finalizeAcceptedUnknownUsage({ reservationId: "nope", period: MONTH }, { store: s });
  assert.equal(missing.alreadyTerminal, true);
  // Works from still-reserved doc when provider acceptance is asserted.
  const out = await quota.finalizeAcceptedUnknownUsage({
    reservationId: r.reservationId, period: MONTH, finalState: "cancelled",
  }, { store: s });
  assert.equal(out.charged, r.reservedTokens);
  assert.equal(out.state, "cancelled");
});

test("state transitions reject illegal jumps safely", async () => {
  const s = fakeStore();
  seedLimits(s);
  const r = await quota.reserveUsage(baseReserve(), { store: s });
  // commit from reserved is tolerated (exact actuals known) — no crash:
  const c = await quota.commitUsage({
    reservationId: r.reservationId, period: MONTH,
    actualInputTokens: 5, actualOutputTokens: 5, finalState: "completed",
  }, { store: s });
  assert.equal(c.committed, 10);
  // ...but a second terminal action is a no-op, never a second charge:
  const again = await quota.failDispatched({ reservationId: r.reservationId, period: MONTH }, { store: s });
  assert.equal(again.charged, 0);
  assert.equal(s._state[upath("u1")].inputTokens, 5);
});

test('serialized school parent and three children admit only affordable simultaneous holds', async () => {
  const s = fakeStore(); seedLimits(s, { student: 6500 });
  const original = s.runTransaction.bind(s); let tail = Promise.resolve();
  s.runTransaction = fn => { const next = tail.then(() => original(fn)); tail = next.catch(() => {}); return next; };
  const outcomes = await Promise.allSettled(['parent', 'child1', 'child2', 'child3'].map(requestId => quota.reserveUsage(baseReserve({ requestId, inputUpperBound: 1000, defaultMaxOutputTokens: 1000 }), { store: s })));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(Object.keys(s._state[upath('u1')].activeReservations).length, 3);
  assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'MONTHLY_LIMIT_EXCEEDED');
});

