// functions-subi/src/services/managedChatConfigService.js
// Server-side managed-chat operational gate (Phase 9A.1, local only).
//
// SEPARATE from Global SUBI Access: Access answers WHO may use SUBI;
// this answers whether the managed inference runtime is operational.
// Kill switch semantics: any missing/malformed state means DISABLED.
//
// Storage (named subi DB): systemConfig/managedChat
//   { schemaVersion: 1, mode: "disabled"|"test"|"enabled",
//     testUids: [...], updatedAt, updatedBy }
//
// BOUNDARY: uses ONLY subiDb (via injected store). Never learnsmartDb,
// secrets, OpenRouter, fetch. No prompt/completion/message content.
//
// DI: methods accept optional `deps` ({ store, audits }) for fakes.

const { subiDb } = require("../db");

const SCHEMA_VERSION = 1;
const CONFIG_COLLECTION = "systemConfig";
const CONFIG_DOC = "managedChat";

const MODES = new Set(["disabled", "test", "enabled"]);
const MAX_TEST_UIDS = 10;
const MAX_UID_LEN = 128;

function defaultDeps() {
  return { store: subiDb, audits: require("./auditService") };
}

function cleanId(value, max = 128) {
  return String(value || "").trim().slice(0, max);
}

function invalidRequest(message) {
  const err = new Error(message || "invalid chat config payload");
  err.code = "INVALID_REQUEST";
  throw err;
}

// Normalize testUids: deduplicated non-empty UID-like strings, hard cap on
// UNIQUE entries (dedupe first, so resubmitting a stored list plus a
// duplicate never fails). Throws INVALID_REQUEST on wrong shape or oversize.
function normalizeTestUids(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidRequest("testUids must be an array");
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") invalidRequest("testUid must be a string");
    const uid = raw.trim().slice(0, MAX_UID_LEN);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    if (seen.size > MAX_TEST_UIDS) invalidRequest("too many testUids");
    out.push(uid);
  }
  return out;
}

function toSafeConfig(data) {
  const mode = data && typeof data.mode === "string" ? data.mode.trim().toLowerCase() : null;
  const testUids = data && Array.isArray(data.testUids)
    ? [...new Set(data.testUids.filter((u) => typeof u === "string"))].slice(0, MAX_TEST_UIDS)
    : [];
  return {
    mode: MODES.has(mode) ? mode : "disabled",
    testUids,
    updatedAt: (data && data.updatedAt) || null,
    updatedBy: (data && data.updatedBy) || null,
  };
}

async function getManagedChatConfig(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  let snap;
  try {
    snap = await store.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
  } catch (_) {
    const err = new Error("config store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }
  // Missing/unreadable doc fails closed to disabled.
  return toSafeConfig(snap.exists ? snap.data() : null);
}

// Availability decision for one authenticated UID. Never exposes testUids.
// Test allowlist does NOT bypass Access/Models/Limits/Quota — the chat
// route still runs every authority check; this only gates the runtime.
function evaluateChatAvailability(config, uid) {
  const mode = config && MODES.has(config.mode) ? config.mode : "disabled";
  if (mode === "enabled") return { allowed: true, mode };
  if (mode === "test") {
    const id = cleanId(uid);
    const listed = Array.isArray(config.testUids) && config.testUids.includes(id);
    return { allowed: listed === true, mode };
  }
  return { allowed: false, mode: "disabled" };
}

// Safe capability diagnostic (Phase 9B.3B.1). Computed from the SAME
// normalized values as evaluateChatAvailability — same mode mapping, same
// cleanId(uid), same testUids membership test — so chatAvailable always
// agrees with evaluateChatAvailability for normalized configs. Returns
// categorical fields ONLY: never UIDs, modes beyond class, test lists,
// or config contents. Malformed config fails closed.
function evaluateChatCapability(config, uid) {
  const rawMode = config && typeof config.mode === "string" ? config.mode.trim().toLowerCase() : null;
  const modeClass = rawMode === "disabled" || rawMode === "test" || rawMode === "enabled" ? rawMode : "invalid";
  const list = config && Array.isArray(config.testUids) ? config.testUids : [];
  const testUidCount = Math.min(MAX_TEST_UIDS, list.filter((u) => typeof u === "string").length);
  const id = cleanId(uid);
  if (modeClass === "enabled") {
    return { chatAvailable: true, chatModeClass: "enabled", testUidCount, testUidMatched: false };
  }
  if (modeClass === "test") {
    const matched = list.includes(id) === true;
    return { chatAvailable: matched, chatModeClass: "test", testUidCount, testUidMatched: matched };
  }
  return {
    chatAvailable: false,
    chatModeClass: modeClass === "disabled" ? "disabled" : "invalid",
    testUidCount,
    testUidMatched: false,
  };
}

async function setManagedChatConfig({ mode, testUids, adminUid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cleanMode = typeof mode === "string" ? mode.trim().toLowerCase() : null;
  if (!MODES.has(cleanMode)) invalidRequest("invalid mode");
  const uids = normalizeTestUids(testUids);
  const ref = d.store.collection(CONFIG_COLLECTION).doc(CONFIG_DOC);
  const before = await getManagedChatConfig({ store: d.store });
  const now = new Date();
  let snap;
  try {
    snap = await ref.get();
  } catch (_) {
    const err = new Error("config store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }
  // testUids retained but ignored unless mode is test (quick rollback).
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        mode: cleanMode,
        testUids: uids,
        ...(snap.exists ? {} : { createdAt: now }),
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      },
      { merge: true }
    );
  });
  await d.audits.logAudit(
    {
      adminUid,
      action: "managed_chat_config.updated",
      target: {},
      result: "success",
      before: { mode: before.mode, testUids: before.testUids },
      after: { mode: cleanMode, testUids: uids },
    },
    d.store
  );
  return {
    mode: cleanMode,
    testUids: uids,
    updatedAt: now,
    updatedBy: String(adminUid || "").slice(0, 128),
  };
}

module.exports = {
  MAX_TEST_UIDS,
  getManagedChatConfig,
  evaluateChatAvailability,
  evaluateChatCapability,
  normalizeTestUids,
  setManagedChatConfig,
};
