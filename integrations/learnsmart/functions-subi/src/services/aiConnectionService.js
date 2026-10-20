// functions-subi/src/services/aiConnectionService.js
// AI-connection lifecycle orchestration (Phase 2A).
//
// BOUNDARY: may import ONLY subiDb (via injected store defaulting to it).
// Never learnsmartDb. Secret Manager primitives stay inside secretService.
// Transient keys flow: validate -> addSecretVersion -> activate pointer,
// then the local reference is dropped. Key material never touches Firestore.
//
// Dependency injection: every method accepts an optional `deps` override
// { store, secrets, validator, audits } so unit tests use fakes and Phase
// 2A never needs the real Secret Manager resource or network.

const { subiDb } = require("../db");
const secretService = require("./secretService");
const keyValidator = require("./keyValidator");
const auditService = require("./auditService");

const CONNECTION_DOC = ["systemConfig", "aiConnection"];
const SCHEMA_VERSION = 1;

function defaultDeps() {
  return { store: subiDb, secrets: secretService, validator: keyValidator, audits: auditService };
}

function docRef(store) {
  return store.collection(CONNECTION_DOC[0]).doc(CONNECTION_DOC[1]);
}

function toSafeStatus(data) {
  if (!data) {
    return { configured: false, status: "not_configured", lastValidatedAt: null, updatedAt: null };
  }
  return {
    configured: data.configured === true,
    status: data.status === "ready" ? "ready" : "not_configured",
    lastValidatedAt: data.lastValidatedAt || null,
    updatedAt: data.updatedAt || null,
  };
}

async function getStatus(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const snap = await docRef(store).get();
  return toSafeStatus(snap.exists ? snap.data() : null);
}

async function configure(transientKey, adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const snap = await docRef(d.store).get();
  if (snap.exists && snap.data() && snap.data().configured === true) {
    const err = new Error("already configured");
    err.code = "ALREADY_CONFIGURED";
    throw err;
  }
  const shape = d.validator.checkKeyShape(transientKey);
  if (!shape.ok) {
    const err = new Error("bad key shape");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const check = await d.validator.validateWithOpenRouter(shape.key);
  if (!check.ok) {
    await d.audits.logAudit(
      {
        adminUid,
        action: "ai_connection.configured",
        target: { secretId: d.secrets.MANAGED_SECRET_ID },
        result: "failure",
        failureCode: check.code,
      },
      d.store
    );
    const err = new Error("validation failed");
    err.code = check.code;
    throw err;
  }
  let version;
  try {
    ({ version } = await d.secrets.addVersion(shape.key));
  } catch (_) {
    const err = new Error("secret unavailable");
    err.code = "SECRET_UNAVAILABLE";
    throw err;
  }
  const now = new Date();
  const first = !snap.exists;
  await d.store.runTransaction(async (tx) => {
    tx.set(
      docRef(d.store),
      {
        schemaVersion: SCHEMA_VERSION,
        configured: true,
        activeSecretVersion: version,
        previousSecretVersion: null,
        status: "ready",
        lastValidatedAt: now,
        ...(first ? { createdAt: now } : {}),
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      },
      { merge: true }
    );
  });
  await d.audits.logAudit(
    {
      adminUid,
      action: "ai_connection.configured",
      target: { secretId: d.secrets.MANAGED_SECRET_ID, version },
      result: "success",
    },
    d.store
  );
  return { version };
}

async function replace(transientKey, adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const snap = await docRef(d.store).get();
  const current = snap.exists ? snap.data() : null;
  if (!current || current.configured !== true || !current.activeSecretVersion) {
    const err = new Error("not configured");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  const shape = d.validator.checkKeyShape(transientKey);
  if (!shape.ok) {
    const err = new Error("bad key shape");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const check = await d.validator.validateWithOpenRouter(shape.key);
  if (!check.ok) {
    await d.audits.logAudit(
      {
        adminUid,
        action: "ai_connection.replaced",
        target: { secretId: d.secrets.MANAGED_SECRET_ID },
        result: "failure",
        failureCode: check.code,
      },
      d.store
    );
    const err = new Error("validation failed");
    err.code = check.code;
    throw err;
  }
  let version;
  try {
    ({ version } = await d.secrets.addVersion(shape.key));
  } catch (_) {
    const err = new Error("secret unavailable");
    err.code = "SECRET_UNAVAILABLE";
    throw err;
  }
  const oldActive = String(current.activeSecretVersion);
  const now = new Date();
  await d.store.runTransaction(async (tx) => {
    tx.set(
      docRef(d.store),
      {
        schemaVersion: SCHEMA_VERSION,
        configured: true,
        activeSecretVersion: version,
        previousSecretVersion: oldActive,
        status: "ready",
        lastValidatedAt: now,
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      },
      { merge: true }
    );
  });
  await d.audits.logAudit(
    {
      adminUid,
      action: "ai_connection.replaced",
      target: { secretId: d.secrets.MANAGED_SECRET_ID, version },
      result: "success",
    },
    d.store
  );
  return { version, previousVersion: oldActive };
}

async function remove(adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const now = new Date();
  await d.store.runTransaction(async (tx) => {
    tx.set(
      docRef(d.store),
      {
        schemaVersion: SCHEMA_VERSION,
        configured: false,
        activeSecretVersion: null,
        previousSecretVersion: null,
        status: "not_configured",
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      },
      { merge: true }
    );
  });
  await d.audits.logAudit(
    {
      adminUid,
      action: "ai_connection.removed",
      target: { secretId: d.secrets.MANAGED_SECRET_ID },
      result: "success",
    },
    d.store
  );
  return { configured: false };
}

async function rollback(adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const snap = await docRef(d.store).get();
  const current = snap.exists ? snap.data() : null;
  if (!current || current.configured !== true || !current.previousSecretVersion) {
    const err = new Error("no rollback version");
    err.code = "NO_ROLLBACK_VERSION";
    throw err;
  }
  const now = new Date();
  const active = String(current.activeSecretVersion);
  const previous = String(current.previousSecretVersion);
  await d.store.runTransaction(async (tx) => {
    tx.set(
      docRef(d.store),
      {
        schemaVersion: SCHEMA_VERSION,
        configured: true,
        activeSecretVersion: previous,
        previousSecretVersion: active,
        status: "ready",
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      },
      { merge: true }
    );
  });
  await d.audits.logAudit(
    {
      adminUid,
      action: "ai_connection.rollback",
      target: { secretId: d.secrets.MANAGED_SECRET_ID, version: previous },
      result: "success",
    },
    d.store
  );
  return { version: previous };
}

// Managed-runtime helper: resolves the live key into backend memory only.
// Never serialize the result. No cache in Phase 2A.
async function resolveActiveManagedKey(deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const snap = await docRef(d.store).get();
  const current = snap.exists ? snap.data() : null;
  if (!current || current.configured !== true || !current.activeSecretVersion) {
    const err = new Error("not configured");
    err.code = "AI_NOT_CONFIGURED";
    throw err;
  }
  try {
    const payload = await d.secrets.accessVersion(String(current.activeSecretVersion));
    return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  } catch (_) {
    const err = new Error("secret unavailable");
    err.code = "SECRET_UNAVAILABLE";
    throw err;
  }
}

module.exports = { getStatus, configure, replace, remove, rollback, resolveActiveManagedKey };
