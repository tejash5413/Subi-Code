// functions-subi/test/_fakesFailingSubiDb.js
// Phase 9B.1A: a fake subi Firestore that can be programmed to fail
// specific transactions (commitUsage / failBeforeStart / finalizeUnknown /
// markStarted / etc.) with a Firestore-shaped transient error.
//
// Failure schedule: a queue of { match, error } records. The `match` is a
// string token that callers set as a one-shot flag on the fake before the
// action under test. The fake pops the first matching record on each
// `runTransaction` call and rejects the transaction body. After the queue
// is exhausted, the fake behaves like the happy-path fake.
//
// Usage:
//   const store = makeFakeSubiDb({ failNext: { kind: "commitUsage", code: "ABORTED" } });
//   ... exercise ...
//   assert.equal(store.failuresConsumed, 1);

const crypto = require("crypto");
const { writeDoc } = require("./orderingTx");

const FIRESTORE_TRANSIENT_CODES = new Set(["ABORTED", "UNAVAILABLE", "DEADLINE_EXCEEDED", "INTERNAL"]);
const FIRESTORE_PERMANENT_CODES = new Set([
  "PERMISSION_DENIED",
  "FAILED_PRECONDITION",
  "NOT_FOUND",
  "INVALID_ARGUMENT",
  "ALREADY_EXISTS",
  "RESOURCE_EXHAUSTED",
]);

function makeFakeFailingSubiDb({ failNext } = {}) {
  const state = {};
  const failures = [];
  let transactionCallCount = 0;
  const queue = [];
  if (failNext) queue.push(failNext);

  function firestoreError(code) {
    const err = new Error(`firestore fake: ${code}`);
    err.code = code;
    if (FIRESTORE_TRANSIENT_CODES.has(code)) err.transient = true;
    if (FIRESTORE_PERMANENT_CODES.has(code)) err.permanent = true;
    return err;
  }

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
    add: async (doc) => {
      const id = `auto${Object.keys(state).length}`;
      state[`${prefix}/${id}`] = doc;
      return { id };
    },
  });

  let tail = Promise.resolve();
  const store = {
    _state: state,
    _failures: failures,
    _queue: queue,
    _transactionCallCount: () => transactionCallCount,
    _setFailure: (spec) => {
      queue.push(spec);
    },
    _clearFailures: () => {
      queue.length = 0;
    },
    _popMatch: (kind) => {
      for (let i = 0; i < queue.length; i++) {
        if (!queue[i].kind || queue[i].kind === kind) {
          return queue.splice(i, 1)[0];
        }
      }
      return null;
    },
    collection: (name) => coll(name),
    runTransaction(fn) {
      transactionCallCount += 1;
      const txKindHint = store._lastExpectedKind || null;
      const failure = store._popMatch(txKindHint || "any");
      const cur = tail.then(async () => {
        if (failure) {
          failures.push(Object.assign({ txCall: transactionCallCount }, failure));
          throw firestoreError(failure.code || "ABORTED");
        }
        const tx = {
          // Phase 9B.2M: sentinel-aware merge (see orderingTx.writeDoc).
          set: (ref, data, options) => {
            state[ref._key] = writeDoc(state[ref._key], data, options);
          },
          get: async (ref) => {
            const key = ref._key;
            return { exists: key in state, data: () => state[key] };
          },
        };
        return fn(tx);
      });
      tail = cur.catch(() => {});
      return cur;
    },
  };

  // Helper: the route's commit path can be tagged before the run. Tests
  // call store._expectKind("commit") to route the next failure spec to a
  // transaction that matches the expected kind.
  store._expectKind = (kind) => {
    store._lastExpectedKind = kind;
  };
  store._clearExpectedKind = () => {
    store._lastExpectedKind = null;
  };

  return store;
}

// Helper: instrument a fake so a specific quota method rejects with a given
// error for the next N invocations. The wrapper proxies the rest of the
// quota service so the test still exercises real lifecycle logic.
function wrapQuotaService(quota, spec) {
  const targets = Array.isArray(spec.methods) ? spec.methods : [spec.method];
  const errorCode = spec.code || "ABORTED";
  let remaining = spec.failures || 1;
  const original = {};
  for (const name of targets) {
    original[name] = quota[name];
    if (typeof original[name] !== "function") continue;
    quota[name] = async function patched(...args) {
      if (remaining > 0) {
        remaining -= 1;
        const err = new Error(`quota fake: ${name} → ${errorCode}`);
        err.code = errorCode;
        throw err;
      }
      return original[name].apply(this, args);
    };
  }
  return function restore() {
    for (const name of targets) {
      if (original[name]) quota[name] = original[name];
    }
  };
}

module.exports = {
  makeFakeFailingSubiDb,
  wrapQuotaService,
  FIRESTORE_TRANSIENT_CODES,
  FIRESTORE_PERMANENT_CODES,
};
