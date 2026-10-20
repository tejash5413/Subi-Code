// functions-subi/src/services/learnsmartDirectoryService.js
// READ-ONLY directory access to the existing LearnSmart `(default)` database.
//
// BOUNDARY: this module may import ONLY learnsmartDb. It must never import
// subiDb, never write to `(default)`, and never repair/migrate user docs.

const { learnsmartDb } = require("../db");

function cleanString(value, max = 180) {
  return String(value || "").trim().slice(0, max);
}

function normalizeRole(value) {
  return cleanString(value, 60).toLowerCase();
}

// Fail-closed account-type normalization (cutover hardening).
// Only explicit supported values survive: "school" -> "school",
// "individual" -> "individual", anything else (missing, null, "", unknown,
// malformed) -> null. Callers must fail closed on null (quota routing throws
// ACCOUNT_TYPE_UNSUPPORTED; admin guards already use strict !== checks).
// Never infer school from absent data.
function normalizeAccountType(value) {
  const kind = cleanString(value, 32).toLowerCase();
  if (kind === "school") return "school";
  if (kind === "individual") return "individual";
  return null;
}

function toMillisOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "object") {
    if (typeof value.toDate === "function") {
      try {
        const d = value.toDate();
        const t = d instanceof Date ? d.getTime() : NaN;
        return Number.isFinite(t) ? t : null;
      } catch (_) {
        return null;
      }
    }
    if (typeof value.seconds === "number") return value.seconds * 1000;
  }
  return null;
}

// Single-plan SUBI normalization (cutover hardening).
// Supported `subscription.subiCode` shapes (all read-only here):
//   { enabled: true, renewalDateMs? }  -> new single-plan entitlement (preferred)
//   { enabled: false, ... }            -> explicitly disabled (wins over legacy)
//   { tier: "..." } | "tier-string" | true -> legacy tier compat (no tier required)
//   missing/null                        -> no entitlement
// `subiCodeActive` is the authoritative boolean for individual access;
// `subiCodeTier` is retained read-only for legacy display/compat only and
// carries no commercial meaning (no Basic/Plus/Pro plans exist).
// renewalDateMs also honors a nested subiCode.renewalDateMs fallback.
function normalizeSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const subiRaw = value.subiCode;
  const subiObj =
    subiRaw && typeof subiRaw === "object" && !Array.isArray(subiRaw) ? subiRaw : {};
  const tier =
    typeof subiObj.tier === "string" && subiObj.tier.trim()
      ? subiObj.tier.trim()
      : typeof subiRaw === "string" && subiRaw.trim()
        ? subiRaw.trim()
        : null;
  let subiCodeActive;
  if (subiObj.enabled === false) {
    subiCodeActive = false; // explicit disable wins over any legacy tier
  } else if (subiObj.enabled === true) {
    subiCodeActive = true; // new single-plan entitlement
  } else {
    subiCodeActive = Boolean(tier || subiRaw === true);
  }
  return {
    status: cleanString(value.status || "", 32) || null,
    renewalDateMs: toMillisOrNull(
      subiObj.renewalDateMs ?? subiObj.renewalDate ??
      (typeof subiObj.enabled !== 'boolean'
        ? value.renewalDate ?? value.renewAt ?? value.expiresAt ?? value.expiryAt : null)
    ),
    subiCodeTier: tier || (subiRaw === true ? "active" : null),
    subiCodeActive,
    // SUBI billing period (numbers-or-null, additive; existing consumers
    // ignore these). Written only by the SUBI billing webhook.
    periodStartMs: toMillisOrNull(subiObj.periodStartMs ?? null),
    periodEndMs: toMillisOrNull(subiObj.periodEndMs ?? null),
    paidThroughMs: toMillisOrNull(subiObj.paidThroughMs ?? subiObj.renewalDateMs ?? null),
  };
}

// Minimal safe read: trusted identity profile for backend authorization.
// Returns only fields the backend needs; never secrets or full doc dumps.
async function getUserProfile(uid) {
  const id = cleanString(uid, 128);
  if (!id) throw new Error("getUserProfile: missing uid");
  const snap = await learnsmartDb.collection("users").doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    uid: id,
    role: normalizeRole(data.role),
    email: cleanString(data.email, 120),
    displayName: cleanString(data.displayName || data.name, 120),
    phone: cleanString(data.phone || data.phoneNumber, 20),
    accountType: normalizeAccountType(data.accountType),
    schoolId: cleanString(data.schoolId, 128),
    studentId: cleanString(data.studentId, 128),
    teacherId: cleanString(data.teacherId, 128),
    status: cleanString(data.status, 32),
    active: data.active !== false,
    // Preserve absence for the legacy Super Admin admission exception only.
    statusConfigured: Object.prototype.hasOwnProperty.call(data, 'status'),
    subscription: normalizeSubscription(data.subscription),
  };
}

// Minimal safe read: school display info for admin lookup.
// schoolId remains canonical; name is display-only.
async function getSchool(schoolId) {
  const id = cleanString(schoolId, 128);
  if (!id) throw new Error("getSchool: missing schoolId");
  const snap = await learnsmartDb.collection("schools").doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    id,
    name: cleanString(data.name || id, 180),
    accountType: normalizeAccountType(data.accountType),
    subscription: normalizeSubscription(data.subscription),
  };
}

const MANAGED_DIRECTORY_ROLES = new Set(["student", "teacher"]);

// Trusted managed-user projection for SUBI individual administration.
// Returns null for unknown users or non-managed roles. Display fields only.
async function getManagedUserByUid(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return null;
  if (!MANAGED_DIRECTORY_ROLES.has(profile.role)) return null;
  if (profile.accountType !== 'school' && profile.accountType !== 'individual') return null;
  if (profile.accountType === 'school' && !profile.schoolId) return null;
  const snap = await learnsmartDb.collection("users").doc(profile.uid).get();
  const data = snap.exists ? snap.data() || {} : {};
  return {
    uid: profile.uid,
    displayName: cleanString(data.displayName || data.name || profile.uid, 180),
    role: profile.role,
    accountType: profile.accountType,
    schoolId: profile.schoolId,
    email: cleanString(data.email || "", 180),
    studentId: cleanString(data.studentId || profile.studentId, 128),
    teacherId: cleanString(data.teacherId || profile.teacherId, 128),
    status: profile.status,
  };
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

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function normalizeHaystack(data) {
  return [
    data.displayName,
    data.name,
    data.email,
    data.studentId,
    data.teacherId,
  ]
    .map((v) => String(v || "").toLowerCase())
    .join(" | ");
}

// Bounded Superadmin search over canonical users/{uid} (Phase 3B).
// No prefix index exists, so: exact-email equality fast path, then bounded
// doc-ID-ordered pages with server-side substring filtering. Hard budgets:
// max 50 results, max 500 scanned docs per request.
async function searchManagedUsers({ q, role, accountType, schoolId, limit, cursor } = {}) {
  const rawQ = String(q || "").trim().slice(0, 120);
  const cleanQ = rawQ.toLowerCase();
  const cleanRole = String(role || "all").trim().toLowerCase();
  if (!["all", "student", "teacher"].includes(cleanRole)) {
    const err = new Error("invalid role filter");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const cleanSchool = cleanString(schoolId, 128);
  const cleanAccountType = String(accountType || "all").trim().toLowerCase();
  if (!["all", "school", "individual"].includes(cleanAccountType)) {
    const err = new Error("invalid accountType filter");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  let maxResults = Number(limit);
  if (!Number.isFinite(maxResults) || maxResults <= 0) maxResults = 20;
  maxResults = Math.min(Math.max(Math.floor(maxResults), 1), 50);

  let parsedCursor = null;
  if (cursor !== undefined && cursor !== null && String(cursor) !== "") {
    parsedCursor = decodeCursor(cursor);
    if (
      !parsedCursor ||
      parsedCursor.q !== cleanQ ||
      parsedCursor.role !== cleanRole ||
      (parsedCursor.accountType || "all") !== cleanAccountType ||
      (parsedCursor.schoolId || "") !== cleanSchool
    ) {
      const err = new Error("invalid cursor");
      err.code = "INVALID_REQUEST";
      throw err;
    }
  }

  const col = learnsmartDb.collection("users");
  const results = [];
  let scanned = 0;
  let lastId = (parsedCursor && parsedCursor.lastId) || null;
  // Per-request bound. A cursor continues after lastId but receives a fresh
  // scan budget; persisting pagesUsed made every continuation immediately
  // terminate after the first four pages.
  let pagesUsed = 0;
  const SCAN_BUDGET = 500;
  const PAGE_SIZE = 150;
  const MAX_PAGES = 4;

  const matchesFilters = (row) =>
    row &&
    (cleanRole === "all" || row.role === cleanRole) &&
    (cleanAccountType === "all" || row.accountType === cleanAccountType) &&
    (!cleanSchool || row.schoolId === cleanSchool);

  // Indexed exact-match fast path for admin lookups. This reaches a user
  // anywhere in a large directory without an unbounded collection scan.
  // Substring search still uses the bounded paged fallback below.
  if (!parsedCursor && cleanQ) {
    const exactQueries = [];
    const exactValues = [...new Set([rawQ, cleanQ].filter(Boolean))];
    const fields = looksLikeEmail(cleanQ)
      ? ["email"]
      : ["displayName", "name", "studentId", "teacherId"];
    for (const field of fields) {
      for (const value of exactValues) {
        exactQueries.push(col.where(field, "==", value).limit(10).get());
      }
    }
    if (!rawQ.includes("/")) exactQueries.push(col.doc(rawQ).get());
    const exactSnaps = await Promise.all(exactQueries);
    const exactDocs = new Map();
    for (const snap of exactSnaps) {
      if (snap && Array.isArray(snap.docs)) {
        for (const doc of snap.docs) exactDocs.set(doc.id, doc);
      } else if (snap && snap.exists) {
        exactDocs.set(snap.id, snap);
      }
    }
    for (const doc of exactDocs.values()) {
      const row = projectManagedRow(doc.id, doc.data() || {});
      if (matchesFilters(row)) {
        results.push(row);
        if (results.length >= maxResults) break;
      }
    }
    if (results.length > 0) {
      return { users: results.slice(0, maxResults), nextCursor: null };
    }
  }

  while (results.length < maxResults && scanned < SCAN_BUDGET && pagesUsed < MAX_PAGES) {
    let query = col.orderBy("__name__").limit(PAGE_SIZE);
    if (lastId) query = query.startAfter(lastId);
    const snap = await query.get();
    if (snap.empty) break;
    pagesUsed += 1;
    for (const doc of snap.docs) {
      scanned += 1;
      lastId = doc.id;
      if (results.length >= maxResults) break;
      const data = doc.data() || {};
      const row = projectManagedRow(doc.id, data);
      if (!row) continue;
      if (cleanRole !== "all" && row.role !== cleanRole) continue;
      if (cleanAccountType !== "all" && row.accountType !== cleanAccountType) continue;
      if (cleanSchool && row.schoolId !== cleanSchool) continue;
      if (cleanQ) {
        const hay = normalizeHaystack({
          displayName: row.displayName,
          email: row.email,
          studentId: row.studentId,
          teacherId: row.teacherId,
        });
        const tokens = cleanQ.split(/\s+/).filter(Boolean);
        if (!tokens.every((t) => hay.includes(t))) continue;
      }
      results.push(row);
    }
    if (snap.docs.length < PAGE_SIZE) {
      lastId = null;
      break;
    }
  }

  const scanMayHaveMore = scanned >= SCAN_BUDGET || pagesUsed >= MAX_PAGES;
  const nextCursor =
    lastId && (results.length >= maxResults || scanMayHaveMore)
      ? encodeCursor({
          v: 1,
          q: cleanQ,
          role: cleanRole,
          accountType: cleanAccountType,
          schoolId: cleanSchool,
          lastId,
        })
      : null;
  return { users: results.slice(0, maxResults), nextCursor };
}

function projectManagedRow(uid, data) {
  const role = normalizeRole(data.role);
  if (!MANAGED_DIRECTORY_ROLES.has(role)) return null;
  const schoolId = cleanString(data.schoolId, 128);
  const accountType = normalizeAccountType(data.accountType);
  if (accountType !== 'school' && accountType !== 'individual') return null;
  if (accountType === 'school' && !schoolId) return null;
  return {
    uid: cleanString(uid, 128),
    displayName: cleanString(data.displayName || data.name || uid, 180),
    role,
    accountType,
    schoolId,
    email: cleanString(data.email || "", 180),
    studentId: cleanString(data.studentId || "", 128),
    teacherId: cleanString(data.teacherId || "", 128),
    status: cleanString(data.status, 32),
  };
}

module.exports = {
  normalizeAccountType,
  normalizeSubscription,
  getUserProfile,
  getSchool,
  getManagedUserByUid,
  searchManagedUsers,
};
