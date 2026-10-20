// functions-subi/src/services/accessService.js
// SUBI access-control service (Phase 3A + 3B: Global + Individual override
// + School role defaults).
//
// BOUNDARY: may import ONLY subiDb (via injected store defaulting to it).
// Never learnsmartDb. Never secretService / OpenRouter / managed key —
// access admission is independent of AI Connection.
//
// AUTHORITATIVE EVALUATOR: evaluateEffective() is the single policy core
// used by resolveSubiAccess() (managed admission), individual GET, and
// batched search enrichment. Do NOT duplicate precedence elsewhere.
//
// DI: every method accepts optional `deps` ({ store, audits }) for fakes.

const { subiDb } = require("../db");
const auditService = require("./auditService");

const SCHEMA_VERSION = 1;
const GLOBAL_DOC = ["systemConfig", "subiAccess"];
const SCHOOL_COLLECTION = "schoolPolicies";
const USER_COLLECTION = "userPolicies";

const ACCESS_MODES = new Set(["inherit", "enabled", "disabled"]);

const MANAGED_ROLES = new Set(["student", "teacher"]);
const PERMISSION_PROFILES = new Set(["ask", "session", "full"]);
const PERMISSION_POLICY_TTL_MS = 5 * 60 * 1000;

function normalizePermissionProfileCeiling(value) {
  return PERMISSION_PROFILES.has(value) ? value : "ask";
}

function defaultDeps() {
  return { store: subiDb, audits: auditService };
}

function cleanId(value) {
  return String(value || "").trim().slice(0, 128);
}

function isEnabledFlag(value) {
  return value === true;
}

// ---------- Global ----------

async function getGlobalAccess(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const snap = await store.collection(GLOBAL_DOC[0]).doc(GLOBAL_DOC[1]).get();
  if (!snap.exists) return { enabled: false, updatedAt: null };
  const data = snap.data() || {};
  return {
    enabled: isEnabledFlag(data.enabled),
    updatedAt: data.updatedAt || null,
  };
}

async function setGlobalAccess({ enabled, adminUid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof enabled !== "boolean") {
    const err = new Error("invalid enabled flag");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const ref = d.store.collection(GLOBAL_DOC[0]).doc(GLOBAL_DOC[1]);
  const before = await getGlobalAccess({ store: d.store });
  const now = new Date();
  const snap = await ref.get();
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        enabled,
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
      action: enabled ? "subi_access.enabled" : "subi_access.disabled",
      target: {},
      result: "success",
      before: { enabled: before.enabled },
      after: { enabled },
    },
    d.store
  );
  return { enabled };
}

// ---------- School ----------

function toSafeSchoolPolicy(schoolId, data) {
  const roles = (data && data.roles) || {};
  return {
    schoolId,
    roles: {
      student: { enabled: isEnabledFlag(roles.student && roles.student.enabled), permissionProfileCeiling: normalizePermissionProfileCeiling(roles.student && roles.student.permissionProfileCeiling) },
      teacher: { enabled: isEnabledFlag(roles.teacher && roles.teacher.enabled), permissionProfileCeiling: normalizePermissionProfileCeiling(roles.teacher && roles.teacher.permissionProfileCeiling) },
    },
    updatedAt: (data && data.updatedAt) || null,
  };
}

async function getSchoolAccess(schoolId, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  if (!id) {
    const err = new Error("missing schoolId");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const snap = await store.collection(SCHOOL_COLLECTION).doc(id).get();
  return toSafeSchoolPolicy(id, snap.exists ? snap.data() : null);
}

async function setSchoolAccess({ schoolId, studentEnabled, teacherEnabled, studentPermissionProfileCeiling, teacherPermissionProfileCeiling, adminUid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  if (!id || typeof studentEnabled !== "boolean" || typeof teacherEnabled !== "boolean" ||
      (studentPermissionProfileCeiling !== undefined && !PERMISSION_PROFILES.has(studentPermissionProfileCeiling)) ||
      (teacherPermissionProfileCeiling !== undefined && !PERMISSION_PROFILES.has(teacherPermissionProfileCeiling))) {
    const err = new Error("invalid school policy payload");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const ref = d.store.collection(SCHOOL_COLLECTION).doc(id);
  const now = new Date();
  const { before, after } = await d.store.runTransaction(async (tx) => {
    // Read on every retry so omitted ceilings and audit snapshots describe
    // the version this transaction commits, including concurrent changes.
    const snap = await tx.get(ref);
    const before = toSafeSchoolPolicy(id, snap.exists ? snap.data() : null);
    const roles = {
      student: { enabled: studentEnabled, ...(studentPermissionProfileCeiling === undefined ? {} : { permissionProfileCeiling: studentPermissionProfileCeiling }) },
      teacher: { enabled: teacherEnabled, ...(teacherPermissionProfileCeiling === undefined ? {} : { permissionProfileCeiling: teacherPermissionProfileCeiling }) },
    };
    const afterRoles = {
      student: { ...before.roles.student, ...roles.student },
      teacher: { ...before.roles.teacher, ...roles.teacher },
    };
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        schoolId: id,
        roles,
        ...(snap.exists ? {} : { createdAt: now }),
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      },
      { merge: true }
    );
    return { before, after: toSafeSchoolPolicy(id, { roles: afterRoles, updatedAt: now }) };
  });
  await d.audits.logAudit(
    {
      adminUid,
      action: "school_role_access.changed",
      target: { schoolId: id },
      result: "success",
      before: {
        studentEnabled: before.roles.student.enabled,
        teacherEnabled: before.roles.teacher.enabled,
        studentPermissionProfileCeiling: before.roles.student.permissionProfileCeiling,
        teacherPermissionProfileCeiling: before.roles.teacher.permissionProfileCeiling,
      },
      after: { studentEnabled, teacherEnabled,
        studentPermissionProfileCeiling: after.roles.student.permissionProfileCeiling,
        teacherPermissionProfileCeiling: after.roles.teacher.permissionProfileCeiling },
    },
    d.store
  );
  return after;
}

// Only issued after access and entitlement admission. Context is derived
// from the authenticated directory; user access overrides cannot broaden it.
async function getManagedPermissionPolicy({ accountType, schoolId, role }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cleanRole = String(role || "").trim().toLowerCase();
  const id = cleanId(schoolId);
  if (!MANAGED_ROLES.has(cleanRole) || (accountType !== "school" && accountType !== "individual") || (accountType === "school" && !id)) {
    const err = new Error("invalid permission policy context");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  let profileCeiling = "full";
  if (accountType === "school") {
    try {
      const policy = await getSchoolAccess(id, { store: d.store });
      profileCeiling = policy.roles[cleanRole].permissionProfileCeiling;
    } catch (_) {
      const err = new Error("permission policy store unavailable");
      err.code = "UNAVAILABLE";
      throw err;
    }
  }
  return { schemaVersion: 1, profileCeiling, source: accountType === "school" ? "school_role" : "individual", validUntilMs: Date.now() + PERMISSION_POLICY_TTL_MS };
}

// ---------- Individual user policy ----------

function normalizeAccessMode(value) {
  const v = String(value || "").trim().toLowerCase();
  return ACCESS_MODES.has(v) ? v : null;
}

async function getUserAccess(uid, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) {
    const err = new Error("missing uid");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const snap = await store.collection(USER_COLLECTION).doc(id).get();
  if (!snap.exists) {
    return { uid: id, accessMode: "inherit", lastKnownSchoolId: null, lastKnownRole: null, updatedAt: null };
  }
  const data = snap.data() || {};
  return {
    uid: id,
    accessMode: normalizeAccessMode(data.accessMode) || "inherit",
    lastKnownSchoolId: data.lastKnownSchoolId || null,
    lastKnownRole: data.lastKnownRole || null,
    updatedAt: data.updatedAt || null,
  };
}

async function setUserAccess({ uid, accessMode, adminUid, trustedUser }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const mode = normalizeAccessMode(accessMode);
  if (!id || !mode) {
    const err = new Error("invalid user policy payload");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const ref = d.store.collection(USER_COLLECTION).doc(id);
  const before = await getUserAccess(id, { store: d.store });
  const now = new Date();
  const snap = await ref.get();
  // lastKnown* are metadata only; authority stays with the directory.
  const known = trustedUser && typeof trustedUser === "object" ? trustedUser : {};
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        uid: id,
        accessMode: mode,
        lastKnownSchoolId: String(known.schoolId || before.lastKnownSchoolId || "").slice(0, 128) || null,
        lastKnownRole: String(known.role || before.lastKnownRole || "").slice(0, 32) || null,
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
      action:
        mode === "enabled"
          ? "user_access.enabled"
          : mode === "disabled"
            ? "user_access.disabled"
            : "user_access.inherit",
      target: { uid: id },
      result: "success",
      before: { accessMode: before.accessMode },
      after: { accessMode: mode },
    },
    d.store
  );
  return { uid: id, accessMode: mode };
}

// ---------- Authoritative evaluator ----------
// Single policy core for resolveSubiAccess(), individual GET, and batched
// search enrichment. Inputs are already-fetched policy snapshots (or null
// when missing). Returns { allowed, basis } where basis is admin-only.
function evaluateEffective({ globalPolicy, userPolicy, schoolPolicy, role, accountType }) {
  const cleanRole = String(role || "").trim().toLowerCase();
  if (!MANAGED_ROLES.has(cleanRole)) {
    return { allowed: false, reason: "INVALID_ROLE", basis: "policy_invalid" };
  }
  if (!globalPolicy || !isEnabledFlag(globalPolicy.enabled)) {
    return { allowed: false, reason: "GLOBAL_DISABLED", basis: "global_disabled" };
  }
  if (accountType !== 'school' && accountType !== 'individual') {
    return { allowed: false, reason: 'ACCOUNT_TYPE_UNSUPPORTED', basis: 'policy_invalid' };
  }
  const individual = interpretIndividualMode(userPolicy);
  if (individual === "deny") {
    const malformed = userPolicy && normalizeAccessMode(userPolicy.accessMode) === null;
    return {
      allowed: false,
      reason: "USER_DISABLED",
      basis: malformed ? "policy_invalid" : "individual_disabled",
    };
  }
  if (individual === "allow") {
    return { allowed: true, basis: "individual_enabled" };
  }
  if (accountType === 'individual') return { allowed: true, basis: 'individual_inherited' };
  const roles = (schoolPolicy && schoolPolicy.roles) || {};
  const roleCfg = roles[cleanRole] || {};
  if (!isEnabledFlag(roleCfg.enabled)) {
    return { allowed: false, reason: "SCHOOL_ROLE_DISABLED", basis: "school_default_disabled" };
  }
  return { allowed: true, basis: "school_default_enabled" };
}

// Single interpretation of an individual user policy. Missing → "continue"
// (inherit); explicit inherit → "continue"; enabled/disabled map directly;
// malformed → "deny" (fail closed, never inherit). Shared by
// evaluateEffective() and checkIndividualOverride() so the mapping cannot
// diverge.
function interpretIndividualMode(userPolicy) {
  if (!userPolicy) return "continue";
  const mode = normalizeAccessMode(userPolicy.accessMode);
  if (mode === "enabled") return "allow";
  if (mode === "disabled") return "deny";
  if (mode === "inherit") return "continue";
  return "deny";
}

// Phase-3B individual override: userPolicies/{uid} lookup between the
// Global gate and the School gate. Kept as a named step (not inlined) so
// the seam remains explicit for review.
async function checkIndividualOverride({ uid, schoolId, role }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const snap = await d.store.collection(USER_COLLECTION).doc(cleanId(uid)).get();
  const step = interpretIndividualMode(snap.exists ? snap.data() : null);
  if (step === "deny") return { decision: "deny", reason: "USER_DISABLED" };
  if (step === "allow") return { decision: "allow" };
  return { decision: "continue" };
}

// Batched evaluation for admin search pages: global fetched once, school
// policies and user policies fetched with bounded getAll-style reads, then
// evaluated in memory via evaluateEffective(). No per-row resolver calls.
async function evaluateBatch(rows, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const globalSnap = await d.store.collection(GLOBAL_DOC[0]).doc(GLOBAL_DOC[1]).get();
  const globalPolicy = globalSnap.exists ? globalSnap.data() : null;
  const schoolIds = [...new Set(rows.filter(r => r.accountType === 'school').map((r) => r.schoolId).filter(Boolean))];
  const schoolSnaps = await Promise.all(
    schoolIds.map((id) => d.store.collection(SCHOOL_COLLECTION).doc(id).get())
  );
  const schoolById = {};
  schoolSnaps.forEach((snap, i) => {
    schoolById[schoolIds[i]] = snap.exists ? snap.data() : null;
  });
  const userRefs = rows.map((r) => d.store.collection(USER_COLLECTION).doc(r.uid));
  const userSnaps = await Promise.all(userRefs.map((ref) => ref.get()));
  return rows.map((row, i) => {
    const userSnap = userSnaps[i];
    const result = evaluateEffective({
      globalPolicy,
      userPolicy: userSnap.exists ? userSnap.data() : null,
      schoolPolicy: schoolById[row.schoolId] || null,
      role: row.role,
      accountType: row.accountType,
    });
    const rawMode =
      userSnap.exists && userSnap.data()
        ? normalizeAccessMode(userSnap.data().accessMode)
        : "inherit";
    return {
      ...row,
      individualAccessMode: rawMode === null ? "inherit" : rawMode,
      schoolDefaultEnabled: (() => {
        const roles = ((schoolById[row.schoolId] || {}).roles) || {};
        return isEnabledFlag((roles[String(row.role || "").toLowerCase()] || {}).enabled);
      })(),
      effectiveAllowed: result.allowed,
      effectiveBasis: result.basis,
    };
  });
}

async function resolveSubiAccess({ uid, schoolId, role, accountType }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cleanUid = cleanId(uid);
  const cleanSchool = cleanId(schoolId);
  const cleanRole = String(role || "").trim().toLowerCase();
  if (accountType !== 'school' && accountType !== 'individual') {
    return { allowed: false, reason: 'ACCOUNT_TYPE_UNSUPPORTED' };
  }
  if (!cleanUid || (accountType === 'school' && !cleanSchool) || !MANAGED_ROLES.has(cleanRole)) {
    return { allowed: false, reason: "INVALID_ROLE" };
  }
  let globalSnap;
  let userSnap;
  let schoolSnap;
  try {
    [globalSnap, userSnap, schoolSnap] = await Promise.all([
      d.store.collection(GLOBAL_DOC[0]).doc(GLOBAL_DOC[1]).get(),
      d.store.collection(USER_COLLECTION).doc(cleanUid).get(),
      accountType === 'school' ? d.store.collection(SCHOOL_COLLECTION).doc(cleanSchool).get() : Promise.resolve(null),
    ]);
  } catch (_) {
    const err = new Error("policy store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }
  const result = evaluateEffective({
    globalPolicy: globalSnap.exists ? globalSnap.data() : null,
    userPolicy: userSnap.exists ? userSnap.data() : null,
    schoolPolicy: schoolSnap && schoolSnap.exists ? schoolSnap.data() : null,
    role: cleanRole,
    accountType,
  });
  // `basis` is admin-safe admission-path info (school_default_enabled |
  // individual_enabled | ...) used by per-model usage scoping. Existing
  // callers that only read `allowed` are unaffected.
  if (result.allowed) return { allowed: true, basis: result.basis };
  return { allowed: false, reason: result.reason, basis: result.basis };
}

module.exports = {
  getGlobalAccess,
  setGlobalAccess,
  getSchoolAccess,
  setSchoolAccess,
  getUserAccess,
  setUserAccess,
  checkIndividualOverride,
  interpretIndividualMode,
  evaluateEffective,
  evaluateBatch,
  resolveSubiAccess,
  getManagedPermissionPolicy,
  normalizePermissionProfileCeiling,
};
