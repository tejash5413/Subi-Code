// functions-subi/src/services/modelPolicyService.js
// SUBI model-assignment policies (Model Redesign):
//   ACCESS  = WHO can use SUBI (accessService, untouched).
//   MODELS  = WHICH approved models an allowed user receives (this file).
//   LIMITS  = HOW MANY tokens per month (monthlyLimitService, untouched).
//
// BOUNDARY: uses ONLY subiDb (via injected store defaulting to it).
// Never learnsmartDb, never secretService / aiConnectionService /
// modelCatalogService / OpenRouter / managed key / fetch. Assignment is
// Firestore policy only. Approved-model metadata is read through
// approvedModelService.getApprovedModel (safe projection applied here),
// never by raw upstream identifiers from clients.
//
// New collections (named `subi` database):
//   schoolModelPolicies/{schoolId}  -> { roles: { student: {modelKeys},
//                                               teacher: {modelKeys} } }
//   userModelPolicies/{uid}         -> { modelMode: inherit|custom,
//                                        modelKeys: [...] (custom only) }
//
// DI: every method accepts optional `deps` ({ store, audits }) for fakes.

const { subiDb } = require("../db");
const auditService = require("./auditService");
const approvedModels = require("./approvedModelService");
const autoEligible = require("./autoEligibleModelService");

const SCHEMA_VERSION = 1;
const SCHOOL_COLLECTION = "schoolModelPolicies";
const USER_COLLECTION = "userModelPolicies";

const MANAGED_ROLES = new Set(["student", "teacher"]);
const MODEL_MODES = new Set(["inherit", "custom"]);

// Hard maximum modelKeys per role branch / custom list. Bounded writes,
// bounded resolution reads, stays far under the 256kb body cap.
const MAX_MODEL_KEYS = 100;

// Server-generated approved key format (mirrors approvedModelService).
const MODEL_KEY_RE = /^mdl_[A-Za-z0-9-]+$/;
const MAX_KEY_LEN = 128;

function defaultDeps() {
  return { store: subiDb, audits: auditService };
}

function cleanId(value, max = 128) {
  return String(value || "").trim().slice(0, max);
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMode(value) {
  const v = String(value || "").trim().toLowerCase();
  return MODEL_MODES.has(v) ? v : null;
}

function canUseIndividualPolicy(accountType) {
  // Undefined preserves compatibility for trusted internal/admin callers.
  // Runtime routes always pass the directory-authoritative accountType.
  return accountType === undefined || String(accountType || "").trim().toLowerCase() === "individual";
}

function invalidRequest(message) {
  const err = new Error(message || "invalid model policy payload");
  err.code = "INVALID_REQUEST";
  throw err;
}

function policyConflict(message) {
  const err = new Error(message || "policy changed since load");
  err.code = "POLICY_CONFLICT";
  throw err;
}

// Optimistic-concurrency guard against stale-tab overwrites: callers may
// pass the updatedAt they loaded; a mismatch fails the whole save before
// any write so a stale hidden tab can never clobber a newer branch.
// Missing docs never conflict (first save always allowed).
//
// Timestamp shapes accepted (Firestore serializes differently across SDK
// versions and the JSON wire — ALL must compare equal):
//   Date | millis number | ISO string | { toMillis() } (server Timestamp)
//   { seconds, nanoseconds } | { _seconds, _nanoseconds } (JSON wire,
//   each part number or numeric string per proto JSON int64 encoding).
function toMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value) {
    if (/^-?\d+$/.test(value.trim())) return Math.floor(Number(value.trim()));
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value.toMillis === "function") {
    try {
      const n = value.toMillis();
      return Number.isFinite(n) ? Math.floor(n) : null;
    } catch (_) {
      return null;
    }
  }
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object") {
    const secRaw =
      value.seconds !== undefined ? value.seconds :
      value._seconds !== undefined ? value._seconds : undefined;
    const nanoRaw =
      value.nanoseconds !== undefined ? value.nanoseconds :
      value._nanoseconds !== undefined ? value._nanoseconds : 0;
    if (secRaw !== undefined) {
      const sec = typeof secRaw === "string" ? Number(secRaw.trim()) : secRaw;
      const nano = typeof nanoRaw === "string" ? Number(nanoRaw.trim()) : nanoRaw;
      if (Number.isFinite(sec) && Number.isFinite(nano) && nano >= 0) {
        return Math.floor(sec * 1000 + nano / 1000000);
      }
      return null;
    }
  }
  return null;
}

function assertExpectedUpdatedAt(snap, expectedUpdatedAt) {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) return;
  if (!snap.exists) return;
  const current = toMillis((snap.data() || {}).updatedAt);
  const expected = toMillis(expectedUpdatedAt);
  if (expected === null) invalidRequest("invalid expectedUpdatedAt");
  if (current !== expected) policyConflict("policy changed since load");
}

// ---------- modelKey normalization ----------
// Deduplicate server-side preserving first-seen order. Invalid entries make
// the whole payload invalid (strict reject — never silently store a key the
// admin did not intend).
function tooLarge(message) {
  const err = new Error(message || "too many modelKeys");
  err.code = "REQUEST_TOO_LARGE";
  throw err;
}

function unknownModelKey(message) {
  const err = new Error(message || "unknown modelKey");
  err.code = "UNKNOWN_MODEL_KEY";
  throw err;
}

function normalizeModelKeys(list) {
  if (!Array.isArray(list)) invalidRequest("modelKeys must be an array");
  if (list.length > MAX_MODEL_KEYS) tooLarge("too many modelKeys");
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== "string") invalidRequest("modelKey must be a string");
    const key = raw.trim().slice(0, MAX_KEY_LEN);
    if (!key || !MODEL_KEY_RE.test(key)) invalidRequest("invalid modelKey");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ---------- Authoritative pure evaluator ----------
// Inputs are already-fetched policy snapshots (or null when missing).
// Single assignment core for admin GET previews and the managed endpoint.
// Do NOT duplicate this logic in routes or frontend.
//
// Returns { mode, modelKeys } where mode is one of:
//   individual_custom | school_student | school_teacher | none
// Malformed user policy fails closed ({mode:none, modelKeys:[]}).
// Missing school/branch fails closed for that role ([]).
function evaluateModelPolicy({ userPolicy, schoolPolicy, role, accountType }) {
  const cleanRole = normalizeRole(role);
  if (!MANAGED_ROLES.has(cleanRole)) {
    return { mode: "none", modelKeys: [] };
  }
  const effectiveUserPolicy = canUseIndividualPolicy(accountType) ? userPolicy : null;
  const mode = !effectiveUserPolicy ? "inherit" : normalizeMode(effectiveUserPolicy.modelMode);
  if (!effectiveUserPolicy || mode === "inherit") {
    const branch =
      schoolPolicy && schoolPolicy.roles ? schoolPolicy.roles[cleanRole] : undefined;
    const keys = branch && Array.isArray(branch.modelKeys) ? branch.modelKeys : null;
    if (!keys) {
      return { mode: cleanRole === "student" ? "school_student" : "school_teacher", modelKeys: [] };
    }
    return {
      mode: cleanRole === "student" ? "school_student" : "school_teacher",
      modelKeys: keys.filter((k) => typeof k === "string"),
    };
  }
  if (mode === "custom") {
    const keys = effectiveUserPolicy ? effectiveUserPolicy.modelKeys : undefined;
    if (!Array.isArray(keys)) return { mode: "none", modelKeys: [] };
    return { mode: "individual_custom", modelKeys: keys.filter((k) => typeof k === "string") };
  }
  // Malformed mode fails closed.
  return { mode: "none", modelKeys: [] };
}

// Public managed endpoints may tell the signed-in user whether their
// effective list comes from the school default or an individual override.
// Keep the projection deliberately coarse: never expose role branches,
// policy documents, model keys beyond the already-authorized list, or admin
// metadata.
function toSafePolicySource(mode) {
  if (mode === "individual_custom") return "individual";
  if (mode === "school_student" || mode === "school_teacher") return "school";
  return "none";
}

// ---------- School model policies ----------

function toSafeSchoolModelPolicy(schoolId, data) {
  const roles = (data && data.roles) || {};
  const branch = (name) => {
    const list = roles[name] && Array.isArray(roles[name].modelKeys) ? roles[name].modelKeys : [];
    return { modelKeys: list.filter((k) => typeof k === "string") };
  };
  return {
    schoolId,
    studentModelKeys: branch("student").modelKeys,
    teacherModelKeys: branch("teacher").modelKeys,
    updatedAt: (data && data.updatedAt) || null,
  };
}

async function getSchoolModelPolicy(schoolId, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  if (!id) invalidRequest("missing schoolId");
  const snap = await store.collection(SCHOOL_COLLECTION).doc(id).get();
  return toSafeSchoolModelPolicy(id, snap.exists ? snap.data() : null);
}

async function setSchoolModelPolicy({ schoolId, studentModelKeys, teacherModelKeys, studentCatalogue, teacherCatalogue, adminUid, expectedUpdatedAt }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  if (!id) invalidRequest("missing schoolId");
  const student = normalizeModelKeys(studentModelKeys);
  const teacher = normalizeModelKeys(teacherModelKeys);
  // Catalogue-assignment simplification: screens submit catalogue selections
  // alongside (or instead of) mdl_* keys. Registry records are ensured once
  // for both role lists, then the resulting keys join the explicit lists.
  // Unknown catalogue/upstream input fails the whole SAVE before any write.
  const ensured = await ensureSelectionKeys(
    [
      { list: studentCatalogue, into: student },
      { list: teacherCatalogue, into: teacher },
    ],
    { store: d.store, audits: d.audits, ids: d.ids, catalog: d.catalog, adminUid }
  );
  // Every key must reference a live approved model. Reject the whole write
  // on the first unknown key — never store dangling assignments.
  await assertKeysApproved([...student, ...teacher], { store: d.store });
  // Unified assignment certification: every selected record ends enabled +
  // Verified (new, unverified, or disabled-then-reselected). Only those
  // three fields move; everything else on the record is preserved.
  const certified = await approvedModels.applyAssignmentCertification([...student, ...teacher], {
    store: d.store,
    audits: d.audits,
    adminUid,
  });
  const ref = d.store.collection(SCHOOL_COLLECTION).doc(id);
  const before = await getSchoolModelPolicy(id, { store: d.store });
  const now = new Date();
  const snap = await ref.get();
  assertExpectedUpdatedAt(snap, expectedUpdatedAt);
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        schoolId: id,
        roles: { student: { modelKeys: student }, teacher: { modelKeys: teacher } },
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
      action: "school_models.updated",
      target: { schoolId: id },
      result: "success",
      before: { studentModelKeys: before.studentModelKeys, teacherModelKeys: before.teacherModelKeys },
      after: {
        studentModelKeys: student,
        teacherModelKeys: teacher,
        catalogueCreated: ensured.created,
        catalogueReused: ensured.reused,
        reenabledModelKeys: certified.reenabled,
        verifiedModelKeys: certified.verified,
      },
    },
    d.store
  );
  return {
    ...toSafeSchoolModelPolicy(id, {
      roles: { student: { modelKeys: student }, teacher: { modelKeys: teacher } },
      updatedAt: now,
    }),
    createdModelKeys: ensured.created,
    reusedModelKeys: ensured.reused,
    reenabledModelKeys: certified.reenabled,
    verifiedModelKeys: certified.verified,
  };
}

// ---------- Individual model policies ----------

async function getUserModelPolicy(uid, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) invalidRequest("missing uid");
  const snap = await store.collection(USER_COLLECTION).doc(id).get();
  if (!snap.exists) {
    return {
      uid: id,
      modelMode: "inherit",
      modelKeys: [],
      lastKnownSchoolId: null,
      lastKnownRole: null,
      updatedAt: null,
    };
  }
  const data = snap.data() || {};
  // Missing/empty mode reads as inherit (missing policy = inherit).
  // A malformed non-empty mode is preserved verbatim so evaluateModelPolicy
  // fails closed instead of silently inheriting.
  const rawMode = typeof data.modelMode === "string" ? data.modelMode.trim().toLowerCase() : "";
  return {
    uid: id,
    modelMode: rawMode || "inherit",
    modelKeys: Array.isArray(data.modelKeys) ? data.modelKeys.filter((k) => typeof k === "string") : [],
    lastKnownSchoolId: data.lastKnownSchoolId || null,
    lastKnownRole: data.lastKnownRole || null,
    updatedAt: data.updatedAt || null,
  };
}

async function setUserModelPolicy({ uid, modelMode, modelKeys, catalogueSelections, adminUid, trustedUser, expectedUpdatedAt }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const mode = normalizeMode(modelMode);
  if (!id || !mode) invalidRequest("invalid model policy mode");
  // Inherit stores an explicit inherit doc with empty keys; custom stores
  // exactly the normalized keys (possibly empty = no models).
  const keys = mode === "custom" ? normalizeModelKeys(modelKeys) : [];
  let catalogueCreated = [];
  let catalogueReused = [];
  let reenabledModelKeys = [];
  let verifiedModelKeys = [];
  if (mode === "custom") {
    const ensured = await ensureSelectionKeys(
      [{ list: catalogueSelections, into: keys }],
      { store: d.store, audits: d.audits, ids: d.ids, catalog: d.catalog, adminUid }
    );
    catalogueCreated = ensured.created;
    catalogueReused = ensured.reused;
    await assertKeysApproved(keys, { store: d.store });
    const certified = await approvedModels.applyAssignmentCertification(keys, {
      store: d.store,
      audits: d.audits,
      adminUid,
    });
    reenabledModelKeys = certified.reenabled;
    verifiedModelKeys = certified.verified;
  } else if (catalogueSelections !== undefined) {
    invalidRequest("catalogue selection requires custom mode");
  }
  const ref = d.store.collection(USER_COLLECTION).doc(id);
  const before = await getUserModelPolicy(id, { store: d.store });
  const now = new Date();
  const snap = await ref.get();
  assertExpectedUpdatedAt(snap, expectedUpdatedAt);
  // lastKnown* are metadata only; authority stays with the directory.
  const known = trustedUser && typeof trustedUser === "object" ? trustedUser : {};
  await d.store.runTransaction(async (tx) => {
    tx.set(
      ref,
      {
        schemaVersion: SCHEMA_VERSION,
        uid: id,
        modelMode: mode,
        modelKeys: keys,
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
      action: mode === "custom" ? "user_models.custom" : "user_models.inherit",
      target: { uid: id },
      result: "success",
      before: { modelMode: before.modelMode, modelKeys: before.modelKeys },
      after: {
        modelMode: mode,
        modelKeys: keys,
        catalogueCreated,
        catalogueReused,
        reenabledModelKeys,
        verifiedModelKeys,
      },
    },
    d.store
  );
  return {
    uid: id,
    modelMode: mode,
    modelKeys: keys,
    createdModelKeys: catalogueCreated,
    reusedModelKeys: catalogueReused,
    reenabledModelKeys,
    verifiedModelKeys,
  };
}

// ---------- Catalogue-assignment registry ----------
// Assignment screens submit catalogue selections ({upstreamModelId,
// optional certification marks}) alongside explicit mdl_* keys. This ensures
// registry records ONCE for the whole SAVE (both role lists / whole custom
// list share one call), appends the resulting keys to each target list, and
// returns { created, reused } for auditing. Undefined selection lists are
// ignored (old keys-only clients keep working); any other non-array value
// rejects.
async function ensureSelectionKeys(targets, opts) {
  const o = opts || {};
  const lists = [];
  for (const t of targets) {
    if (t.list === undefined) continue;
    if (!Array.isArray(t.list)) invalidRequest("invalid catalogue selection");
    lists.push(t);
  }
  if (lists.length === 0) return { created: [], reused: [] };
  const flat = [];
  for (const t of lists) for (const item of t.list) flat.push(item);
  const ensured = await approvedModels.ensureCatalogueModels(flat, {
    store: o.store,
    audits: o.audits,
    ids: o.ids,
    catalog: o.catalog,
    adminUid: o.adminUid,
  });
  // Attribute resulting keys back per target. ensureCatalogueModels dedupes
  // by upstream first-seen and returns keys in unique-input order, so rebuild
  // the same unique order here to align.
  const uniqueUpstream = [];
  {
    const seen = new Set();
    for (const item of flat) {
      const id = typeof item.upstreamModelId === "string" ? item.upstreamModelId.trim() : "";
      if (!seen.has(id)) {
        seen.add(id);
        uniqueUpstream.push(id);
      }
    }
  }
  const keyByUpstream = new Map(uniqueUpstream.map((id, i) => [id, ensured.keys[i]]));
  for (const t of lists) {
    for (const item of t.list) {
      const id = typeof item.upstreamModelId === "string" ? item.upstreamModelId.trim() : "";
      const key = keyByUpstream.get(id);
      if (key && !t.into.includes(key)) t.into.push(key);
    }
  }
  return { created: ensured.created, reused: ensured.reused };
}

// ---------- Approved-model validation + safe resolution ----------

// Throws UNKNOWN_MODEL_KEY on the first registry key with no live record.
// CLASS 1 rule: an existing mdl_* is validated against the registry ONLY —
// never revalidated against the OpenRouter catalogue (a registered model
// legitimately outlives its upstream listing). Never returns
// provider/upstream metadata — existence check only.
async function assertKeysApproved(keys, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  for (const key of keys) {
    try {
      await approvedModels.getApprovedModel(key, { store });
    } catch (_) {
      unknownModelKey("unknown modelKey");
    }
  }
}

// Resolve keys to the safe managed projection, preserving policy order.
// Unknown/invalid approved docs are dropped (stale), never fail the list.
// Docs with enabled !== true are reported as disabledModelKeys and excluded
// from models: Disable hides instantly from serving, while admin previews
// keep showing the raw assigned keys (re-enable restores them, no reassign).
async function resolveApprovedSafe(keys, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const unique = [...new Set(keys.filter((k) => typeof k === "string"))].slice(0, MAX_MODEL_KEYS);
  const out = [];
  const stale = [];
  const disabled = [];
  const results = await Promise.all(
    unique.map(async (key) => {
      try {
        const m = await approvedModels.getApprovedModel(key, { store });
        if (!m || !m.upstreamModelId) return { key, stale: true };
        if (m.enabled !== true) return { key, disabled: true };
        return {
          key,
          model: {
            modelKey: m.modelKey,
            displayName: m.displayName,
            capabilities: m.capabilities,
            contextLength: m.contextLength,
            ...(require('./freeCodingModel').isFreeCodingModel(m) ? { freeCoding: true } : {}),
          },
        };
      } catch (_) {
        return { key, stale: true };
      }
    })
  );
  for (const r of results) {
    if (r.model) out.push(r.model);
    else if (r.disabled) disabled.push(r.key);
    else stale.push(r.key);
  }
  return { models: out, staleModelKeys: stale, disabledModelKeys: disabled };
}

// ---------- Auto-eligible baseline (Free + Cheap Output <=$0.5/1M) ----------
// Free = In $0 AND Out $0. Cheap-auto = Out <= $0.5/1M inclusive (so $0.50
// qualifies, $0.60 does not). Missing/invalid pricing never qualifies.
// Disabled registry records never auto-serve (admin opt-out wins).
// Fail-open for the auto part only: a scan failure returns [] so the
// explicit policy list still serves; policy store failures above still
// fail closed.
async function listAutoEligibleRegistryKeys(store) {
  try {
    const snap = await store.collection("approvedModels").limit(200).get();
    const docs = (snap.docs || []).map((doc) => {
      const data = (doc.data && doc.data()) || {};
      return {
        modelKey: doc.id,
        enabled: data.enabled,
        pricing: data.pricing,
      };
    });
    return autoEligible.autoKeysFromApprovedDocs(docs);
  } catch (_) {
    return [];
  }
}

// ---------- Managed resolution ----------
// Final authority for GET /managed/models AFTER access passes. Legacy
// school assignments decide WHICH models, intersected with enabled approved
// records. Individual credit accounts use the separate compatible registry
// path without a per-user assignment gate. Invalid role/school and
// store failures fail closed (empty list / UNAVAILABLE, never all models).
async function resolveManagedModels({ uid, schoolId, role, accountType }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const cleanUid = cleanId(uid);
  const cleanSchool = cleanId(schoolId);
  const cleanRole = normalizeRole(role);
  if (!cleanUid || !cleanSchool || !MANAGED_ROLES.has(cleanRole)) {
    return { mode: "none", models: [] };
  }
  let userSnap;
  let schoolSnap;
  try {
    [userSnap, schoolSnap] = await Promise.all([
      d.store.collection(USER_COLLECTION).doc(cleanUid).get(),
      d.store.collection(SCHOOL_COLLECTION).doc(cleanSchool).get(),
    ]);
  } catch (_) {
    const err = new Error("model policy store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }
  const evaluated = evaluateModelPolicy({
    userPolicy: userSnap.exists ? userSnap.data() : null,
    schoolPolicy: schoolSnap.exists ? schoolSnap.data() : null,
    role: cleanRole,
    accountType,
  });
  // Auto baseline: union explicit policy keys with Enabled + auto-eligible
  // registry keys (Free or Out <=$0.5/1M). Policy keys first so the 100-key
  // cap never drops an explicit admin choice in favour of an auto model.
  // Explicit school accounts are governed by the school's model keys. A
  // global registration is not an assignment to a school. Legacy/internal
  // compatibility callers keep their old baseline; individuals use the
  // separate approved compatible registry path in managed routes.
  const autoKeys = accountType === 'school' ? [] : await listAutoEligibleRegistryKeys(d.store);
  const seen = new Set();
  const unionKeys = [];
  for (const k of [...evaluated.modelKeys, ...autoKeys]) {
    if (typeof k !== "string" || !k || seen.has(k)) continue;
    seen.add(k);
    unionKeys.push(k);
    if (unionKeys.length >= MAX_MODEL_KEYS) break;
  }
  const resolved = await resolveApprovedSafe(unionKeys, { store: d.store });
  // Additive diagnostics for the managed-models aggregate log (counts only,
  // never keys): assigned = policy keys evaluated, returned = eligible.
  return {
    mode: evaluated.mode,
    models: resolved.models,
    assignedCount: evaluated.modelKeys.length,
    autoIncludedCount: unionKeys.length - evaluated.modelKeys.length,
    staleModelKeys: resolved.staleModelKeys,
    disabledModelKeys: resolved.disabledModelKeys,
  };
}

module.exports = {
  MAX_MODEL_KEYS,
  evaluateModelPolicy,
  toSafePolicySource,
  normalizeModelKeys,
  getSchoolModelPolicy,
  setSchoolModelPolicy,
  getUserModelPolicy,
  setUserModelPolicy,
  resolveApprovedSafe,
  resolveManagedModels,
};
