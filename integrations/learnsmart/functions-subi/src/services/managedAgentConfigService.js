// functions-subi/src/services/managedAgentConfigService.js
// Server-side managed-agent operational gate (Phase 13, local only).
//
// SEPARATE from Global SUBI Access AND from managed-chat gate: Access answers
// WHO may use SUBI; managedChat answers whether the TEXT runtime is
// operational; this answers whether the AGENT runtime is operational.
// Kill switch semantics: any missing/malformed state means DISABLED.
//
// Storage (named subi DB): systemConfig/managedAgent
//   { schemaVersion: 1, mode: "disabled"|"test"|"enabled",
//     testUids: [...], terminalEnabled?: boolean, jobsEnabled?: boolean,
//     jobsTestUids?: [...], coordinationEnabled?: boolean, updatedAt, updatedBy }
// terminalEnabled gates terminal turns (evaluateTerminalCapability); it is
// writable only through setManagedAgentConfig with an explicit boolean and
// is never cleared by callers that omit it.
// jobsTestUids is a bounded qualification-only allowlist: it enables jobs
// for listed identities only while the existing agent gate admits them.
// Missing/malformed lists grant nothing; omitted updates preserve the list.
//
// BOUNDARY: uses ONLY subiDb (via injected store). Never learnsmartDb,
// secrets, OpenRouter, fetch. No prompt/completion/message content.
//
// DI: methods accept optional `deps` ({ store, audits }) for fakes.

const { subiDb } = require("../db");

const SCHEMA_VERSION = 1;
const CONFIG_COLLECTION = "systemConfig";
const CONFIG_DOC = "managedAgent";

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
  const err = new Error(message || "invalid agent config payload");
  err.code = "INVALID_REQUEST";
  throw err;
}

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

function normalizeJobsTestUids(value) {
  if (!Array.isArray(value) || value.length > MAX_TEST_UIDS || value.some(uid =>
    typeof uid !== 'string' || !uid.trim() || uid.trim().length > MAX_UID_LEN)) {
    invalidRequest('jobsTestUids must contain at most ten nonempty UIDs');
  }
  return normalizeTestUids(value);
}

function safeJobsTestUids(value) {
  try { return normalizeJobsTestUids(value); } catch (_) { return []; }
}

function toSafeConfig(data) {
  const mode = data && typeof data.mode === "string" ? data.mode.trim().toLowerCase() : null;
  const testUids = data && Array.isArray(data.testUids)
    ? [...new Set(data.testUids.filter((u) => typeof u === "string"))].slice(0, MAX_TEST_UIDS)
    : [];
  return {
    mode: MODES.has(mode) ? mode : "disabled",
    testUids,
    ...(data && data.terminalEnabled === true ? { terminalEnabled: true } : {}),
    ...(data && data.jobsEnabled === true ? { jobsEnabled: true } : {}),
    ...(data && data.jobsTestUids !== undefined ? { jobsTestUids: safeJobsTestUids(data.jobsTestUids) } : {}),
    ...(data && data.coordinationEnabled === true ? { coordinationEnabled: true } : {}),
    updatedAt: (data && data.updatedAt) || null,
    updatedBy: (data && data.updatedBy) || null,
  };
}

async function getManagedAgentConfig(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  let snap;
  try {
    snap = await store.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
  } catch (_) {
    const err = new Error("config store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }
  return toSafeConfig(snap.exists ? snap.data() : null);
}

function evaluateAgentAvailability(config, uid) {
  const mode = config && MODES.has(config.mode) ? config.mode : "disabled";
  if (mode === "enabled") return { allowed: true, mode };
  if (mode === "test") {
    const id = cleanId(uid);
    const listed = Array.isArray(config.testUids) && config.testUids.includes(id);
    return { allowed: listed === true, mode, buildEntitlement: listed === true };
  }
  return { allowed: false, mode: "disabled" };
}

// Phase 15 staged activation: BUILD is test-UID-only. Even an agent config
// in global "enabled" mode grants no file capability, preventing an old or
// broad production config from enabling workspace mutation accidentally.
function evaluateFileCapability(config, uid) {
  const gate = evaluateAgentAvailability(config, uid);
  return gate.allowed === true && gate.buildEntitlement === true ? "build" : "none";
}

async function setManagedAgentConfig({ mode, testUids, adminUid, terminalEnabled, jobsEnabled, jobsTestUids, coordinationEnabled }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cleanMode = typeof mode === "string" ? mode.trim().toLowerCase() : null;
  if (!MODES.has(cleanMode)) invalidRequest("invalid mode");
  const uids = normalizeTestUids(testUids);
  // Terminal execution gate (Phase 18 repair): explicit boolean only. When
  // omitted (undefined) the stored flag is left untouched so legacy callers
  // can never clear a previously enabled gate by accident.
  if (terminalEnabled !== undefined && typeof terminalEnabled !== "boolean") {
    invalidRequest("terminalEnabled must be a boolean");
  }
  if (jobsEnabled !== undefined && typeof jobsEnabled !== 'boolean') invalidRequest('jobsEnabled must be a boolean');
  const jobsUids = jobsTestUids === undefined ? undefined : normalizeJobsTestUids(jobsTestUids);
  if (coordinationEnabled !== undefined && typeof coordinationEnabled !== 'boolean') invalidRequest('coordinationEnabled must be a boolean');
  const ref = d.store.collection(CONFIG_COLLECTION).doc(CONFIG_DOC);
  const before = await getManagedAgentConfig({ store: d.store });
  const now = new Date();
  let snap;
  try {
    snap = await ref.get();
  } catch (_) {
    const err = new Error("config store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        mode: cleanMode,
        testUids: uids,
        ...(terminalEnabled === undefined ? {} : { terminalEnabled }),
        ...(jobsEnabled === undefined ? {} : { jobsEnabled }),
        ...(jobsUids === undefined ? {} : { jobsTestUids: jobsUids }),
        ...(coordinationEnabled === undefined ? {} : { coordinationEnabled }),
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
      action: "managed_agent_config.updated",
      target: {},
      result: "success",
      before: { ...(before.coordinationEnabled === true || coordinationEnabled !== undefined ? { coordinationEnabled: before.coordinationEnabled === true } : {}), ...(before.jobsEnabled === true || jobsEnabled !== undefined ? { jobsEnabled: before.jobsEnabled === true } : {}), ...(before.jobsTestUids !== undefined || jobsUids !== undefined ? { jobsTestUids: before.jobsTestUids || [] } : {}), mode: before.mode, testUids: before.testUids, terminalEnabled: before.terminalEnabled === true },
      after: {
        mode: cleanMode,
        testUids: uids,
        ...(before.jobsEnabled === true || jobsEnabled !== undefined ? { jobsEnabled: jobsEnabled === undefined ? before.jobsEnabled === true : jobsEnabled } : {}),
        ...(before.jobsTestUids !== undefined || jobsUids !== undefined ? { jobsTestUids: jobsUids === undefined ? before.jobsTestUids : jobsUids } : {}),
        ...(before.coordinationEnabled === true || coordinationEnabled !== undefined ? { coordinationEnabled: coordinationEnabled === undefined ? before.coordinationEnabled === true : coordinationEnabled } : {}),
        terminalEnabled: terminalEnabled === undefined ? before.terminalEnabled === true : terminalEnabled,
      },
    },
    d.store
  );
  return {
    mode: cleanMode,
    testUids: uids,
    ...(terminalEnabled === undefined
      ? (before.terminalEnabled === true ? { terminalEnabled: true } : {})
      : (terminalEnabled ? { terminalEnabled: true } : {})),
    ...((jobsEnabled === undefined ? before.jobsEnabled === true : jobsEnabled) ? { jobsEnabled: true } : {}),
    ...(before.jobsTestUids !== undefined || jobsUids !== undefined ? { jobsTestUids: jobsUids === undefined ? before.jobsTestUids : jobsUids } : {}),
    ...((coordinationEnabled === undefined ? before.coordinationEnabled === true : coordinationEnabled) ? { coordinationEnabled: true } : {}),
    updatedAt: now,
    updatedBy: String(adminUid || "").slice(0, 128),
  };
}

function evaluateTerminalCapability(config, uid) {
  return config && config.mode === 'test' && config.terminalEnabled === true && evaluateFileCapability(config, uid) === 'build' ? 'terminal' : 'none';
}
function evaluateJobsCapability(config, uid) {
  const listed = typeof uid === 'string' && safeJobsTestUids(config?.jobsTestUids).includes(uid);
  return (config?.jobsEnabled === true || listed) && evaluateAgentAvailability(config, uid).allowed === true ? 'jobs_v1' : undefined;
}
function evaluateCoordinationCapability(config, uid) {
  return config?.coordinationEnabled === true && evaluateJobsCapability(config, uid) === 'jobs_v1' ? 'coordination_v1' : undefined;
}
module.exports = {
  evaluateCoordinationCapability,
  evaluateJobsCapability,
  evaluateTerminalCapability,
  MAX_TEST_UIDS,
  getManagedAgentConfig,
  evaluateAgentAvailability,
  evaluateFileCapability,
  normalizeTestUids,
  setManagedAgentConfig,
};
