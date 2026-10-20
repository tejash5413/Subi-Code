// functions-subi/test/finalizeWithRetry.test.js — Phase 9B.1A.
// Verifies the bounded-retry finalization helper:
//   - exact commit retry on transient failure → succeeds and never double-charges
//   - exact commit all-retries-fail → ACCOUNTING_UNAVAILABLE, durable state intact
//   - conservative charge retry on transient failure → succeeds once
//   - conservative charge all-retries-fail → ACCOUNTING_UNAVAILABLE
//   - pre-provider release retry on transient failure → succeeds
//   - pre-provider release all-retries-fail → ACCOUNTING_UNAVAILABLE, RESERVED intact
//   - ambiguous commit (commit succeeded but caller saw error) → idempotent retry
//     observes terminal doc, does NOT double charge
//   - kind immutability: retries always invoke the SAME kind
//   - logging safety: structured events emitted, no banned fields
//   - structured logger failure cannot affect accounting
//
// Fakes only. No real Firestore, no real OpenRouter, no real auth.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const SRC = path.join("functions-subi", "src");

function freshBoot() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(SRC)) delete require.cache[k];
  }
  // Fake db that is happy by default.
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
    limit: (n) => ({ async get() { return { docs: [] }; } }),
    add: async (doc) => {
      const id = `auto${Object.keys(state).length}`;
      state[`${prefix}/${id}`] = doc;
      return { id };
    },
  });
  let tail = Promise.resolve();
  const fake = {
    _state: state,
    collection: (name) => coll(name),
    runTransaction(fn) {
      const cur = tail.then(async () => {
        const tx = {
          set: (ref, data) => {
            state[ref._key] = { ...(state[ref._key] || {}), ...data };
          },
          get: async (ref) => ({ exists: ref._key in state, data: () => state[ref._key] }),
        };
        return fn(tx);
      });
      tail = cur.catch(() => {});
      return cur;
    },
  };
  const dbPath = require.resolve("../src/db");
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { admin: {}, learnsmartDb: {}, subiDb: fake },
  };
  const fwr = require("../src/routes/_finalizeWithRetry");
  const log = require("../src/utils/structuredLogger");
  return { fwr, log, state, fake };
}

function baseParams(over = {}) {
  return Object.assign({
    reservationId: "rid-1",
    period: "2026-09",
    modelKey: "mdl_a",
    requestId: "9b1-test-1",
  }, over);
}

// ---------- Test 23: exact commit retry (attempt 1 fails, attempt 2 succeeds) ----------
test("exact commit retry: attempt 1 fails transient, attempt 2 succeeds", async () => {
  const { fwr, log } = freshBoot();
  const events = [];
  log._setLoggerForTests({
    info: (d) => events.push({ level: "info", data: d }),
    warn: (d) => events.push({ level: "warn", data: d }),
    error: (d) => events.push({ level: "error", data: d }),
    debug: () => {},
    log: () => {},
  });

  const quota = {
    calls: 0,
    async commitUsage() {
      this.calls += 1;
      if (this.calls === 1) {
        const err = new Error("transient");
        err.code = "ABORTED";
        throw err;
      }
      return { reservationId: "rid-1", state: "completed", committed: 42, alreadyTerminal: false };
    },
  };

  const finalize = fwr.create({
    kind: "commit",
    params: baseParams({ actualInputTokens: 10, actualOutputTokens: 32 }),
    deps: { quota, sleep: async () => {} },
  });
  const result = await finalize();
  log._resetLoggerForTests();
  assert.equal(result.settled, true);
  assert.equal(result.accountingFinalized, true);
  assert.equal(result.code, "OK");
  assert.equal(result.outcome.committed, 42);
  assert.equal(quota.calls, 2);
  const retryEvent = events.find((e) => e.data && e.data.action === "managed-chat-finalize-retry");
  const finalEvent = events.find((e) => e.data && e.data.action === "managed-chat-finalized");
  assert.ok(retryEvent, "retry event must be emitted");
  assert.ok(finalEvent, "finalized event must be emitted");
  assert.equal(retryEvent.data.retryAttempt, 1);
  assert.equal(finalEvent.data.retryAttempt, 2);
});

// ---------- Test 24: exact commit all-retries-fail ----------
test("exact commit all retries fail: ACCOUNTING_UNAVAILABLE, no fallback to conservative", async () => {
  const { fwr, log } = freshBoot();
  const events = [];
  log._setLoggerForTests({
    info: () => {}, warn: (d) => events.push({ level: "warn", data: d }),
    error: (d) => events.push({ level: "error", data: d }),
    debug: () => {}, log: () => {},
  });

  let chargeCalls = 0;
  const quota = {
    async commitUsage() {
      const err = new Error("transient");
      err.code = "ABORTED";
      throw err;
    },
    async finalizeStartedUnknownUsage() {
      chargeCalls += 1;
      throw new Error("must not be called on commit-failure path");
    },
  };
  const finalize = fwr.create({
    kind: "commit",
    params: baseParams({ actualInputTokens: 10, actualOutputTokens: 32 }),
    deps: { quota, sleep: async () => {} },
  });
  const result = await finalize();
  log._resetLoggerForTests();
  assert.equal(result.accountingFinalized, false);
  assert.equal(result.code, "ACCOUNTING_UNAVAILABLE");
  assert.equal(chargeCalls, 0);
  const failedEvent = events.find((e) => e.data && e.data.action === "managed-chat-finalize-failed");
  assert.ok(failedEvent, "finalize-failed event must be emitted");
  assert.equal(failedEvent.data.accountingOutcome, "failed");
});

// ---------- Test 25: conservative finalizer retry ----------
test("conservative finalizer retry: attempt 1 fails, attempt 2 succeeds", async () => {
  const { fwr } = freshBoot();
  let calls = 0;
  const quota = {
    async finalizeStartedUnknownUsage() {
      calls += 1;
      if (calls === 1) {
        const err = new Error("transient");
        err.code = "UNAVAILABLE";
        throw err;
      }
      return { reservationId: "rid-1", charged: 4501, state: "failed" };
    },
  };
  const finalize = fwr.create({
    kind: "charge",
    params: baseParams({ finalState: "failed" }),
    deps: { quota, sleep: async () => {} },
  });
  const result = await finalize();
  assert.equal(result.accountingFinalized, true);
  assert.equal(calls, 2);
  assert.equal(result.outcome.charged, 4501);
});

// ---------- Test 26: conservative all-retries-fail ----------
test("conservative finalizer all retries fail: ACCOUNTING_UNAVAILABLE", async () => {
  const { fwr } = freshBoot();
  let commitCalls = 0;
  const quota = {
    async finalizeStartedUnknownUsage() {
      const err = new Error("transient");
      err.code = "ABORTED";
      throw err;
    },
    async commitUsage() {
      commitCalls += 1;
      throw new Error("must not switch to commit");
    },
  };
  const finalize = fwr.create({
    kind: "charge",
    params: baseParams({ finalState: "failed" }),
    deps: { quota, sleep: async () => {} },
  });
  const result = await finalize();
  assert.equal(result.accountingFinalized, false);
  assert.equal(result.code, "ACCOUNTING_UNAVAILABLE");
  assert.equal(commitCalls, 0);
});

// ---------- Test 27: pre-provider release retry ----------
test("pre-provider release retry: attempt 1 fails, retry succeeds", async () => {
  const { fwr, state } = freshBoot();
  // Pre-seed a reserved doc so the release has something to do.
  state["usageMonthly/2026-09/reservations/rid-1"] = {
    reservationId: "rid-1",
    uid: "u1",
    period: "2026-09",
    state: "reserved",
    reservedTokens: 4501,
    modelKey: "mdl_a",
    schoolId: "s1",
    role: "student",
  };
  state["usageMonthly/2026-09/users/u1"] = {
    activeReservations: { "rid-1": { amount: 4501, state: "reserved" } },
  };
  let calls = 0;
  const quota = {
    async failBeforeStart() {
      calls += 1;
      if (calls === 1) {
        const err = new Error("transient");
        err.code = "ABORTED";
        throw err;
      }
      return { reservationId: "rid-1", released: true, charged: 0 };
    },
  };
  const finalize = fwr.create({
    kind: "release",
    params: baseParams(),
    deps: { quota, sleep: async () => {} },
  });
  const result = await finalize();
  assert.equal(result.accountingFinalized, true);
  assert.equal(calls, 2);
});

// ---------- Test 28: pre-provider release all-retries-fail ----------
test("pre-provider release all retries fail: ACCOUNTING_UNAVAILABLE, RESERVED intact", async () => {
  const { fwr, state } = freshBoot();
  state["usageMonthly/2026-09/reservations/rid-1"] = {
    reservationId: "rid-1", uid: "u1", period: "2026-09",
    state: "reserved", reservedTokens: 4501, modelKey: "mdl_a", schoolId: "s1", role: "student",
  };
  let commitCalls = 0;
  const quota = {
    async failBeforeStart() {
      const err = new Error("transient");
      err.code = "ABORTED";
      throw err;
    },
    async commitUsage() {
      commitCalls += 1;
      throw new Error("must not switch to commit");
    },
  };
  const finalize = fwr.create({
    kind: "release",
    params: baseParams(),
    deps: { quota, sleep: async () => {} },
  });
  const result = await finalize();
  assert.equal(result.accountingFinalized, false);
  assert.equal(result.code, "ACCOUNTING_UNAVAILABLE");
  // RESERVED doc must still exist for TTL sweep.
  const doc = state["usageMonthly/2026-09/reservations/rid-1"];
  assert.ok(doc, "reservation doc must remain");
  assert.equal(doc.state, "reserved");
  assert.equal(commitCalls, 0);
});

// ---------- Test 31: ambiguous commit (commit applied but caller saw error) ----------
test("ambiguous commit: first call commits, second call sees terminal doc, does not double charge", async () => {
  const { fwr, state } = freshBoot();
  let calls = 0;
  const quota = {
    async commitUsage({ actualInputTokens, actualOutputTokens }) {
      calls += 1;
      if (calls === 1) {
        // Simulate: transaction committed, but caller sees a transport error.
        // The fake still records the write, so the doc ends up terminal.
        state["usageMonthly/2026-09/reservations/rid-1"] = {
          reservationId: "rid-1", uid: "u1", period: "2026-09",
          state: "completed", reservedTokens: 4501, modelKey: "mdl_a", schoolId: "s1", role: "student",
          actualInputTokens, actualOutputTokens,
        };
        state["usageMonthly/2026-09/users/u1"] = {
          inputTokens: actualInputTokens, outputTokens: actualOutputTokens,
          requests: 1, activeReservations: {},
        };
        const err = new Error("transient after write");
        err.code = "ABORTED";
        throw err;
      }
      return { reservationId: "rid-1", state: "completed", alreadyTerminal: true, committed: 0 };
    },
  };
  // Two distinct finalizers, each with the same intent (commit).
  const f1 = fwr.create({
    kind: "commit",
    params: baseParams({ actualInputTokens: 10, actualOutputTokens: 32 }),
    deps: { quota, sleep: async () => {} },
  });
  const f2 = fwr.create({
    kind: "commit",
    params: baseParams({ actualInputTokens: 10, actualOutputTokens: 32 }),
    deps: { quota, sleep: async () => {} },
  });
  const r1 = await f1();
  const r2 = await f2();
  // First finalizer retried (because first attempt errored). The second
  // attempt observed the already-terminal doc and returned idempotent
  // success. The user's accounting IS finalized (commit landed) — we
  // just had an ambiguous transport error. The fresh finalizer f2 also
  // sees the terminal doc on its first attempt.
  assert.equal(r1.accountingFinalized, true);
  assert.equal(r1.outcome.alreadyTerminal, true);
  assert.equal(r2.accountingFinalized, true);
  assert.equal(r2.outcome.alreadyTerminal, true);
  // User doc must have requests=1, NOT 2 (no double charge).
  const u = state["usageMonthly/2026-09/users/u1"];
  assert.equal(u.requests, 1, "must not double-increment requests");
  assert.equal(u.inputTokens, 10);
  assert.equal(u.outputTokens, 32);
});

// ---------- Test 32 + 33: logging safety ----------
test("logging: no banned field reaches structured logger", async () => {
  const { fwr, log } = freshBoot();
  const events = [];
  log._setLoggerForTests({
    info: (d) => events.push(d),
    warn: (d) => events.push(d),
    error: (d) => events.push(d),
    debug: () => {}, log: () => {},
  });
  const quota = {
    async commitUsage() {
      const err = new Error("fake");
      err.code = "ABORTED";
      throw err;
    },
  };
  const finalize = fwr.create({
    kind: "commit",
    params: baseParams({ requestId: "9b1-secret-prompt-sk-test", actualInputTokens: 1, actualOutputTokens: 1 }),
    deps: { quota, sleep: async () => {} },
  });
  await finalize();
  log._resetLoggerForTests();
  // Inspect all emitted events for banned substrings.
  const dump = JSON.stringify(events);
  for (const banned of [
    "sk-", "Bearer ", "Authorization", "apiKey", "apikey",
    "prompt", "completion", "messages", "secret", "upstreamModelId",
    "9b1-secret-prompt-sk-test",
  ]) {
    assert.equal(dump.includes(banned), false, `log emitted banned token ${banned}`);
  }
  // requestIdHash should be present, NOT the raw requestId.
  const retryEvent = events.find((e) => e && e.action === "managed-chat-finalize-retry");
  assert.ok(retryEvent.requestIdHash, "requestIdHash must be present");
  assert.notEqual(retryEvent.requestId, "9b1-secret-prompt-sk-test", "raw requestId must NOT be logged");
});

// ---------- Test: logger failure cannot affect accounting ----------
test("logging: throw in logger does not affect accounting result", async () => {
  const { fwr, log } = freshBoot();
  log._setLoggerForTests({
    info: () => { throw new Error("logger broken"); },
    warn: () => { throw new Error("logger broken"); },
    error: () => { throw new Error("logger broken"); },
    debug: () => {}, log: () => {},
  });
  const quota = {
    async commitUsage() { return { committed: 42, state: "completed" }; },
  };
  const finalize = fwr.create({
    kind: "commit",
    params: baseParams({ actualInputTokens: 1, actualOutputTokens: 1 }),
    deps: { quota, sleep: async () => {} },
  });
  const result = await finalize();
  log._resetLoggerForTests();
  assert.equal(result.accountingFinalized, true, "accounting must succeed despite logger throwing");
});

// ---------- Test: single-shot guarantee ----------
test("repeated calls to the same finalizer return the cached result", async () => {
  const { fwr } = freshBoot();
  let calls = 0;
  const quota = {
    async commitUsage() { calls += 1; return { committed: 1 }; },
  };
  const finalize = fwr.create({
    kind: "commit",
    params: baseParams({ actualInputTokens: 1, actualOutputTokens: 0 }),
    deps: { quota, sleep: async () => {} },
  });
  const a = await finalize();
  const b = await finalize();
  assert.equal(a, b, "must return the same result object");
  assert.equal(calls, 1, "inner action must run exactly once");
});

// ---------- Test: kind immutability ----------
test("retry does not switch kind: commit failure never falls back to charge", async () => {
  const { fwr } = freshBoot();
  const seenKinds = [];
  const quota = {
    async commitUsage() {
      seenKinds.push("commit");
      const err = new Error("transient");
      err.code = "ABORTED";
      throw err;
    },
    async finalizeStartedUnknownUsage() {
      seenKinds.push("charge");
      throw new Error("must not be called");
    },
  };
  const finalize = fwr.create({
    kind: "commit",
    params: baseParams({ actualInputTokens: 1, actualOutputTokens: 1 }),
    deps: { quota, sleep: async () => {} },
  });
  await finalize();
  assert.deepEqual(seenKinds, ["commit", "commit", "commit"]);
});

// ---------- Test: missing reservationId ----------
test("create: throws on missing reservationId", () => {
  const { fwr } = freshBoot();
  const quota = {};
  assert.throws(() =>
    fwr.create({ kind: "commit", params: { period: "2026-09", modelKey: "mdl_a", requestId: "r" }, deps: { quota } })
  );
});

// ---------- Test: MAX_ATTEMPTS is exactly 3 ----------
test("MAX_ATTEMPTS is 3 with bounded backoff [0, 50, 150]", () => {
  const { fwr } = freshBoot();
  assert.equal(fwr.MAX_ATTEMPTS, 3);
  assert.deepEqual(fwr.BACKOFF_MS, [0, 50, 150]);
});
