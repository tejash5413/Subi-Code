// test/orderingTx.js — Firestore read-before-write enforcement fake.
// Models ONLY the ordering invariant enforced by the installed
// @google-cloud/firestore Transaction.get/getAll: once any write is queued,
// any subsequent read throws the same plain client-side Error (no .code).
//
// merge:true models REAL Firestore recursive-merge semantics for the prune
// regression (Phase 9B.2M): nested maps merge key-by-key, so omitting a key
// does NOT delete it — only the FieldValue.delete() sentinel (recognized by
// identity, same singleton production code uses) physically removes a
// nested field. Deliberately nothing more; not a Firestore reimplementation.
const { FieldValue } = require("firebase-admin/firestore");
const { fundingQuery } = require('./fundingQueries');

function refAt(key) {
  return {
    _key: key,
    collection: (sub) => ({ doc: (id) => refAt(`${key}/${sub}/${id}`) }),
  };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (value === FieldValue.delete()) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function applyMerge(target, source) {
  const out = { ...(target && typeof target === "object" ? target : {}) };
  for (const [key, value] of Object.entries(source || {})) {
    if (value === FieldValue.delete()) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = applyMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Shared document-write helper for test fakes: models Firestore set()
// with and without {merge:true}, including FieldValue.delete() sentinels.
// Import this (instead of hand-rolled shallow merges) in any fake whose
// code under test prunes nested map keys.
function writeDoc(oldDoc, data, options) {
  if (options && options.merge) return applyMerge(oldDoc, data);
  const cleaned = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === FieldValue.delete()) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function orderingStore(initialState) {
  const state = { ...(initialState || {}) };
  const directGet = async (key) => {
    const v = state[key];
    return { exists: v !== undefined, data: () => v };
  };
  function refAt(key) {
    return {
      _key: key,
      // Direct (non-transactional) document read. Outside transactions the
      // reads-before-writes rule does not apply; used by read-only views.
      get: () => directGet(key),
      collection: (sub) => ({ ...fundingQuery(state, `${key}/${sub}`), doc: (id) => refAt(`${key}/${sub}/${id}`) }),
    };
  }
  return {
    state,
    collection: (name) => ({ doc: (id) => refAt(`${name}/${id}`) }),
    async runTransaction(fn) {
      let writes = 0;
      const ops = [];
      const tx = {
        ops,
        async get(ref) {
          ops.push("get");
          if (writes > 0) {
            throw new Error(
              "Firestore transactions require all reads to be executed before all writes."
            );
          }
          const v = state[ref._key];
          return { exists: v !== undefined, data: () => v };
        },
        async getAll(...refs) {
          ops.push("getAll");
          if (writes > 0) {
            throw new Error(
              "Firestore transactions require all reads to be executed before all writes."
            );
          }
          return refs.map((ref) => {
            const v = state[ref._key];
            return { exists: v !== undefined, data: () => v };
          });
        },
        set(ref, data, options) {
          ops.push("set");
          writes += 1;
          if (options && options.merge) {
            state[ref._key] = applyMerge(state[ref._key], data);
          } else {
            // Overwrite path still honors delete sentinels like Firestore.
            const cleaned = {};
            for (const [key, value] of Object.entries(data || {})) {
              if (value === FieldValue.delete()) continue;
              cleaned[key] = value;
            }
            state[ref._key] = cleaned;
          }
        },
        update(ref, data) {
          ops.push("update");
          writes += 1;
          state[ref._key] = applyMerge(state[ref._key], data);
        },
        create(ref, data) {
          ops.push("create");
          writes += 1;
          state[ref._key] = data;
        },
        delete(ref) {
          ops.push("delete");
          writes += 1;
          delete state[ref._key];
        },
      };
      return fn(tx);
    },
  };
}

/** Static op-sequence assertion: no read may follow the first write. */
function assertReadsFirst(ops, what, assert) {
  let sawWrite = false;
  for (const op of ops) {
    if (op === "get" || op === "getAll") {
      assert.equal(sawWrite, false, `${what}: read ${op} after write (${ops.join(",")})`);
    } else {
      sawWrite = true;
    }
  }
}

module.exports = { orderingStore, assertReadsFirst, applyMerge, writeDoc };
