// functions-subi/src/services/modelPolicyReadinessService.js
// Automated MODEL_POLICY_CUTOVER readiness check (read-only).
//
// Answers ONE question for Superadmin: is production assignment data ready
// for the new resolver (schoolModelPolicies + userModelPolicies inherit/
// custom), or must remediation happen first? It additionally reports
// terminal/verify mark coverage per approved model (informational only:
// unmarked models serve but render FILE TOOLS ONLY in SUBI).
//
// THIS SERVICE NEVER WRITES. No audits (read-only check), no secrets, no
// OpenRouter, no usage writes, no access/limit/chat changes. It only reads:
//   subiDb: schoolPolicies, schoolModelPolicies, userPolicies,
//           userModelPolicies, approvedModels (all bounded scans)
//   directory (READ ONLY): school display names for relevant schools.
//
// BOUNDARY: may import subiDb (via injected store), learnsmartDirectoryService
// (reads only), modelPolicyService (pure evaluator), effectiveModelService
// (cutover flag only). Never learnsmartDb directly, never secretService /
// aiConnectionService / OpenRouter / fetch.
//
// Hard bounds: schools ≤500 per collection, users ≤2000 per collection,
// approved ≤200 (existing architecture cap). Any truncation forces NO-GO
// with an explicit reason instead of certifying incomplete data.
//
// DI: runReadiness(deps) accepts { store, directory } for fakes.

const { subiDb } = require("../db");
const directory = require("./learnsmartDirectoryService");
const modelPolicies = require("./modelPolicyService");
const effectiveModels = require("./effectiveModelService");

const ACCESS_SCHOOL_COLLECTION = "schoolPolicies";
const ACCESS_USER_COLLECTION = "userPolicies";
const MODEL_SCHOOL_COLLECTION = "schoolModelPolicies";
const MODEL_USER_COLLECTION = "userModelPolicies";
const APPROVED_COLLECTION = "approvedModels";

const SCHOOL_SCAN_MAX = 500;
const USER_SCAN_MAX = 2000;
const APPROVED_SCAN_MAX = 200;

const MODEL_KEY_RE = /^mdl_[A-Za-z0-9-]+$/;
const MAX_KEY_LEN = 128;
const MAX_MODEL_KEYS = 100;

function defaultDeps() {
  return { store: subiDb, directory };
}

function isValidKeySyntax(key) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_KEY_LEN &&
    MODEL_KEY_RE.test(key.trim()) &&
    key.trim() === key
  );
}

async function scanCollection(store, name, max) {
  const snap = await store.collection(name).limit(max).get();
  const docs = (snap.docs || []).map((doc) => ({ id: doc.id, data: doc.data() || {} }));
  return { docs, truncated: docs.length >= max };
}

async function runReadiness(deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const reasons = [];
  const cutoverEnabled = effectiveModels.MODEL_POLICY_CUTOVER === true;

  // Structural self-check: required authorities present.
  if (
    typeof modelPolicies.evaluateModelPolicy !== "function" ||
    typeof modelPolicies.resolveManagedModels !== "function"
  ) {
    return fail("model-policy resolver unavailable");
  }

  let accessSchools;
  let modelSchools;
  let accessUsers;
  let modelUsers;
  let approved;
  try {
    [accessSchools, modelSchools, accessUsers, modelUsers, approved] = await Promise.all([
      scanCollection(d.store, ACCESS_SCHOOL_COLLECTION, SCHOOL_SCAN_MAX),
      scanCollection(d.store, MODEL_SCHOOL_COLLECTION, SCHOOL_SCAN_MAX),
      scanCollection(d.store, ACCESS_USER_COLLECTION, USER_SCAN_MAX),
      scanCollection(d.store, MODEL_USER_COLLECTION, USER_SCAN_MAX),
      scanCollection(d.store, APPROVED_COLLECTION, APPROVED_SCAN_MAX),
    ]);
  } catch (_) {
    const err = new Error("policy store unavailable");
    err.code = "UNAVAILABLE";
    throw err;
  }

  if (accessSchools.truncated || modelSchools.truncated) {
    return fail("school policy scan truncated; narrow scope before certifying");
  }
  const usersTruncated = accessUsers.truncated || modelUsers.truncated;

  // Approved master set (display names for safe reporting only) plus
  // terminal/verify mark coverage. Models without marks serve correctly but
  // every SUBI picker badge for them renders FILE TOOLS ONLY, so coverage is
  // surfaced (summary + capabilityMarks + preview flags) for remediation.
  const approvedByKey = new Map();
  const approvedMarks = new Map();
  const markOf = (data) => {
    const caps = (data && data.capabilities) || {};
    return {
      hasTerminalMark: caps.agentTerminal === "verified" || caps.agentTerminal === "unsupported",
      hasVerifyMark:
        caps.agentVerify === "verified" ||
        caps.agentVerify === "unsupported" ||
        caps.agentVerify === "unknown",
    };
  };
  for (const doc of approved.docs) {
    approvedByKey.set(doc.id, (doc.data.displayName || doc.id).slice(0, 80));
    approvedMarks.set(doc.id, markOf(doc.data));
  }
  const approvedTruncated = approved.truncated;
  if (approvedTruncated) {
    reasons.push("approved catalogue scan hit the 200-document bound; unknown keys verified individually");
  }

  // Resolve-with-fallback: keys absent from a truncated approved set are
  // checked by direct read so truncation never fabricates a stale finding.
  async function isApproved(key) {
    if (approvedByKey.has(key)) return true;
    if (!approvedTruncated) return false;
    try {
      const snap = await d.store.collection(APPROVED_COLLECTION).doc(key).get();
      if (snap.exists) {
        const data = snap.data() || {};
        approvedByKey.set(key, (data.displayName || key).slice(0, 80));
        approvedMarks.set(key, markOf(data));
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  async function partitionKeys(keys) {
    const valid = [];
    const stale = [];
    for (const key of keys) {
      if (await isApproved(key)) valid.push(key);
      else stale.push(key);
    }
    return { valid, stale };
  }

  // ---- Relevant schools: access ON (either role) OR enabled users OR model doc.
  const accessBySchool = new Map();
  for (const doc of accessSchools.docs) {
    const roles = doc.data.roles || {};
    accessBySchool.set(doc.id, {
      student: ((roles.student || {}).enabled) === true,
      teacher: ((roles.teacher || {}).enabled) === true,
    });
  }
  const modelBySchool = new Map();
  for (const doc of modelSchools.docs) {
    const roles = doc.data.roles || {};
    const branch = (name) => {
      const list = roles[name] && Array.isArray(roles[name].modelKeys) ? roles[name].modelKeys : null;
      return list ? list.filter((k) => typeof k === "string") : null; // null = branch absent
    };
    modelBySchool.set(doc.id, {
      exists: true,
      student: branch("student"),
      teacher: branch("teacher"),
      updatedAt: doc.data.updatedAt || null,
    });
  }
  const enabledUsersBySchool = new Map(); // schoolId -> {student, teacher} counts
  for (const doc of accessUsers.docs) {
    if (String(doc.data.accessMode || "").trim().toLowerCase() !== "enabled") continue;
    const sid = String(doc.data.lastKnownSchoolId || "").slice(0, 128);
    if (!sid) continue;
    const role = String(doc.data.lastKnownRole || "").trim().toLowerCase();
    if (!enabledUsersBySchool.has(sid)) enabledUsersBySchool.set(sid, { student: 0, teacher: 0 });
    if (role === "student" || role === "teacher") enabledUsersBySchool.get(sid)[role] += 1;
  }
  const schoolIds = new Set([
    ...accessBySchool.keys(),
    ...modelBySchool.keys(),
    ...enabledUsersBySchool.keys(),
  ]);
  // Drop schools with no SUBI signal at all (access off, no enabled users, no model doc).
  const relevantIds = [...schoolIds].filter((sid) => {
    const acc = accessBySchool.get(sid);
    if (acc && (acc.student || acc.teacher)) return true;
    if (enabledUsersBySchool.has(sid)) return true;
    if (modelBySchool.has(sid)) return true;
    return false;
  });

  // ---- Per-school evaluation ----
  const schools = [];
  for (const sid of relevantIds.sort()) {
    const pol = modelBySchool.get(sid) || { exists: false, student: null, teacher: null, updatedAt: null };
    const rowReasons = [];
    const branches = {};
    if (!pol.exists) {
      rowReasons.push("model policy missing");
    }
    for (const roleName of ["student", "teacher"]) {
      const keys = roleName === "student" ? pol.student : pol.teacher;
      if (!pol.exists) {
        branches[roleName] = { modelCount: 0, validCount: 0, staleCount: 0, staleKeys: [], state: "missing" };
        continue;
      }
      if (keys === null) {
        branches[roleName] = { modelCount: 0, validCount: 0, staleCount: 0, staleKeys: [], state: "missing-branch" };
        rowReasons.push(`${roleName} model list missing`);
        continue;
      }
      const { valid, stale } = await partitionKeys(keys);
      branches[roleName] = {
        modelCount: keys.length,
        validCount: valid.length,
        staleCount: stale.length,
        staleKeys: stale,
        state: keys.length === 0 ? "explicit-empty" : "configured",
      };
      if (stale.length > 0) rowReasons.push(`${stale.length} stale ${roleName} model${stale.length === 1 ? "" : "s"}`);
    }
    let schoolName = null;
    try {
      const s = await d.directory.getSchool(sid);
      if (s) schoolName = s.name;
    } catch (_) {
      schoolName = null;
    }
    // Inherit preview via the authoritative evaluator (no duplication).
    const preview = {};
    for (const roleName of ["student", "teacher"]) {
      const ev = modelPolicies.evaluateModelPolicy({
        userPolicy: null,
        schoolPolicy: {
          roles: {
            student: { modelKeys: pol.student || [] },
            teacher: { modelKeys: pol.teacher || [] },
          },
        },
        role: roleName,
      });
      preview[roleName] = {
        mode: ev.mode,
        models: ev.modelKeys.map((k) => {
          const marks = approvedMarks.get(k) || { hasTerminalMark: false, hasVerifyMark: false };
          return {
            modelKey: k,
            displayName: approvedByKey.get(k) || k,
            hasTerminalMark: marks.hasTerminalMark,
            hasVerifyMark: marks.hasVerifyMark,
          };
        }),
      };
    }
    const ready = rowReasons.length === 0;
    schools.push({
      schoolId: sid,
      ...(schoolName ? { schoolName } : {}),
      policyExists: pol.exists,
      studentModelCount: branches.student.modelCount,
      teacherModelCount: branches.teacher.modelCount,
      studentState: branches.student.state,
      teacherState: branches.teacher.state,
      studentStaleCount: branches.student.staleCount,
      teacherStaleCount: branches.teacher.staleCount,
      studentStaleKeys: branches.student.staleKeys,
      teacherStaleKeys: branches.teacher.staleKeys,
      previewStudent: preview.student.models,
      previewTeacher: preview.teacher.models,
      ready,
      reasons: rowReasons,
    });
    if (!ready) reasons.push(`${sid}: ${rowReasons.join("; ")}`);
  }

  // ---- Individual aggregation ----
  let implicitInherit = null; // by design uncounted: missing policy = inherit, no enumeration
  let explicitInherit = 0;
  let custom = 0;
  let customEmpty = 0;
  let customWithModels = 0;
  let staleCustomUsers = 0;
  let malformed = 0;
  const staleCustomList = [];
  const malformedList = [];
  for (const doc of modelUsers.docs) {
    const data = doc.data || {};
    if (doc.id && data.uid && String(data.uid) !== doc.id) {
      malformed += 1;
      if (malformedList.length < 20) malformedList.push({ uid: doc.id, reason: "uid mismatch" });
      continue;
    }
    const rawMode = typeof data.modelMode === "string" ? data.modelMode.trim().toLowerCase() : "";
    const mode = rawMode === "" ? null : rawMode; // null shouldn't happen (service writes explicit)
    if (mode !== "inherit" && mode !== "custom") {
      malformed += 1;
      if (malformedList.length < 20) malformedList.push({ uid: doc.id, reason: "invalid modelMode" });
      continue;
    }
    const keys = Array.isArray(data.modelKeys) ? data.modelKeys : null;
    if (keys === null) {
      malformed += 1;
      if (malformedList.length < 20) malformedList.push({ uid: doc.id, reason: "modelKeys not an array" });
      continue;
    }
    if (keys.length > MAX_MODEL_KEYS) {
      malformed += 1;
      if (malformedList.length < 20) malformedList.push({ uid: doc.id, reason: "oversized policy" });
      continue;
    }
    const badSyntax = keys.filter((k) => !isValidKeySyntax(k));
    if (badSyntax.length > 0) {
      malformed += 1;
      if (malformedList.length < 20) malformedList.push({ uid: doc.id, reason: "invalid modelKey syntax" });
      continue;
    }
    if (mode === "inherit") {
      explicitInherit += 1;
      continue;
    }
    custom += 1;
    if (keys.length === 0) {
      customEmpty += 1;
      continue;
    }
    customWithModels += 1;
    const { stale } = await partitionKeys(keys);
    if (stale.length > 0) {
      staleCustomUsers += 1;
      if (staleCustomList.length < 20) staleCustomList.push({ uid: doc.id, staleKeys: stale });
      reasons.push(`custom user ${doc.id}: ${stale.length} stale model${stale.length === 1 ? "" : "s"}`);
    }
  }
  if (malformed > 0) reasons.push(`${malformed} malformed individual model ${malformed === 1 ? "policy" : "policies"}`);
  if (usersTruncated) reasons.push("individual policy scan truncated; counts incomplete");

  const summary = {
    relevantSchools: relevantIds.length,
    readySchools: schools.filter((s) => s.ready).length,
    missingPolicies: schools.filter((s) => !s.policyExists).length,
    staleSchoolAssignments: schools.reduce((n, s) => n + s.studentStaleCount + s.teacherStaleCount, 0),
    approvedModels: approved.docs.length,
    implicitInheritUsers: implicitInherit,
    explicitInheritUsers: explicitInherit,
    customUsers: custom,
    customEmptyUsers: customEmpty,
    customWithModelsUsers: customWithModels,
    staleCustomUsers,
    malformedPolicies: malformed,
    usersTruncated,
    approvedTruncated,
  };

  // Capability-mark coverage over the scanned approved set (lower bound when
  // truncated). Keys listed here will render FILE TOOLS ONLY in SUBI until a
  // superadmin sets agentTerminal/agentVerify via the approved-model update
  // API. Informational only: never affects GO/NO_GO policy readiness.
  const missingTerminalMarkKeys = [];
  const missingVerifyMarkKeys = [];
  for (const [key, marks] of approvedMarks) {
    if (!marks.hasTerminalMark && missingTerminalMarkKeys.length < 20) missingTerminalMarkKeys.push(key);
    if (!marks.hasVerifyMark && missingVerifyMarkKeys.length < 20) missingVerifyMarkKeys.push(key);
  }
  summary.modelsMissingTerminalMark = [...approvedMarks.values()].filter((m) => !m.hasTerminalMark).length;
  summary.modelsMissingVerifyMark = [...approvedMarks.values()].filter((m) => !m.hasVerifyMark).length;

  const dataClean = reasons.length === 0;
  if (relevantIds.length === 0) {
    reasons.push("no SUBI-relevant schools; nothing to cut over");
  }
  let ready = dataClean;
  let status = ready ? "GO" : "NO_GO";
  if (cutoverEnabled) {
    ready = false;
    status = "NO_GO";
    reasons.unshift("MODEL_POLICY_CUTOVER is already enabled; readiness is informational only");
  }

  return {
    cutoverEnabled,
    status,
    ready,
    summary,
    schools,
    capabilityMarks: {
      missingTerminalMarkKeys,
      missingVerifyMarkKeys,
    },
    individual: {
      implicitInheritUsers: implicitInherit,
      explicitInheritUsers: explicitInherit,
      customUsers: custom,
      customEmptyUsers: customEmpty,
      customWithModelsUsers: customWithModels,
      staleCustomUsers,
      malformedPolicies: malformed,
      staleCustomList,
      malformedList,
    },
    reasons,
  };

  function fail(reason) {
    return {
      cutoverEnabled,
      status: "NO_GO",
      ready: false,
      summary: {
        relevantSchools: 0,
        readySchools: 0,
        missingPolicies: 0,
        staleSchoolAssignments: 0,
        approvedModels: 0,
        modelsMissingTerminalMark: 0,
        modelsMissingVerifyMark: 0,
        implicitInheritUsers: null,
        explicitInheritUsers: 0,
        customUsers: 0,
        customEmptyUsers: 0,
        customWithModelsUsers: 0,
        staleCustomUsers: 0,
        malformedPolicies: 0,
        usersTruncated: false,
        approvedTruncated: false,
      },
      schools: [],
      capabilityMarks: { missingTerminalMarkKeys: [], missingVerifyMarkKeys: [] },
      individual: {
        implicitInheritUsers: null,
        explicitInheritUsers: 0,
        customUsers: 0,
        customEmptyUsers: 0,
        customWithModelsUsers: 0,
        staleCustomUsers: 0,
        malformedPolicies: 0,
        staleCustomList: [],
        malformedList: [],
      },
      reasons: [reason],
    };
  }
}

module.exports = { runReadiness };
