// test/dispatchPhase.test.js — dispatchPhase propagation (Phase 9B.2I).
// Exercises the REAL markDispatched with an instrumented fake store.
// No Firestore, no network. Pure unit tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const quota = require("../src/services/usageQuotaService");

const PERIOD = "2026-09";
const RID = "r-phase-1";

function refAt(key) {
  return {
    _key: key,
    collection: (sub) => ({ doc: (id) => refAt(`${key}/${sub}/${id}`) }),
  };
}

function fakeStore(state, { throwOnGetAt, throwOnTxn } = {}) {
  let gets = 0;
  const writes = [];
  const tx = {
    writes,
    async get(ref) {
      gets += 1;
      if (throwOnGetAt !== undefined && gets >= throwOnGetAt) {
        throw new Error("boom-txn-get");
      }
      const v = state[ref._key];
      return { exists: v !== undefined, data: () => v };
    },
    set(ref, data) {
      writes.push({ key: ref._key, data });
    },
  };
  return {
    tx,
    store: {
      collection: (name) => ({ doc: (id) => refAt(`${name}/${id}`) }),
      async runTransaction(fn) {
        if (throwOnTxn) throw new Error("boom-txn-start");
        return fn(tx);
      },
    },
  };
}

function reservedState() {
  const state = {};
  state[`usageMonthly/${PERIOD}/reservations/${RID}`] = {
    reservationId: RID,
    uid: "u1",
    period: PERIOD,
    requestId: "req-1",
    modelKey: "mdl_a",
    schoolId: "s1",
    role: "student",
    inputUpperBound: 100,
    maxOutputTokens: 100,
    reservedTokens: 200,
    state: "reserved",
  };
  state[`usageMonthly/${PERIOD}/users/u1`] = {
    activeReservations: {
      [RID]: { amount: 200, state: "reserved", expiresAt: Date.now() + 600000, modelKey: "mdl_a", schoolId: "s1", role: "student" },
    },
  };
  return state;
}

const ARGS = { reservationId: RID, period: PERIOD, uid: "u1", schoolId: "s1", role: "student" };

void test("validation failure attaches pre_transaction and preserves the error", async () => {
  const { store } = fakeStore({});
  await assert.rejects(quota.markDispatched({ ...ARGS, reservationId: "" }, { store }), (err) => {
    assert.equal(err.code, "INVALID_REQUEST");
    assert.equal(err.dispatchPhase, "pre_transaction");
    assert.equal(err.isSubiDomainError, true);
    return true;
  });
});

void test("runTransaction failure attaches pre_transaction", async () => {
  const { store } = fakeStore(reservedState(), { throwOnTxn: true });
  await assert.rejects(quota.markDispatched(ARGS, { store }), (err) => {
    assert.equal(err.dispatchPhase, "pre_transaction");
    assert.equal(err.message, "boom-txn-start");
    return true;
  });
});

void test("first read failure attaches transaction_entered", async () => {
  const { store } = fakeStore(reservedState(), { throwOnGetAt: 1 });
  await assert.rejects(quota.markDispatched(ARGS, { store }), (err) => {
    assert.equal(err.dispatchPhase, "transaction_entered");
    assert.equal(err.message, "boom-txn-get");
    return true;
  });
});

void test("second read failure attaches reservation_read (last completed checkpoint)", async () => {
  const { store } = fakeStore(reservedState(), { throwOnGetAt: 2 });
  await assert.rejects(quota.markDispatched(ARGS, { store }), (err) => {
    // Phase 9B.2J: both reads precede all writes, so a user-read failure
    // surfaces with the reservation_read checkpoint (last one completed).
    assert.equal(err.message, "boom-txn-get");
    assert.equal(err.code, undefined);
    assert.equal(err.dispatchPhase, "reservation_read");
    return true;
  });
});

void test("success path returns dispatched without touching error machinery", async () => {
  const { store, tx } = fakeStore(reservedState());
  const out = await quota.markDispatched(ARGS, { store });
  assert.deepEqual(out, { reservationId: RID, state: "dispatched" });
  assert.equal(tx.writes.length, 2);
});

void test("pre-existing dispatchPhase marker is never overwritten", async () => {
  const preset = new Error("preset");
  preset.dispatchPhase = "custom-never-listed";
  const { store } = fakeStore(reservedState(), { throwOnGetAt: 1 });
  // Force the preset through: failing get wrapped to rethrow our error.
  const throwing = {
    collection: store.collection,
    async runTransaction(fn) {
      const tx = {
        async get() {
          throw preset;
        },
        set() {},
      };
      return fn(tx);
    },
  };
  await assert.rejects(quota.markDispatched(ARGS, { store: throwing }), (err) => {
    assert.equal(err, preset);
    assert.equal(err.dispatchPhase, "custom-never-listed");
    return true;
  });
});
