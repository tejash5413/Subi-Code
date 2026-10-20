// functions-subi/src/services/monthlyLimitService.js
// SUBI per-user monthly token-limit configuration (Phase 5).
//
// BOUNDARY: uses ONLY subiDb (via injected store defaulting to it).
// Never learnsmartDb, never secretService / aiConnectionService /
// modelCatalogService / OpenRouter / managed key. Limits are Firestore
// policy only.
//
// SEMANTICS (per-user, never aggregate):
// - schoolLimits/{schoolId}.monthlyTokens.student = allowance PER STUDENT.
// - schoolLimits/{schoolId}.monthlyTokens.teacher = allowance PER TEACHER.
// - userLimits/{uid} monthlyTokenMode inherit|custom; custom replaces the
//   school default for that UID (may be higher OR lower).
// - Missing user doc = inherit. Missing school doc/value = NOT CONFIGURED
//   (fail closed, never unlimited). 0 = zero allowance, never unlimited.
//
// DI: every method accepts optional `deps` ({ store, audits }) for fakes.

const { subiDb } = require("../db");
const auditService = require("./auditService");

const SCHEMA_VERSION = 1;
const SCHOOL_COLLECTION = "schoolLimits";
const USER_COLLECTION = "userLimits";

// Technical hard maximum (validation safety, NOT a default quota).
// Asia/Kolkata calendar month is the canonical period (YYYY-MM) for future
// usage accounting; config docs themselves persist and do not reset.
const HARD_MAX_MONTHLY_TOKENS = 100_000_000;
const MONTH_PERIOD = "calendar_month";

const MANAGED_ROLES = new Set(["student", "teacher"]);
const LIMIT_MODES = new Set(["inherit", "custom"]);

function defaultDeps() {
  return { store: subiDb, audits: auditService };
}

function cleanId(value, max = 128) {
  return String(value || "").trim().slice(0, max);
}

function invalidRequest(message) {
  const err = new Error(message || "invalid monthly limit payload");
  err.code = "INVALID_REQUEST";
  return err;
}

// Authoritative numeric validation: safe integer, 0..HARD_MAX.
function validateMonthlyTokens(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidRequest("monthly tokens must be a safe integer");
  }
  if (value < 0 || value > HARD_MAX_MONTHLY_TOKENS) {
    throw invalidRequest("monthly tokens out of range");
  }
  return value;
}

function normalizeMode(value) {
  const v = String(value || "").trim().toLowerCase();
  return LIMIT_MODES.has(v) ? v : null;
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function canUseIndividualPolicy(accountType) {
  // Undefined preserves compatibility for trusted internal/admin callers.
  // Runtime routes always pass the directory-authoritative accountType.
  return accountType === undefined || String(accountType || "").trim().toLowerCase() === "individual";
}

// ---------- Authoritative pure evaluator ----------
// Inputs are already-fetched policy snapshots (or null when missing).
// Single quota core for admin GET, batch enrichment, managed endpoint.
// Do NOT duplicate this logic in routes or frontend.
function evaluateMonthlyLimit({ userLimit, schoolLimit, role, accountType }) {
  const cleanRole = normalizeRole(role);
  if (!MANAGED_ROLES.has(cleanRole)) {
    return { configured: false, monthlyTokenLimit: null, source: "invalid_policy" };
  }
  const effectiveUserLimit = canUseIndividualPolicy(accountType) ? userLimit : null;
  const mode = !effectiveUserLimit ? "inherit" : normalizeMode(effectiveUserLimit.monthlyTokenMode);
  if (!effectiveUserLimit || mode === "inherit") {
    const branch = schoolLimit && schoolLimit.monthlyTokens
      ? schoolLimit.monthlyTokens[cleanRole]
      : undefined;
    if (typeof branch !== "number" || !Number.isSafeInteger(branch) || branch < 0 || branch > HARD_MAX_MONTHLY_TOKENS) {
      return { configured: false, monthlyTokenLimit: null, source: "not_configured" };
    }
    return {
      configured: true,
      monthlyTokenLimit: branch,
      source: cleanRole === "student" ? "school_student" : "school_teacher",
    };
  }
  if (mode === "custom") {
    const v = effectiveUserLimit ? effectiveUserLimit.monthlyTokens : undefined;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > HARD_MAX_MONTHLY_TOKENS) {
      return { configured: false, monthlyTokenLimit: null, source: "invalid_policy" };
    }
    return { configured: true, monthlyTokenLimit: v, source: "individual_custom" };
  }
  // Malformed mode fails closed.
  return { configured: false, monthlyTokenLimit: null, source: "invalid_policy" };
}

// Coarse, user-safe origin used by managed UI responses. The internal
// evaluator keeps role-specific values for administration and auditing;
// normal users only need to know why their effective number differs from a
// school default they may have been shown.
function toSafePolicySource(source) {
  if (source === "individual_custom") return "individual";
  if (source === "school_student" || source === "school_teacher") return "school";
  return "none";
}

// ---------- School limits ----------

function toSafeSchoolLimits(schoolId, data) {
  const tokens = (data && data.monthlyTokens) || {};
  const hasStudent = typeof tokens.student === "number";
  const hasTeacher = typeof tokens.teacher === "number";
  return {
    schoolId,
    configured: hasStudent && hasTeacher,
    studentMonthlyTokens: hasStudent ? tokens.student : null,
    teacherMonthlyTokens: hasTeacher ? tokens.teacher : null,
    updatedAt: (data && data.updatedAt) || null,
  };
}

async function getSchoolLimits(schoolId, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  if (!id) throw invalidRequest("missing schoolId");
  const snap = await store.collection(SCHOOL_COLLECTION).doc(id).get();
  return toSafeSchoolLimits(id, snap.exists ? snap.data() : null);
}

async function setSchoolLimits({ schoolId, studentMonthlyTokens, teacherMonthlyTokens, adminUid }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  const student = validateMonthlyTokens(studentMonthlyTokens);
  const teacher = validateMonthlyTokens(teacherMonthlyTokens);
  if (!id) throw invalidRequest("missing schoolId");
  const ref = d.store.collection(SCHOOL_COLLECTION).doc(id);
  const before = await getSchoolLimits(id, { store: d.store });
  const now = new Date();
  const snap = await ref.get();
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        schoolId: id,
        monthlyTokens: { student, teacher },
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
      action: "school_monthly_limit.updated",
      target: { schoolId: id },
      result: "success",
      before: {
        studentMonthlyTokens: before.studentMonthlyTokens,
        teacherMonthlyTokens: before.teacherMonthlyTokens,
      },
      after: { studentMonthlyTokens: student, teacherMonthlyTokens: teacher },
    },
    d.store
  );
  return toSafeSchoolLimits(id, {
    monthlyTokens: { student, teacher },
    updatedAt: now,
  });
}

// ---------- Individual limits ----------

async function getUserLimit(uid, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const snap = await store.collection(USER_COLLECTION).doc(id).get();
  if (!snap.exists) {
    return { uid: id, monthlyTokenMode: "inherit", monthlyTokens: null, lastKnownSchoolId: null, lastKnownRole: null, updatedAt: null };
  }
  const data = snap.data() || {};
  return {
    uid: id,
    monthlyTokenMode: normalizeMode(data.monthlyTokenMode) || "inherit",
    monthlyTokens: typeof data.monthlyTokens === "number" ? data.monthlyTokens : null,
    lastKnownSchoolId: data.lastKnownSchoolId || null,
    lastKnownRole: data.lastKnownRole || null,
    updatedAt: data.updatedAt || null,
  };
}

async function setUserLimit({ uid, monthlyTokenMode, monthlyTokens, adminUid, trustedUser }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const mode = normalizeMode(monthlyTokenMode);
  if (!id || !mode) throw invalidRequest("invalid monthly limit mode");
  let value = null;
  if (mode === "custom") {
    value = validateMonthlyTokens(monthlyTokens);
  }
  const ref = d.store.collection(USER_COLLECTION).doc(id);
  const before = await getUserLimit(id, { store: d.store });
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
        monthlyTokenMode: mode,
        monthlyTokens: mode === "custom" ? value : null,
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
      action: mode === "custom" ? "user_monthly_limit.custom" : "user_monthly_limit.inherit",
      target: { uid: id },
      result: "success",
      before: { monthlyTokenMode: before.monthlyTokenMode, monthlyTokens: before.monthlyTokens },
      after: { monthlyTokenMode: mode, monthlyTokens: mode === "custom" ? value : null },
    },
    d.store
  );
  return { uid: id, monthlyTokenMode: mode, monthlyTokens: mode === "custom" ? value : null };
}

// ---------- Effective resolution ----------

async function resolveEffectiveMonthlyLimit({ uid, schoolId, role, accountType }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cleanUid = cleanId(uid);
  const cleanSchool = cleanId(schoolId);
  const cleanRole = normalizeRole(role);
  if (!cleanUid || !cleanSchool || !MANAGED_ROLES.has(cleanRole)) {
    return { configured: false, monthlyTokenLimit: null, source: "invalid_policy" };
  }
  let userSnap;
  let schoolSnap;
  try {
    [userSnap, schoolSnap] = await Promise.all([
      d.store.collection(USER_COLLECTION).doc(cleanUid).get(),
      d.store.collection(SCHOOL_COLLECTION).doc(cleanSchool).get(),
    ]);
  } catch (_) {
    const err = new Error("limit store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }
  return evaluateMonthlyLimit({
    userLimit: userSnap.exists ? userSnap.data() : null,
    schoolLimit: schoolSnap.exists ? schoolSnap.data() : null,
    role: cleanRole,
    accountType,
  });
}

// ---------- Transaction-aware resolution (Phase 9A quota) ----------
// Reads BOTH policy docs through the caller's transaction so a concurrent
// admin limit edit cannot slip between limit resolution and reservation:
// Firestore retries the whole transaction on contention. Semantics are
// EXACTLY evaluateMonthlyLimit (custom/inherit/zero/missing identical).
// Never throws for missing docs (fail closed via evaluator); store errors
// bubble as INTERNAL-equivalent and abort the transaction.
async function resolveEffectiveMonthlyLimitInTransaction(tx, { uid, schoolId, role, accountType }, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const cleanUid = cleanId(uid);
  const cleanSchool = cleanId(schoolId);
  const cleanRole = normalizeRole(role);
  if (!cleanUid || !cleanSchool || !MANAGED_ROLES.has(cleanRole)) {
    return { configured: false, monthlyTokenLimit: null, source: "invalid_policy" };
  }
  const [userSnap, schoolSnap] = await Promise.all([
    tx.get(store.collection(USER_COLLECTION).doc(cleanUid)),
    tx.get(store.collection(SCHOOL_COLLECTION).doc(cleanSchool)),
  ]);
  return evaluateMonthlyLimit({
    userLimit: userSnap.exists ? userSnap.data() : null,
    schoolLimit: schoolSnap.exists ? schoolSnap.data() : null,
    role: cleanRole,
    accountType,
  });
}

// Batched evaluation for admin search pages: school docs fetched once per
// unique school, user docs bounded, evaluated in memory via
// evaluateMonthlyLimit(). No per-row resolver calls.
async function resolveEffectiveMonthlyLimitsBatch(rows, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const schoolIds = [...new Set(rows.map((r) => r.schoolId).filter(Boolean))];
  const schoolSnaps = await Promise.all(
    schoolIds.map((id) => d.store.collection(SCHOOL_COLLECTION).doc(id).get())
  );
  const schoolById = {};
  schoolSnaps.forEach((snap, i) => {
    schoolById[schoolIds[i]] = snap.exists ? snap.data() : null;
  });
  const userSnaps = await Promise.all(
    rows.map((r) => d.store.collection(USER_COLLECTION).doc(cleanId(r.uid)).get())
  );
  return rows.map((row, i) => {
    const userSnap = userSnaps[i];
    const result = evaluateMonthlyLimit({
      userLimit: userSnap.exists ? userSnap.data() : null,
      schoolLimit: schoolById[row.schoolId] || null,
      role: row.role,
      accountType: row.accountType,
    });
    return { ...row, ...result };
  });
}

module.exports = {
  HARD_MAX_MONTHLY_TOKENS,
  MONTH_PERIOD,
  evaluateMonthlyLimit,
  toSafePolicySource,
  validateMonthlyTokens,
  getSchoolLimits,
  setSchoolLimits,
  getUserLimit,
  setUserLimit,
  resolveEffectiveMonthlyLimit,
  resolveEffectiveMonthlyLimitInTransaction,
  resolveEffectiveMonthlyLimitsBatch,
};
