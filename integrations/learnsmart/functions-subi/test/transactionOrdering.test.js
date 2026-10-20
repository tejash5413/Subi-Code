// test/transactionOrdering.test.js — reads-before-writes regression (Phase 9B.2J).
// Core quota lifecycle runs against the ordering-enforcing fake: any
// read-after-write throws exactly like the installed Firestore client, so
// this class of bug cannot regress silently again.
const test = require("node:test");
const assert = require("node:assert/strict");
const quota = require("../src/services/usageQuotaService");
const { orderingStore, assertReadsFirst } = require("./orderingTx");

const PERIOD = quota.currentMonthIST();
const UID = "u1";
const SCHOOL = "s1";
const ROLE = "student";
const MODEL = "mdl_a";

function resKey(rid) {
  return `usageMonthly/${PERIOD}/reservations/${rid}`;
}
function userKey() {
  return `usageMonthly/${PERIOD}/users/${UID}`;
}
function schoolKey() {
  return `usageMonthly/${PERIOD}/schools/${SCHOOL}`;
}

function reservedDoc(rid, over = {}) {
  return {
    schemaVersion: 1,
    reservationId: rid,
    uid: UID,
    period: PERIOD,
    requestId: "req-1",
    modelKey: MODEL,
    schoolId: SCHOOL,
    role: ROLE,
    inputUpperBound: 400,
    maxOutputTokens: 4096,
    reservedTokens: 4496,
    state: "reserved",
    createdAt: new Date(),
    startedAt: null,
    expiresAt: Date.now() + 600000,
    completedAt: null,
    actualInputTokens: null,
    actualOutputTokens: null,
    conservativeChargedTokens: 0,
    finalReason: null,
    ...over,
  };
}

function userWith(entryRid, entry, extraEntries) {
  return {
    schemaVersion: 1,
    uid: UID,
    period: PERIOD,
    inputTokens: 0,
    outputTokens: 0,
    conservativeChargedTokens: 0,
    requests: 0,
    activeReservations: {
      ...(entryRid ? { [entryRid]: entry } : {}),
      ...(extraEntries || {}),
    },
    byModel: {},
  };
}

const OTHER_RID = "other-live-rid";
function otherLiveEntry() {
  return liveEntry({ amount: 1000, state: "reserved" });
}

function liveEntry(over = {}) {
  return {
    amount: 4496,
    state: "reserved",
    expiresAt: Date.now() + 600000,
    modelKey: MODEL,
    schoolId: SCHOOL,
    role: ROLE,
    ...over,
  };
}

function trackOps(store) {
  // Collect op names across every transaction run on this store, including
  // failed ones (recorded before the error propagates).
  const seen = [];
  const origTxn = store.runTransaction.bind(store);
  store.runTransaction = async (fn) => origTxn(async (tx) => {
    try {
      return await fn(tx);
    } finally {
      seen.push(...tx.ops);
    }
  });
  return seen;
}

void test("markDispatched succeeds with reads first; both docs dispatched", async () => {
  const rid = quota.reservationIdFor(UID, "req-1");
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid),
    [userKey()]: userWith(rid, liveEntry()),
  });
  const ops = trackOps(store);
  const out = await quota.markDispatched(
    { reservationId: rid, period: PERIOD, uid: UID, schoolId: SCHOOL, role: ROLE },
    { store }
  );
  assert.deepEqual(out, { reservationId: rid, state: "dispatched" });
  assertReadsFirst(ops, "markDispatched", assert);
  assert.equal(store.state[resKey(rid)].state, "dispatched");
  assert.ok(store.state[resKey(rid)].dispatchedAt instanceof Date);
  assert.equal(store.state[userKey()].activeReservations[rid].state, "dispatched");
});

void test("markStarted succeeds from dispatched under enforcement", async () => {
  const rid = quota.reservationIdFor(UID, "req-2");
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-2", state: "dispatched" }),
    [userKey()]: userWith(rid, liveEntry({ state: "dispatched" })),
  });
  const ops = trackOps(store);
  const out = await quota.markStarted({ reservationId: rid, period: PERIOD }, { store });
  assert.deepEqual(out, { reservationId: rid, state: "started" });
  assertReadsFirst(ops, "markStarted", assert);
  assert.equal(store.state[resKey(rid)].state, "started");
  assert.equal(store.state[userKey()].activeReservations[rid].state, "started");
});

void test("owner mismatch still rejects with domain error and zero writes", async () => {
  const rid = quota.reservationIdFor(UID, "req-3");
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-3" }),
    [userKey()]: userWith(rid, liveEntry()),
  });
  const ops = trackOps(store);
  await assert.rejects(
    quota.markDispatched({ reservationId: rid, period: PERIOD, uid: "intruder", schoolId: SCHOOL, role: ROLE }, { store }),
    (err) => {
      assert.equal(err.code, "INVALID_REQUEST");
      assert.equal(err.isSubiDomainError, true);
      return true;
    }
  );
  assert.ok(!ops.includes("set"), "no writes on validation failure");
  assertReadsFirst(ops, "owner-mismatch", assert);
});

void test("duplicate and terminal states keep exact semantics", async () => {
  for (const [state, expected] of [
    ["dispatched", "dispatched"],
    ["started", "started"],
  ]) {
    const rid = quota.reservationIdFor(UID, `req-dup-${state}`);
    const store = orderingStore({
      [resKey(rid)]: reservedDoc(rid, { requestId: `req-dup-${state}`, state }),
      [userKey()]: userWith(rid, liveEntry({ state })),
    });
    const ops = trackOps(store);
    const out = await quota.markDispatched(
      { reservationId: rid, period: PERIOD, uid: UID, schoolId: SCHOOL, role: ROLE },
      { store }
    );
    assert.deepEqual(out, { reservationId: rid, state: expected });
    assertReadsFirst(ops, `idempotent-${state}`, assert);
  }
  const termRid = quota.reservationIdFor(UID, "req-term");
  const termStore = orderingStore({
    [resKey(termRid)]: reservedDoc(termRid, { requestId: "req-term", state: "failed" }),
  });
  await assert.rejects(
    quota.markDispatched({ reservationId: termRid, period: PERIOD, uid: UID, schoolId: SCHOOL, role: ROLE }, { store: termStore }),
    (err) => {
      assert.equal(err.code, "REQUEST_ALREADY_PROCESSED");
      assert.equal(err.isSubiDomainError, true);
      return true;
    }
  );
  await assert.rejects(
    quota.markDispatched({ reservationId: "nope", period: PERIOD, uid: UID, schoolId: SCHOOL, role: ROLE }, { store: termStore }),
    (err) => {
      assert.equal(err.code, "INTERNAL");
      assert.equal(err.isSubiDomainError, true);
      return true;
    }
  );
});

void test("commit exact counters under enforcement; target physically absent, other preserved", async () => {
  const rid = quota.reservationIdFor(UID, "req-commit");
  const other = otherLiveEntry();
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-commit", state: "started" }),
    [userKey()]: userWith(rid, liveEntry({ state: "started" }), { [OTHER_RID]: other }),
  });
  const ops = trackOps(store);
  const out = await quota.commitUsage(
    { reservationId: rid, period: PERIOD, actualInputTokens: 10, actualOutputTokens: 5 },
    { store }
  );
  assert.equal(out.committed, 15);
  assertReadsFirst(ops, "commitUsage", assert);
  const user = store.state[userKey()];
  assert.deepEqual([user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests], [10, 5, 0, 1]);
  // Physical fossil assertion: the key must be absent from the STORED map,
  // not merely ignored by quota math; the unrelated entry is untouched.
  assert.ok(!(rid in user.activeReservations), "committed rid physically absent");
  assert.deepEqual(user.activeReservations[OTHER_RID], other);
  assert.equal(store.state[resKey(rid)].state, "completed");
});

void test("fail paths release zero-charge and physically drop the active entry", async () => {
  for (const [fn, args, finalState] of [
    ["failDispatched", {}, "failed"],
    ["failBeforeStart", {}, "failed"],
  ]) {
    const rid = quota.reservationIdFor(UID, `req-${fn}`);
    const other = otherLiveEntry();
    const store = orderingStore({
      [resKey(rid)]: reservedDoc(rid, { requestId: `req-${fn}` }),
      [userKey()]: userWith(rid, liveEntry(), { [OTHER_RID]: other }),
    });
    const ops = trackOps(store);
    const out = await quota[fn]({ reservationId: rid, period: PERIOD }, { store });
    assert.equal(out.charged, 0, fn);
    assertReadsFirst(ops, fn, assert);
    assert.equal(store.state[resKey(rid)].state, finalState, fn);
    const user = store.state[userKey()];
    assert.ok(!(rid in user.activeReservations), `${fn}: rid physically absent`);
    assert.deepEqual(user.activeReservations[OTHER_RID], other, `${fn}: other preserved`);
    assert.deepEqual(
      [user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests],
      [0, 0, 0, 0],
      `${fn}: zero charge`
    );
  }
});

void test("started unknown usage charges conservatively and prunes physically", async () => {
  const rid = quota.reservationIdFor(UID, "req-charge");
  const other = otherLiveEntry();
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-charge", state: "started" }),
    [userKey()]: userWith(rid, liveEntry({ state: "started" }), { [OTHER_RID]: other }),
  });
  const ops = trackOps(store);
  const out = await quota.finalizeStartedUnknownUsage({ reservationId: rid, period: PERIOD }, { store });
  assertReadsFirst(ops, "finalizeStartedUnknownUsage", assert);
  const user = store.state[userKey()];
  assert.equal(user.conservativeChargedTokens, 4496);
  assert.equal(user.requests, 1);
  assert.ok(!(rid in user.activeReservations), "charged rid physically absent");
  assert.deepEqual(user.activeReservations[OTHER_RID], other);
});

void test("school analytics increment from non-zero state (no silent reset)", async () => {
  const rid = quota.reservationIdFor(UID, "req-school");
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-school", state: "started" }),
    [userKey()]: userWith(rid, liveEntry({ state: "started" })),
    [schoolKey()]: {
      schoolId: SCHOOL,
      month: PERIOD,
      inputTokens: 100,
      outputTokens: 50,
      conservativeChargedTokens: 10,
      requests: 3,
      byRole: {},
      byModel: {},
    },
  });
  const ops = trackOps(store);
  await quota.commitUsage(
    { reservationId: rid, period: PERIOD, actualInputTokens: 7, actualOutputTokens: 3 },
    { store }
  );
  assertReadsFirst(ops, "commit-school", assert);
  const school = store.state[schoolKey()];
  assert.deepEqual(
    [school.inputTokens, school.outputTokens, school.conservativeChargedTokens, school.requests],
    [107, 53, 10, 4]
  );
});

void test("multi-expired sweep reads first, keeps exact stale semantics", async () => {
  const past = Date.now() - 1000;
  const live = Date.now() + 600000;
  const e1 = quota.reservationIdFor(UID, "req-old-1");
  const e2 = quota.reservationIdFor(UID, "req-old-2");
  const store = orderingStore({
    "schoolLimits/s1": { monthlyTokens: { student: 100000, teacher: 100000 } },
    [userKey()]: {
      schemaVersion: 1,
      uid: UID,
      period: PERIOD,
      inputTokens: 0,
      outputTokens: 0,
      conservativeChargedTokens: 0,
      requests: 0,
      activeReservations: {
        [e1]: { amount: 1000, state: "reserved", expiresAt: past, modelKey: MODEL, schoolId: SCHOOL, role: ROLE },
        [e2]: { amount: 2000, state: "started", expiresAt: past, modelKey: MODEL, schoolId: SCHOOL, role: ROLE },
        live9: { amount: 500, state: "reserved", expiresAt: live, modelKey: MODEL, schoolId: SCHOOL, role: ROLE },
      },
      byModel: {},
    },
    [resKey(e1)]: reservedDoc(e1, { requestId: "req-old-1", state: "reserved" }),
    [resKey(e2)]: reservedDoc(e2, { requestId: "req-old-2", state: "started" }),
    [`usageMonthly/${PERIOD}/reservations/live9`]: reservedDoc("live9", { requestId: "req-live", state: "reserved" }),
  });
  const ops = trackOps(store);
  const out = await quota.reserveUsage(
    { uid: UID, schoolId: SCHOOL, role: ROLE, modelKey: MODEL, requestId: "req-fresh", inputUpperBound: 100 },
    { store }
  );
  assertReadsFirst(ops, "reserve-with-sweep", assert);
  // Reserved-expired released, started-expired charged, live untouched.
  assert.equal(store.state[resKey(e1)].state, "expired");
  assert.equal(store.state[resKey(e1)].finalReason, "stale-reserved-released");
  assert.equal(store.state[resKey(e2)].state, "expired");
  assert.equal(store.state[resKey(e2)].finalReason, "stale-started-charged");
  const user = store.state[userKey()];
  assert.equal(user.conservativeChargedTokens, 2000);
  assert.equal(user.requests, 1);
  assert.ok(user.activeReservations.live9, "live entry preserved");
  assert.ok(!(e1 in user.activeReservations) && !(e2 in user.activeReservations), "swept entries physically absent");
  assert.ok(out.reservationId, "fresh reservation created");
});

void test("terminal cancel prunes physically and preserves others", async () => {
  const rid = quota.reservationIdFor(UID, "req-cancel");
  const other = otherLiveEntry();
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-cancel" }),
    [userKey()]: userWith(rid, liveEntry(), { [OTHER_RID]: other }),
  });
  const ops = trackOps(store);
  const out = await quota.cancelUsage({ reservationId: rid, period: PERIOD }, { store });
  assertReadsFirst(ops, "cancelUsage", assert);
  assert.equal(out.released, true);
  assert.equal(store.state[resKey(rid)].state, "cancelled");
  const user = store.state[userKey()];
  assert.ok(!(rid in user.activeReservations), "cancelled rid physically absent");
  assert.deepEqual(user.activeReservations[OTHER_RID], other);
  assert.deepEqual(
    [user.inputTokens, user.outputTokens, user.conservativeChargedTokens, user.requests],
    [0, 0, 0, 0]
  );
});

void test("fake merge fidelity: omission alone preserves, sentinel deletes", async () => {
  // Documents the Firestore merge:true trap this phase fixes: copying a map
  // minus one key and merging does NOT remove the stored key. Only the
  // explicit delete sentinel physically removes it.
  const store = orderingStore({
    [userKey()]: userWith("target-rid", liveEntry(), { [OTHER_RID]: otherLiveEntry() }),
  });
  const { FieldValue } = require("firebase-admin/firestore");
  await store.runTransaction(async (tx) => {
    const snap = await tx.get(store.collection(`usageMonthly/${PERIOD}/users`).doc(UID));
    const map = { ...snap.data().activeReservations };
    delete map["target-rid"];
    tx.set(store.collection(`usageMonthly/${PERIOD}/users`).doc(UID), { activeReservations: map }, { merge: true });
  });
  assert.ok("target-rid" in store.state[userKey()].activeReservations, "omission must NOT delete (fossil trap)");
  await store.runTransaction(async (tx) => {
    const snap = await tx.get(store.collection(`usageMonthly/${PERIOD}/users`).doc(UID));
    const map = { ...snap.data().activeReservations, ["target-rid"]: FieldValue.delete() };
    tx.set(store.collection(`usageMonthly/${PERIOD}/users`).doc(UID), { activeReservations: map }, { merge: true });
  });
  assert.ok(!("target-rid" in store.state[userKey()].activeReservations), "sentinel must delete");
  assert.ok(OTHER_RID in store.state[userKey()].activeReservations, "other preserved");
});

void test("remainingTokens excludes terminal target immediately (no TTL wait)", async () => {
  const rid = quota.reservationIdFor(UID, "req-remain");
  const store = orderingStore({
    "schoolLimits/s1": { monthlyTokens: { student: 1500000, teacher: 1500000 } },
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-remain", state: "started" }),
    [userKey()]: userWith(rid, liveEntry({ state: "started" })),
  });
  await quota.commitUsage(
    { reservationId: rid, period: PERIOD, actualInputTokens: 33, actualOutputTokens: 273 },
    { store }
  );
  // Real read path (non-transactional view, same as production).
  const usage = await quota.getManagedUsage({ uid: UID, schoolId: SCHOOL, role: ROLE }, { store });
  assert.equal(usage.usedTokens, 306);
  assert.equal(usage.remainingTokens, 1500000 - 306);
  assert.equal(usage.configured, true);
});

void test("active count drops terminal target immediately", async () => {
  const rid = quota.reservationIdFor(UID, "req-count");
  const other = otherLiveEntry();
  const store = orderingStore({
    [resKey(rid)]: reservedDoc(rid, { requestId: "req-count", state: "started" }),
    [userKey()]: userWith(rid, liveEntry({ state: "started" }), { [OTHER_RID]: other }),
  });
  await quota.commitUsage(
    { reservationId: rid, period: PERIOD, actualInputTokens: 1, actualOutputTokens: 1 },
    { store }
  );
  const remaining = store.state[userKey()].activeReservations;
  assert.deepEqual(Object.keys(remaining), [OTHER_RID]);
});
