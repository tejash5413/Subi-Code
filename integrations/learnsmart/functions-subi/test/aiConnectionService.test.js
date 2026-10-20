// test/aiConnectionService.test.js — Phase 2A behavior with fakes only.
// No real Secret Manager, no network, no Firestore.
const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../src/services/aiConnectionService");
const { checkKeyShape } = require("../src/services/keyValidator");
const { errorBody, statusFor, stripSensitive } = require("../src/utils/redact");

// ---- fakes ----
function fakeStore(initial) {
  let doc = initial === undefined ? null : initial;
  return {
    collection() {
      return { doc: () => ref() };
    },
  };
  function ref() {
    return {
      async get() {
        return { exists: doc !== null, data: () => doc };
      },
    };
  }
}
// runTransaction executes the txn body against the live doc
function withTxn(store) {
  const s = store;
  s.runTransaction = async (fn) => {
    const tx = {
      set: (r, data) => {
        s._doc = { ...(s._doc || {}), ...data };
      },
    };
    await fn(tx);
  };
  Object.defineProperty(s, "_doc", { value: null, writable: true });
  const orig = s.collection;
  s.collection = () => ({
    doc: () => ({
      async get() {
        return { exists: s._doc !== null, data: () => s._doc };
      },
    }),
  });
  return s;
}
function deps(store, { valid = true, code = "INVALID_AI_CREDENTIAL", addFails = false } = {}) {
  const audits = [];
  return {
    store,
    secrets: {
      MANAGED_SECRET_ID: "SUBI_OPENROUTER_API_KEY",
      async addVersion() {
        if (addFails) throw new Error("sm down");
        store._n = (store._n || 1) + 1;
        return { version: String(store._n) };
      },
      async accessVersion(v) {
        return Buffer.from(`payload-for-${v}`);
      },
    },
    validator: {
      checkKeyShape: (k) => ({ ok: true, key: String(k).trim() }),
      async validateWithOpenRouter() {
        return valid ? { ok: true } : { ok: false, code };
      },
    },
    audits: {
      async logAudit(e) {
        audits.push(e);
        return { id: "a1" };
      },
      _list: audits,
    },
  };
}

test("valid configure activates version", async () => {
  const store = withTxn(fakeStore());
  const d = deps(store);
  const out = await svc.configure("transient-key", "admin1", d);
  assert.equal(out.version, "2");
  assert.equal(store._doc.configured, true);
  assert.equal(store._doc.activeSecretVersion, "2");
  assert.equal(store._doc.previousSecretVersion, null);
  assert.equal(store._doc.status, "ready");
  assert.equal(d.audits._list[0].action, "ai_connection.configured");
});

test("invalid configure changes nothing", async () => {
  const store = withTxn(fakeStore());
  const d = deps(store, { valid: false });
  await assert.rejects(svc.configure("bad", "admin1", d), /validation failed/);
  assert.equal(store._doc, null);
});

test("already configured rejects", async () => {
  const store = withTxn(fakeStore());
  store._doc = { configured: true, activeSecretVersion: "2" };
  const d = deps(store);
  await assert.rejects(svc.configure("k", "a", d), (e) => e.code === "ALREADY_CONFIGURED");
});

test("valid replace shifts pointer, keeps old", async () => {
  const store = withTxn(fakeStore());
  store._doc = { configured: true, activeSecretVersion: "2", status: "ready" };
  const d = deps(store);
  store._n = 2;
  const out = await svc.replace("new-key", "admin1", d);
  assert.equal(out.version, "3");
  assert.equal(store._doc.activeSecretVersion, "3");
  assert.equal(store._doc.previousSecretVersion, "2");
});

test("invalid replace preserves active pointer", async () => {
  const store = withTxn(fakeStore());
  store._doc = { configured: true, activeSecretVersion: "2", status: "ready" };
  const d = deps(store, { valid: false });
  await assert.rejects(svc.replace("bad", "a", d));
  assert.equal(store._doc.activeSecretVersion, "2");
  assert.equal(store._doc.previousSecretVersion, undefined);
});

test("remove clears pointer via txn only", async () => {
  const store = withTxn(fakeStore());
  store._doc = { configured: true, activeSecretVersion: "3", previousSecretVersion: "2" };
  const d = deps(store);
  await svc.remove("admin1", d);
  assert.equal(store._doc.configured, false);
  assert.equal(store._doc.activeSecretVersion, null);
  assert.equal(store._doc.previousSecretVersion, null);
  assert.equal(d.audits._list[0].action, "ai_connection.removed");
});

test("rollback swaps active/previous", async () => {
  const store = withTxn(fakeStore());
  store._doc = { configured: true, activeSecretVersion: "3", previousSecretVersion: "2" };
  const d = deps(store);
  const out = await svc.rollback("admin1", d);
  assert.equal(out.version, "2");
  assert.equal(store._doc.activeSecretVersion, "2");
  assert.equal(store._doc.previousSecretVersion, "3");
});

test("rollback without previous rejects", async () => {
  const store = withTxn(fakeStore());
  store._doc = { configured: true, activeSecretVersion: "3" };
  await assert.rejects(svc.rollback("a", deps(store)), (e) => e.code === "NO_ROLLBACK_VERSION");
});

test("status shape is safe", async () => {
  const store = withTxn(fakeStore());
  store._doc = {
    configured: true,
    status: "ready",
    activeSecretVersion: "9",
    previousSecretVersion: "8",
    lastValidatedAt: "t",
    updatedAt: "u",
  };
  const s = await svc.getStatus(deps(store));
  assert.deepEqual(Object.keys(s).sort(), ["configured", "lastValidatedAt", "status", "updatedAt"]);
});

test("resolve returns backend-only buffer; empty when not configured", async () => {
  const store = withTxn(fakeStore());
  store._doc = { configured: true, activeSecretVersion: "2" };
  const buf = await svc.resolveActiveManagedKey(deps(store));
  assert.ok(Buffer.isBuffer(buf));
  const empty = withTxn(fakeStore());
  await assert.rejects(svc.resolveActiveManagedKey(deps(empty)), (e) => e.code === "AI_NOT_CONFIGURED");
});

test("key shape checks", () => {
  assert.equal(checkKeyShape(123).ok, false);
  assert.equal(checkKeyShape("").ok, false);
  assert.equal(checkKeyShape("x".repeat(513)).ok, false);
  assert.equal(checkKeyShape("ab\ncd").ok, false);
  assert.equal(checkKeyShape("  sk-ok  ").ok, true);
});

test("error sanitization", () => {
  assert.deepEqual(errorBody("INVALID_AI_CREDENTIAL"), { error: { code: "INVALID_AI_CREDENTIAL" } });
  assert.deepEqual(errorBody("EVIL"), { error: { code: "INTERNAL" } });
  assert.equal(statusFor("AI_NOT_CONFIGURED"), 503);
  const stripped = stripSensitive({ apiKey: "sk-x", nested: { token: "t", ok: 1 } });
  assert.deepEqual(stripped, { apiKey: "[redacted]", nested: { token: "[redacted]", ok: 1 } });
});
