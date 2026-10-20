// functions-subi/src/services/usageService.js
// SUBI managed token-usage accounting (Usage tab backend).
//
// DOMAINS: ACCESS = WHO (accessService) · MODELS = WHICH (modelPolicyService)
// · LIMITS = HOW MANY (monthlyLimitService). This file records HOW MUCH was
// actually consumed. It never enforces limits and never gates access.
//
// BOUNDARY: uses ONLY subiDb (via injected store defaulting to it).
// Never learnsmartDb, never secretService / aiConnectionService /
// modelCatalogService / OpenRouter / managed key / fetch. Counters only —
// NEVER prompts, completions, or message text (see check-no-leak.js).
//
// Layout (named `subi` database), one calendar month (Asia/Kolkata) per root:
//   usageMonthly/{YYYY-MM}/schools/{schoolId}
//     { inputTokens, outputTokens, requests,
//       byRole: { student: {in,out,req}, teacher: {...} },
//       byModel: { mdl_key: {in,out,req} }, updatedAt }
//   usageMonthly/{YYYY-MM}/schools/{schoolId}/users/{uid}
//     { inputTokens, outputTokens, requests, byModel: {...},
//       lastKnownRole, updatedAt }
//
// The logging hook lives in the future managed chat path, which calls
// recordUsage() with OpenRouter response usage (prompt/completion tokens).
// Until then readers return zeros with an explicit empty state — no fake data.
//
// DI: every method accepts optional `deps` ({ store }) for fakes.

const { subiDb } = require("../db");
const { currentMonthIST, cleanMonth } = require("./usagePeriod");

const USAGE_COLLECTION = "usageMonthly";
const MANAGED_ROLES = new Set(["student", "teacher"]);

// Per-call sanity ceiling (matches approved context ceiling). Absurd values
// are rejected, never stored.
const MAX_TOKENS_PER_CALL = 10_000_000;
const MODEL_KEY_RE = /^mdl_[A-Za-z0-9-]+$/;
const MAX_KEY_LEN = 128;
// Month validation lives in usagePeriod.cleanMonth (single authority).

// Max user docs scanned per list request; page size capped separately.
const MAX_SCAN = 200;
const MAX_PAGE = 50;
const DEFAULT_PAGE = 20;

function defaultDeps() {
  return { store: subiDb };
}

function cleanId(value, max = 128) {
  return String(value || "").trim().slice(0, max);
}

function invalidRequest(message) {
  const err = new Error(message || "invalid usage payload");
  err.code = "INVALID_REQUEST";
  throw err;
}

// Month helpers live in usagePeriod.js (single authority). Re-exported here
// so existing callers/tests keep working.
function cleanCount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) invalidRequest("token count must be a safe integer");
  if (value < 0 || value > MAX_TOKENS_PER_CALL) invalidRequest("token count out of range");
  return value;
}

function num(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function emptyCounters() {
  return { inputTokens: 0, outputTokens: 0, requests: 0 };
}

function emptyRoleSplit() {
  return {
    student: { inputTokens: 0, outputTokens: 0, requests: 0 },
    teacher: { inputTokens: 0, outputTokens: 0, requests: 0 },
  };
}

function schoolDocRef(store, month, schoolId) {
  return store.collection(USAGE_COLLECTION).doc(month).collection("schools").doc(schoolId);
}

function userDocRef(store, month, schoolId, uid) {
  return schoolDocRef(store, month, schoolId).collection("users").doc(uid);
}

function usersCollection(store, month, schoolId) {
  return schoolDocRef(store, month, schoolId).collection("users");
}

// Canonical quota counters written by usageQuotaService.
function quotaUserDocRef(store, month, uid) {
  return store.collection(USAGE_COLLECTION).doc(month).collection("users").doc(uid);
}

// ---------- Writer (logging hook) ----------
// Fail-open contract lives with the CALLER (chat path must catch errors so
// accounting never blocks chat). This function itself throws INVALID_REQUEST
// on bad input and INTERNAL-equivalent store errors bubble as INTERNAL.
async function recordUsage({ uid, schoolId, role, modelKey, inputTokens, outputTokens }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const school = cleanId(schoolId);
  const cleanRole = String(role || "").trim().toLowerCase();
  const key = String(modelKey || "").trim().slice(0, MAX_KEY_LEN);
  if (!id || !school) invalidRequest("missing uid/schoolId");
  if (!MANAGED_ROLES.has(cleanRole)) invalidRequest("invalid role");
  if (!MODEL_KEY_RE.test(key)) invalidRequest("invalid modelKey");
  const inT = cleanCount(inputTokens);
  const outT = cleanCount(outputTokens);
  const month = currentMonthIST();
  const now = new Date();
  const sRef = schoolDocRef(d.store, month, school);
  const uRef = userDocRef(d.store, month, school, id);
  try {
    await d.store.runTransaction(async (tx) => {
      const [sSnap, uSnap] = await Promise.all([tx.get(sRef), tx.get(uRef)]);
      const sData = sSnap.exists ? sSnap.data() || {} : {};
      const uData = uSnap.exists ? uSnap.data() || {} : {};
      const bump = (node) => ({
        inputTokens: num(node && node.inputTokens) + inT,
        outputTokens: num(node && node.outputTokens) + outT,
        requests: num(node && node.requests) + 1,
      });
      const sByRole = (sData.byRole && typeof sData.byRole === "object") ? sData.byRole : {};
      const sByModel = (sData.byModel && typeof sData.byModel === "object") ? sData.byModel : {};
      const uByModel = (uData.byModel && typeof uData.byModel === "object") ? uData.byModel : {};
      tx.set(
        sRef,
        {
          schoolId: school,
          month,
          ...bump(sData),
          byRole: { ...sByRole, [cleanRole]: bump(sByRole[cleanRole]) },
          byModel: { ...sByModel, [key]: bump(sByModel[key]) },
          updatedAt: now,
        },
        { merge: true }
      );
      tx.set(
        uRef,
        {
          uid: id,
          schoolId: school,
          month,
          lastKnownRole: cleanRole,
          ...bump(uData),
          byModel: { ...uByModel, [key]: bump(uByModel[key]) },
          updatedAt: now,
        },
        { merge: true }
      );
    });
  } catch (err) {
    if (err && err.code === "INVALID_REQUEST") throw err;
    const e = new Error("usage store unavailable");
    e.code = "INTERNAL";
    throw e;
  }
  return { uid: id, schoolId: school, month, inputTokens: inT, outputTokens: outT };
}

// ---------- Readers ----------

function toSafeSchoolUsage(schoolId, month, data) {
  const byRole = (data && data.byRole && typeof data.byRole === "object") ? data.byRole : {};
  const byModel = (data && data.byModel && typeof data.byModel === "object") ? data.byModel : {};
  const role = (name) => {
    const r = byRole[name] || {};
    return { inputTokens: num(r.inputTokens), outputTokens: num(r.outputTokens), requests: num(r.requests) };
  };
  const models = {};
  for (const [k, v] of Object.entries(byModel).slice(0, 500)) {
    if (typeof k !== "string" || !v || typeof v !== "object") continue;
    models[k.slice(0, MAX_KEY_LEN)] = {
      inputTokens: num(v.inputTokens),
      outputTokens: num(v.outputTokens),
      requests: num(v.requests),
    };
  }
  return {
    schoolId,
    month,
    inputTokens: num(data && data.inputTokens),
    outputTokens: num(data && data.outputTokens),
    requests: num(data && data.requests),
    byRole: { student: role("student"), teacher: role("teacher") },
    byModel: models,
    updatedAt: (data && data.updatedAt) || null,
  };
}

async function getSchoolUsage({ schoolId, month }, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  if (!id) invalidRequest("missing schoolId");
  const m = month === undefined || month === null || month === "" ? currentMonthIST() : cleanMonth(month);
  if (m > currentMonthIST()) invalidRequest("month is in the future");
  const snap = await schoolDocRef(store, m, id).get();
  return toSafeSchoolUsage(id, m, snap.exists ? snap.data() : null);
}

function toSafeUserUsage(uid, schoolId, month, data) {
  const byModel = (data && data.byModel && typeof data.byModel === "object") ? data.byModel : {};
  const models = {};
  for (const [k, v] of Object.entries(byModel).slice(0, 500)) {
    if (typeof k !== "string" || !v || typeof v !== "object") continue;
    models[k.slice(0, MAX_KEY_LEN)] = {
      inputTokens: num(v.inputTokens),
      outputTokens: num(v.outputTokens),
      requests: num(v.requests),
    };
  }
  return {
    uid,
    schoolId,
    month,
    inputTokens: num(data && data.inputTokens),
    outputTokens: num(data && data.outputTokens),
    requests: num(data && data.requests),
    conservativeChargedTokens: num(data && data.conservativeChargedTokens),
    byModel: models,
    accountType: data && data.lastKnownAccountType === "individual" ? "individual" : "school",
    lastKnownRole: data && typeof data.lastKnownRole === "string" ? data.lastKnownRole : null,
    updatedAt: (data && data.updatedAt) || null,
  };
}

async function getUserUsage({ uid, schoolId, month }, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const fallbackSchool = cleanId(schoolId);
  if (!id || !fallbackSchool) invalidRequest("missing uid/schoolId");
  const m = month === undefined || month === null || month === "" ? currentMonthIST() : cleanMonth(month);
  if (m > currentMonthIST()) invalidRequest("month is in the future");
  let snap = await quotaUserDocRef(store, m, id).get();
  // Compatibility for pre-quota/recordUsage counters. New managed traffic
  // always uses the canonical UID document above.
  if (!snap.exists) snap = await userDocRef(store, m, fallbackSchool, id).get();
  const data = snap.exists ? snap.data() || {} : {};
  const canonicalSchool = cleanId(data.lastKnownSchoolId) || fallbackSchool;
  return toSafeUserUsage(id, canonicalSchool, m, data);
}
function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

// Bounded user listing for one school+month, sorted by total tokens desc.
// Offset cursor is snapshot-local (admin UI scale) — deterministic for a
// stable snapshot, never unbounded.
async function listSchoolUserUsage({ schoolId, month, limit, cursor }, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(schoolId);
  if (!id) invalidRequest("missing schoolId");
  const m = month === undefined || month === null || month === "" ? currentMonthIST() : cleanMonth(month);
  if (m > currentMonthIST()) invalidRequest("month is in the future");
  let maxResults = Number(limit);
  if (!Number.isFinite(maxResults) || maxResults <= 0) maxResults = DEFAULT_PAGE;
  maxResults = Math.min(Math.max(Math.floor(maxResults), 1), MAX_PAGE);
  let offset = 0;
  if (cursor !== undefined && cursor !== null && String(cursor) !== "") {
    const parsed = decodeCursor(cursor);
    if (!parsed || typeof parsed.off !== "number" || parsed.off < 0) invalidRequest("invalid cursor");
    offset = Math.floor(parsed.off);
  }
  const snap = await usersCollection(store, m, id).limit(MAX_SCAN).get();
  const rows = (snap.docs || []).map((doc) => toSafeUserUsage(doc.id, id, m, doc.data() || {}));
  rows.sort(
    (a, b) =>
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || (a.uid < b.uid ? -1 : 1)
  );
  const page = rows.slice(offset, offset + maxResults);
  const nextCursor =
    offset + maxResults < rows.length ? encodeCursor({ v: 1, off: offset + maxResults }) : null;
  return { users: page, nextCursor, month: m };
}

module.exports = {
  MAX_TOKENS_PER_CALL,
  currentMonthIST,
  recordUsage,
  getSchoolUsage,
  getUserUsage,
  listSchoolUserUsage,
};
