// functions-subi/src/services/usageQuotaService.js
// Phase 9A authoritative per-UID quota enforcement (reservation + reconcile).
//
// DOMAINS: ACCESS = WHO · MODELS = WHICH · LIMITS = HOW MANY (config) ·
// QUOTA (this file) = HOW MUCH of the allowance is spent/reserved.
//
// Quota authority is the Firebase UID. School/byModel counters are
// ANALYTICS ONLY and never gate acceptance.
//
// Canonical state: usageMonthly/{period}/users/{uid}
//   { inputTokens, outputTokens, conservativeChargedTokens, requests,
//     activeReservations: { <reservationId>: { amount, state, expiresAt,
//       modelKey, schoolId, role } },
//     byModel: { <modelKey>: { inputTokens, outputTokens,
//       conservativeChargedTokens, requests } }, ... }
// Idempotency/terminal records: usageMonthly/{period}/reservations/{id}
//   where id = sha256(uid + "\0" + requestId). Terminal docs stay; only the
//   ACTIVE map is bounded (25) and swept.
//
// Active lifecycle (Phase 9A.1 risk boundary):
//   RESERVED   = quota held, NO upstream HTTP request dispatched yet.
//                Only this state may release for zero usage.
//   DISPATCHED = upstream dispatch attempted after durable write; provider
//                consumption is now POSSIBLE (provider-risk state).
//   STARTED    = upstream returned successful 2xx (provider-risk state).
// Terminal: completed | failed | cancelled | expired. Terminal docs stay
// for idempotency; only the ACTIVE map is bounded (25) and swept.
//
// BOUNDARY: uses ONLY subiDb (via injected store). Never learnsmartDb,
// secrets, OpenRouter, fetch. Never prompts/completions/message text.
// Never trusts client token counts — every number here is server-derived.
//
// DI: methods accept optional `deps` ({ store }) for fakes. All
// transaction bodies use ONLY tx.get/tx.set with complete top-level field
// values (fake-safe under shallow merge).

const crypto = require("crypto");
const { subiDb } = require("../db");
const { currentMonthIST } = require("./usagePeriod");
const monthlyLimits = require("./monthlyLimitService");
// Nested-delete sentinel for activeReservations pruning (Phase 9B.2M).
// Firestore {merge:true} deep-merges nested maps, so omitting a key never
// removes it — only FieldValue.delete() physically deletes a nested field.
const { FieldValue } = require("firebase-admin/firestore");

const USAGE_COLLECTION = "usageMonthly";
const MANAGED_ROLES = new Set(["student", "teacher"]);
const MODEL_KEY_RE = /^mdl_[A-Za-z0-9-]+$/;
const MAX_KEY_LEN = 128;

// ---- Centralized quota constants (do not silently reduce) ----
const RESERVATION_TTL_SECONDS = 600; // 500s stream ceiling + buffer
const MAX_ACTIVE_RESERVATIONS = 25;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096; // ceiling, not mandatory (§26)
const MIN_OUTPUT_TOKENS = 64;
const PER_MESSAGE_OVERHEAD_TOKENS = 64;
const REQUEST_OVERHEAD_TOKENS = 256;
const MAX_MODELKEYS_PER_USER_MONTH = 100;
const MAX_TOKENS_PER_RECORD = 100_000_000; // sanity ceiling per number

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "expired"]);
const ACTIVE_STATES = new Set(["reserved", "dispatched", "started"]);
// Provider-risk states: consumption may already have happened. Unknown
// usage here must NEVER resolve to zero charge.
const PROVIDER_RISK_STATES = new Set(["dispatched", "started"]);

function isProviderRisk(state) {
  return PROVIDER_RISK_STATES.has(state);
}

// Pure accounting decision for an abnormal termination. Route-owned risk
// flags in, terminal directive out — no store access, fully testable.
//   release: no upstream risk existed (RESERVED only) → zero charge.
//   commit:  exact server-observed usage available → commit it.
//   charge:  upstream risk existed but usage unrecoverable → full reserve.
function classifyFinalization({ upstreamDispatched, usage }) {
  if (!upstreamDispatched) return "release";
  const u = (usage && typeof usage === "object") ? usage : {};
  const inn = Number.isSafeInteger(u.inputTokens) && u.inputTokens >= 0 ? u.inputTokens : 0;
  const out = Number.isSafeInteger(u.outputTokens) && u.outputTokens >= 0 ? u.outputTokens : 0;
  return inn + out > 0 ? "commit" : "charge";
}

function defaultDeps() {
  return { store: subiDb };
}

function cleanId(value, max = 128) {
  return String(value || "").trim().slice(0, max);
}

function normalizeAccountType(value) {
  return String(value || "").trim().toLowerCase() === "individual" ? "individual" : "school";
}

function invalidRequest(message) {
  const err = new Error(message || "invalid quota payload");
  err.code = "INVALID_REQUEST";
  err.isSubiDomainError = true;
  throw err;
}

function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  err.isSubiDomainError = true;
  return err;
}

function num(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cleanNonNegativeInt(value, what) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidRequest(`${what} must be a non-negative safe integer`);
  }
  if (value > MAX_TOKENS_PER_RECORD) invalidRequest(`${what} out of range`);
  return value;
}

function cleanModelKey(value) {
  const key = String(value || "").trim().slice(0, MAX_KEY_LEN);
  if (!key || !MODEL_KEY_RE.test(key)) invalidRequest("invalid modelKey");
  return key;
}

function cleanRequestId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    invalidRequest("invalid requestId");
  }
  return value;
}

// Phase 9B.2M: explicit nested-delete for pruned activeReservations keys.
// Returns a copy of the map with a FieldValue.delete() sentinel for every
// listed reservation ID. The sentinel is a no-op for keys that do not
// exist, so callers may pass it unconditionally. Reservation IDs are
// sha256 hex used as literal object keys (never field-path strings).
function withPrunedEntries(activeMap, reservationIds) {
  const out = { ...((activeMap && typeof activeMap === "object") ? activeMap : {}) };
  for (const rid of reservationIds || []) {
    if (typeof rid === "string" && rid) out[rid] = FieldValue.delete();
  }
  return out;
}

function reservationIdFor(uid, requestId) {
  return crypto.createHash("sha256").update(`${uid}\0${requestId}`, "utf8").digest("hex");
}

function userRef(store, period, uid) {
  return store.collection(USAGE_COLLECTION).doc(period).collection("users").doc(uid);
}

function reservationRef(store, period, reservationId) {
  return store.collection(USAGE_COLLECTION).doc(period).collection("reservations").doc(reservationId);
}

function schoolRef(store, period, schoolId) {
  return store.collection(USAGE_COLLECTION).doc(period).collection("schools").doc(schoolId);
}

// ---------- Conservative input estimator ----------
// Upper bound that cannot systematically under-reserve: UTF-8 bytes of all
// message content + server-owned system bytes + per-message framing +
// fixed request overhead. One token always encodes >= 1 byte, so byte
// counts dominate any tokenizer. NEVER chars/4 for enforcement.
function estimateInputUpperBound(messages, serverSystemChars = 0) {
  if (!Array.isArray(messages) || messages.length === 0) invalidRequest("messages required");
  let bytes = 0;
  for (const m of messages) {
    const content = m && typeof m.content === "string" ? m.content : "";
    bytes += Buffer.byteLength(content, "utf8");
  }
  if (typeof serverSystemChars === "number") {
    if (!Number.isSafeInteger(serverSystemChars) || serverSystemChars < 0) {
      invalidRequest("invalid server-owned input size");
    }
    bytes += serverSystemChars;
  } else {
    bytes += Buffer.byteLength(String(serverSystemChars || ""), "utf8");
  }
  return bytes + messages.length * PER_MESSAGE_OVERHEAD_TOKENS + REQUEST_OVERHEAD_TOKENS;
}

// ---------- Derived formulas (never stored redundantly) ----------
function committedUsed(userData) {
  return (
    num(userData && userData.inputTokens) +
    num(userData && userData.outputTokens) +
    num(userData && userData.conservativeChargedTokens)
  );
}

function liveActiveEntries(activeMap, nowMs) {
  const live = {};
  const expired = [];
  const src = activeMap && typeof activeMap === "object" ? activeMap : {};
  for (const [id, e] of Object.entries(src)) {
    if (!e || typeof e !== "object" || !ACTIVE_STATES.has(e.state)) continue;
    if (typeof e.expiresAt === "number" && e.expiresAt <= nowMs) {
      expired.push({ id, entry: e });
      continue;
    }
    live[id] = e;
  }
  return { live, expired };
}

function activeReservedTotal(liveMap) {
  let total = 0;
  for (const e of Object.values(liveMap)) total += num(e && e.amount);
  return total;
}

// ---------- Stale sweep (inside caller transaction) ----------
// Transaction-snapshot rule: ALL reads in one txn see the same snapshot,
// so every adjustment is aggregated in memory and each document is written
// EXACTLY ONCE below (repeated read-modify-write cycles would clobber).
//
// Reserved-expired → release, zero charge. Dispatched/started-expired →
// conservative full charge (NEVER silent release: that would be a crash
// bypass after provider risk began).
// Returns { live, swept, charged, released, userBase } where userBase holds
// post-sweep { conservativeChargedTokens, requests, byModel } for the caller
// to persist with its own single user-doc write.
async function applySweep(tx, store, period, uid, userData, nowMs) {
  const activeMap = (userData && userData.activeReservations && typeof userData.activeReservations === "object")
    ? userData.activeReservations
    : {};
  const { live, expired } = liveActiveEntries(activeMap, nowMs);
  let charged = 0;
  let released = 0;
  let userConservative = num(userData && userData.conservativeChargedTokens);
  let userRequests = num(userData && userData.requests);
  const userByModel = (userData && userData.byModel && typeof userData.byModel === "object")
    ? { ...userData.byModel }
    : {};
  const schoolAggs = new Map(); // schoolId -> { conservative, requests, byRole:{}, byModel:{} }

  // Phase 9B.2J: reads-before-writes restructure. Pass 1 reads every
  // expired reservation doc plus every candidate school doc; pass 2 decides
  // and queues reservation writes; pass 3 queues school writes. Decisions,
  // conditions, and write contents are identical to the previous inline
  // version — only the operation order changed (Firestore rule).
  const sweepReads = [];
  const sweepSchoolIds = new Set();
  for (const { id, entry } of expired) {
    if (entry && typeof entry.schoolId === "string" && entry.schoolId) {
      sweepSchoolIds.add(entry.schoolId);
    }
    let snapData = null;
    let readable = true;
    try {
      const snap = await tx.get(reservationRef(store, period, id));
      if (snap.exists) snapData = snap.data() || {};
    } catch (_) {
      readable = false;
    }
    sweepReads.push({ id, entry, snapData, readable });
  }
  // Candidate school docs are known from the expired entries alone, so all
  // school reads also happen before any write.
  const sweepSchoolReads = new Map();
  for (const schoolId of sweepSchoolIds) {
    let sData = {};
    try {
      const snap = await tx.get(schoolRef(store, period, schoolId));
      if (snap.exists) sData = snap.data() || {};
    } catch (_) {
      sData = {};
    }
    sweepSchoolReads.set(schoolId, sData);
  }
  for (const { id, entry, snapData, readable } of sweepReads) {
    const amount = num(entry && entry.amount);
    const modelKey = entry && typeof entry.modelKey === "string" ? entry.modelKey : null;
    const schoolId = entry && typeof entry.schoolId === "string" && entry.schoolId ? entry.schoolId : null;
    const role = entry && (entry.role === "student" || entry.role === "teacher") ? entry.role : null;
    let alreadyTerminal = false;
    let docRisk = false;
    if (readable && snapData) {
      alreadyTerminal = TERMINAL_STATES.has(snapData.state);
      docRisk = isProviderRisk(snapData.state);
      if (!alreadyTerminal) {
        const risk = docRisk || (entry && isProviderRisk(entry.state));
        tx.set(reservationRef(store, period, id), {
          ...snapData,
          state: "expired",
          ...(risk
            ? { conservativeChargedTokens: amount, finalReason: "stale-started-charged" }
            : { finalReason: "stale-reserved-released" }),
          completedAt: new Date(),
        });
      }
    }
    // Provider risk from EITHER the map entry or the durable doc charges.
    // (Unreadable docs keep prior behavior: decided from the map entry.)
    if ((entry && isProviderRisk(entry.state) || docRisk) && !alreadyTerminal) {
      userConservative += amount;
      userRequests += 1;
      if (modelKey && Object.keys(userByModel).length < MAX_MODELKEYS_PER_USER_MONTH + 1) {
        const prev = userByModel[modelKey] || {};
        userByModel[modelKey] = {
          inputTokens: num(prev.inputTokens),
          outputTokens: num(prev.outputTokens),
          conservativeChargedTokens: num(prev.conservativeChargedTokens) + amount,
          requests: num(prev.requests) + 1,
        };
      }
      if (schoolId) {
        if (!schoolAggs.has(schoolId)) {
          schoolAggs.set(schoolId, { conservative: 0, requests: 0, byRole: {}, byModel: {} });
        }
        const agg = schoolAggs.get(schoolId);
        agg.conservative += amount;
        agg.requests += 1;
        if (role) agg.byRole[role] = (agg.byRole[role] || 0) + amount;
        if (modelKey) agg.byModel[modelKey] = (agg.byModel[modelKey] || 0) + amount;
      }
      charged += amount;
    } else {
      released += amount;
    }
  }

  // One write per school analytics doc (aggregated). Consumes the
  // pre-read snapshots above — no reads here.
  for (const [schoolId, agg] of schoolAggs) {
    const ref = schoolRef(store, period, schoolId);
    const sData = sweepSchoolReads.get(schoolId) || {};
    const sByRole = (sData.byRole && typeof sData.byRole === "object") ? { ...sData.byRole } : {};
    const sByModel = (sData.byModel && typeof sData.byModel === "object") ? { ...sData.byModel } : {};
    for (const [role, amt] of Object.entries(agg.byRole)) {
      const prev = sByRole[role] || {};
      sByRole[role] = {
        inputTokens: num(prev.inputTokens),
        outputTokens: num(prev.outputTokens),
        conservativeChargedTokens: num(prev.conservativeChargedTokens) + amt,
        requests: num(prev.requests) + agg.requests,
      };
    }
    for (const [mk, amt] of Object.entries(agg.byModel)) {
      const prev = sByModel[mk] || {};
      sByModel[mk] = {
        inputTokens: num(prev.inputTokens),
        outputTokens: num(prev.outputTokens),
        conservativeChargedTokens: num(prev.conservativeChargedTokens) + amt,
        requests: num(prev.requests) + agg.requests,
      };
    }
    tx.set(ref, {
      schoolId,
      month: period,
      inputTokens: num(sData.inputTokens),
      outputTokens: num(sData.outputTokens),
      conservativeChargedTokens: num(sData.conservativeChargedTokens) + agg.conservative,
      requests: num(sData.requests) + agg.requests,
      byRole: sByRole,
      byModel: sByModel,
      updatedAt: new Date(),
    }, { merge: true });
  }

  return {
    live,
    swept: expired.length,
    charged,
    released,
    expiredIds: expired.map(({ id }) => id),
    userBase: { conservativeChargedTokens: userConservative, requests: userRequests, byModel: userByModel },
  };
}

// ---------- Reserve ----------
async function reserveUsage(
  { uid, schoolId, role, accountType, modelKey, requestId, inputUpperBound, defaultMaxOutputTokens },
  deps
) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const school = cleanId(schoolId);
  const cleanRole = String(role || "").trim().toLowerCase();
  const cleanAccountType = normalizeAccountType(accountType);
  const policyAccountType = accountType === undefined ? undefined : cleanAccountType;
  const key = cleanModelKey(modelKey);
  const rid = cleanRequestId(requestId);
  if (!id || !school) invalidRequest("missing uid/schoolId");
  if (cleanRole !== "student" && cleanRole !== "teacher") invalidRequest("invalid role");
  const inUpper = cleanNonNegativeInt(inputUpperBound, "inputUpperBound");
  const defMax = defaultMaxOutputTokens === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : defaultMaxOutputTokens;
  if (typeof defMax !== "number" || !Number.isSafeInteger(defMax) || defMax <= 0) {
    invalidRequest("defaultMaxOutputTokens must be a positive safe integer");
  }
  const period = currentMonthIST();
  const reservationId = reservationIdFor(id, rid);
  const nowMs = Date.now();
  const now = new Date();

  // Idempotency outcomes are RETURNED from the transaction (never thrown
  // inside it): stale same-requestId cleanup must COMMIT before the refusal
  // is produced. Refusal errors are raised OUTSIDE, after commit.
  const outcome = await d.store.runTransaction(async (tx) => {
    // Idempotency first: deterministic doc per (uid, requestId).
    const resSnap = await tx.get(reservationRef(d.store, period, reservationId));
    if (resSnap.exists) {
      const existing = resSnap.data() || {};
      const expired = typeof existing.expiresAt === "number" && existing.expiresAt <= nowMs;
      if (!TERMINAL_STATES.has(existing.state) && !expired) {
        return { outcome: "in_progress" };
      }
      if (!TERMINAL_STATES.has(existing.state) && expired) {
        // Same-request retry after expiry: reconcile the dead attempt now
        // (charge if provider-risk, release if reserved) and persist it.
        await applySweepForIds(tx, d.store, period, id, [reservationId], nowMs);
      }
      return { outcome: "already_processed" };
    }

    // Current limit INSIDE the transaction (race-safe vs admin edits).
    const limit = await monthlyLimits.resolveEffectiveMonthlyLimitInTransaction(
      tx,
      { uid: id, schoolId: school, role: cleanRole, accountType: policyAccountType },
      { store: d.store }
    );
    if (!limit || limit.configured !== true) throw coded("monthly limit not configured", "MONTHLY_LIMIT_NOT_CONFIGURED");
    const allowance = limit.monthlyTokenLimit;
    if (allowance === 0) throw coded("monthly limit exceeded", "MONTHLY_LIMIT_EXCEEDED");

    // Canonical user state + stale sweep.
    const uSnap = await tx.get(userRef(d.store, period, id));
    const uData = uSnap.exists ? uSnap.data() || {} : {};
    const sweep = await applySweep(tx, d.store, period, id, uData, nowMs);
    const settledBase = {
      inputTokens: num(uData.inputTokens),
      outputTokens: num(uData.outputTokens),
      conservativeChargedTokens: sweep.userBase.conservativeChargedTokens,
      requests: sweep.userBase.requests,
    };
    const used = committedUsed(settledBase);
    const active = activeReservedTotal(sweep.live);
    if (Object.keys(sweep.live).length >= MAX_ACTIVE_RESERVATIONS) {
      throw coded("too many active requests", "TOO_MANY_ACTIVE_REQUESTS");
    }
    const available = allowance - used - active;
    if (available <= inUpper) throw coded("monthly limit exceeded", "MONTHLY_LIMIT_EXCEEDED");
    const availableForOutput = available - inUpper;
    if (availableForOutput < MIN_OUTPUT_TOKENS) throw coded("monthly limit exceeded", "MONTHLY_LIMIT_EXCEEDED");
    const maxOutput = Math.min(defMax, availableForOutput);
    const reserved = inUpper + maxOutput;

    const expiresAt = nowMs + RESERVATION_TTL_SECONDS * 1000;
    const entry = {
      amount: reserved,
      state: "reserved",
      expiresAt,
      modelKey: key,
      schoolId: school,
      role: cleanRole,
      accountType: cleanAccountType,
    };
    tx.set(
      reservationRef(d.store, period, reservationId),
      {
        schemaVersion: 1,
        reservationId,
        uid: id,
        period,
        requestId: rid,
        modelKey: key,
        schoolId: school,
        role: cleanRole,
        accountType: cleanAccountType,
        inputUpperBound: inUpper,
        maxOutputTokens: maxOutput,
        reservedTokens: reserved,
        state: "reserved",
        createdAt: now,
        startedAt: null,
        expiresAt,
        completedAt: null,
        actualInputTokens: null,
        actualOutputTokens: null,
        conservativeChargedTokens: 0,
        finalReason: null,
      }
    );
    tx.set(userRef(d.store, period, id), {
      schemaVersion: 1,
      uid: id,
      period,
      inputTokens: num(uData.inputTokens),
      outputTokens: num(uData.outputTokens),
      conservativeChargedTokens: settledBase.conservativeChargedTokens,
      requests: settledBase.requests,
      // Phase 9B.2M: swept (expired) entries get explicit nested deletes —
      // merge:true would otherwise preserve them as fossils.
      activeReservations: withPrunedEntries({ ...sweep.live, [reservationId]: entry }, sweep.expiredIds),
      byModel: sweep.userBase.byModel,
      lastKnownSchoolId: school,
      lastKnownAccountType: cleanAccountType,
      lastKnownRole: cleanRole,
      ...(uSnap.exists ? {} : { createdAt: now }),
      updatedAt: now,
    }, { merge: true });
    return {
      outcome: "reserved",
      reservation: {
        reservationId,
        reservedTokens: reserved,
        inputUpperBound: inUpper,
        maxOutputTokens: maxOutput,
        period,
        monthlyTokenLimit: allowance,
      },
    };
  });
  if (outcome.outcome === "in_progress") {
    throw coded("request already in progress", "REQUEST_IN_PROGRESS");
  }
  if (outcome.outcome === "already_processed") {
    throw coded("request already processed", "REQUEST_ALREADY_PROCESSED");
  }
  return outcome.reservation;
}

// Finalize specific reservation IDs through the stale path (used when a
// same-requestId retry meets an expired non-terminal doc). Aggregated into
// single user/school writes (same snapshot rule as applySweep).
async function applySweepForIds(tx, store, period, uid, ids, nowMs) {
  const uSnap = await tx.get(userRef(store, period, uid));
  const uData = uSnap.exists ? uSnap.data() || {} : {};
  const activeMap = (uData.activeReservations && typeof uData.activeReservations === "object")
    ? { ...uData.activeReservations }
    : {};
  for (const rid of ids) delete activeMap[rid];
  let userConservative = num(uData.conservativeChargedTokens);
  let userRequests = num(uData.requests);
  const userByModel = (uData.byModel && typeof uData.byModel === "object") ? { ...uData.byModel } : {};
  const schoolAggs = new Map();
  // Phase 9B.2J: reads-first pass over every id, then the write pass.
  // Skipped (terminal/unreadable) docs behave exactly as before.
  // Candidate school docs are collected from the reads so all school
  // reads also precede every write.
  const sweepReads = [];
  const sweepSchoolIds = new Set();
  for (const rid of ids) {
    let doc = null;
    let readable = true;
    try {
      const snap = await tx.get(reservationRef(store, period, rid));
      if (snap.exists) doc = snap.data() || {};
    } catch (_) {
      readable = false;
    }
    if (readable && doc && typeof doc.schoolId === "string" && doc.schoolId) {
      sweepSchoolIds.add(doc.schoolId);
    }
    sweepReads.push({ rid, doc, readable });
  }
  const sweepSchoolReads = new Map();
  for (const schoolId of sweepSchoolIds) {
    let sData = {};
    try {
      const snap = await tx.get(schoolRef(store, period, schoolId));
      if (snap.exists) sData = snap.data() || {};
    } catch (_) {
      sData = {};
    }
    sweepSchoolReads.set(schoolId, sData);
  }
  for (const { rid, doc, readable } of sweepReads) {
    if (!readable || !doc || TERMINAL_STATES.has(doc.state)) continue;
    const amount = num(doc.reservedTokens);
    const modelKey = typeof doc.modelKey === "string" ? doc.modelKey : null;
    const schoolId = typeof doc.schoolId === "string" && doc.schoolId ? doc.schoolId : null;
    const role = doc.role === "student" || doc.role === "teacher" ? doc.role : null;
    if (isProviderRisk(doc.state)) {
      userConservative += amount;
      userRequests += 1;
      if (modelKey && Object.keys(userByModel).length < MAX_MODELKEYS_PER_USER_MONTH + 1) {
        const prev = userByModel[modelKey] || {};
        userByModel[modelKey] = {
          inputTokens: num(prev.inputTokens),
          outputTokens: num(prev.outputTokens),
          conservativeChargedTokens: num(prev.conservativeChargedTokens) + amount,
          requests: num(prev.requests) + 1,
        };
      }
      if (schoolId) {
        if (!schoolAggs.has(schoolId)) schoolAggs.set(schoolId, { conservative: 0, requests: 0, byRole: {}, byModel: {} });
        const agg = schoolAggs.get(schoolId);
        agg.conservative += amount;
        agg.requests += 1;
        if (role) agg.byRole[role] = (agg.byRole[role] || 0) + amount;
        if (modelKey) agg.byModel[modelKey] = (agg.byModel[modelKey] || 0) + amount;
      }
    }
    tx.set(reservationRef(store, period, rid), {
      ...doc,
      state: "expired",
      ...(isProviderRisk(doc.state)
        ? { conservativeChargedTokens: amount, finalReason: "retry-after-expiry-charged" }
        : { finalReason: "retry-after-expiry-released" }),
      completedAt: new Date(),
    });
  }
  tx.set(userRef(store, period, uid), {
    schemaVersion: 1,
    uid,
    period,
    inputTokens: num(uData.inputTokens),
    outputTokens: num(uData.outputTokens),
    conservativeChargedTokens: userConservative,
    requests: userRequests,
    // Phase 9B.2M: swept ids get explicit nested deletes (merge:true would
    // otherwise preserve them as fossils).
    activeReservations: withPrunedEntries(activeMap, ids),
    byModel: userByModel,
    lastKnownSchoolId: uData.lastKnownSchoolId || null,
    lastKnownAccountType: normalizeAccountType(uData.lastKnownAccountType),
    lastKnownRole: uData.lastKnownRole || null,
    ...(uSnap.exists ? {} : { createdAt: new Date() }),
    updatedAt: new Date(),
  }, { merge: true });
  // School writes consume the pre-read snapshots (see above) — no reads
  // here, so nothing follows the user write above.
  for (const [schoolId, agg] of schoolAggs) {
    const ref = schoolRef(store, period, schoolId);
    const sData = sweepSchoolReads.get(schoolId) || {};
    const sByModel = (sData.byModel && typeof sData.byModel === "object") ? { ...sData.byModel } : {};
    for (const [mk, amt] of Object.entries(agg.byModel)) {
      const prev = sByModel[mk] || {};
      sByModel[mk] = {
        inputTokens: num(prev.inputTokens),
        outputTokens: num(prev.outputTokens),
        conservativeChargedTokens: num(prev.conservativeChargedTokens) + amt,
        requests: num(prev.requests) + agg.requests,
      };
    }
    tx.set(ref, {
      schoolId,
      month: period,
      inputTokens: num(sData.inputTokens),
      outputTokens: num(sData.outputTokens),
      conservativeChargedTokens: num(sData.conservativeChargedTokens) + agg.conservative,
      requests: num(sData.requests) + agg.requests,
      byRole: sData.byRole && typeof sData.byRole === "object" ? sData.byRole : {},
      byModel: sByModel,
      updatedAt: new Date(),
    }, { merge: true });
  }
  void nowMs;
}

// ---------- Mark dispatched (upstream HTTP about to leave / left process) ----------
// Must succeed BEFORE the provider fetch is issued. Establishes the durable
// provider-risk boundary: from here on, unknown outcomes charge, never
// release. No counters change; school analytics untouched.
async function markDispatched({ reservationId, period, uid, schoolId, role }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  // Phase 9B.2I: fixed-vocabulary diagnostic of how far dispatch got.
  // Attached best-effort to the SAME thrown error object on failure and
  // rethrown unchanged — no effect on codes, flow, or accounting.
  let dispatchPhase = "pre_transaction";
  const markErrorPhase = (err) => {
    try {
      if (
        err !== null &&
        (typeof err === "object" || typeof err === "function") &&
        typeof err.dispatchPhase !== "string"
      ) {
        err.dispatchPhase = dispatchPhase;
      }
    } catch (_) {
      // Marker assignment must never break the failure path.
    }
    throw err;
  };
  if (typeof reservationId !== "string" || !reservationId) {
    try {
      invalidRequest("missing reservationId");
    } catch (err) {
      markErrorPhase(err);
    }
  }
  const m = period === undefined ? currentMonthIST() : String(period);
  let result;
  try {
    result = await d.store.runTransaction(async (tx) => {
      dispatchPhase = "transaction_entered";
      const ref = reservationRef(d.store, m, reservationId);
      const snap = await tx.get(ref);
      dispatchPhase = "reservation_read";
    if (!snap.exists) {
      const err = new Error("unknown reservation");
      err.code = "INTERNAL";
      err.isSubiDomainError = true;
      throw err;
    }
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) throw coded("request already processed", "REQUEST_ALREADY_PROCESSED");
    // Owner binding checked BEFORE idempotent short-circuits: the doc ID
    // already binds (uid, requestId), so a mismatch is caller confusion and
    // must fail fast rather than silently succeed.
    if ((uid !== undefined && String(uid) !== String(doc.uid || "")) ||
        (schoolId !== undefined && String(schoolId) !== String(doc.schoolId || "")) ||
        (role !== undefined && String(role).trim().toLowerCase() !== String(doc.role || ""))) {
      invalidRequest("reservation owner mismatch");
    }
    if (doc.state === "dispatched" || doc.state === "started") {
      return { reservationId, state: doc.state }; // idempotent: risk already durable
    }
    if (doc.state !== "reserved") {
      const err = new Error("invalid reservation state");
      err.code = "INTERNAL";
      err.isSubiDomainError = true;
      throw err;
    }
    // Phase 9B.2J: ALL reads before ANY write (Firestore rule). The user
    // usage read is hoisted above the reservation write; validation and
    // write contents are unchanged.
    const uSnap = await tx.get(userRef(d.store, m, doc.uid));
    dispatchPhase = "user_read";
    const uData = uSnap.exists ? uSnap.data() || {} : {};
    const activeMap = (uData.activeReservations && typeof uData.activeReservations === "object")
      ? { ...uData.activeReservations }
      : {};
    const now = new Date();
    tx.set(ref, { ...doc, state: "dispatched", dispatchedAt: now });
    if (activeMap[reservationId]) {
      activeMap[reservationId] = { ...activeMap[reservationId], state: "dispatched" };
      tx.set(userRef(d.store, m, doc.uid), { activeReservations: activeMap, updatedAt: now }, { merge: true });
    }
    dispatchPhase = "writes_queued";
    return { reservationId, state: "dispatched" };
    });
  } catch (err) {
    markErrorPhase(err);
  }
  return result;
}

// ---------- Mark started (provider accepted, 2xx, before body) ----------
async function markStarted({ reservationId, period }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof reservationId !== "string" || !reservationId) invalidRequest("missing reservationId");
  const m = period === undefined ? currentMonthIST() : String(period);
  return d.store.runTransaction(async (tx) => {
    const ref = reservationRef(d.store, m, reservationId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error("unknown reservation");
      err.code = "INTERNAL";
      throw err;
    }
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) throw coded("request already processed", "REQUEST_ALREADY_PROCESSED");
    if (doc.state === "started") return { reservationId, state: "started" };
    if (doc.state !== "reserved" && doc.state !== "dispatched") {
      const err = new Error("invalid reservation state");
      err.code = "INTERNAL";
      throw err;
    }
    // Phase 9B.2J: ALL reads before ANY write (Firestore rule). The user
    // usage read is hoisted above the reservation write; validation and
    // write contents are unchanged.
    const uSnap = await tx.get(userRef(d.store, m, doc.uid));
    const uData = uSnap.exists ? uSnap.data() || {} : {};
    const activeMap = (uData.activeReservations && typeof uData.activeReservations === "object")
      ? { ...uData.activeReservations }
      : {};
    const now = new Date();
    tx.set(ref, { ...doc, state: "started", startedAt: now });
    if (activeMap[reservationId]) {
      activeMap[reservationId] = { ...activeMap[reservationId], state: "started" };
      tx.set(userRef(d.store, m, doc.uid), { activeReservations: activeMap, updatedAt: now }, { merge: true });
    }
    return { reservationId, state: "started" };
  });
}

// ---------- Definite provider rejection after dispatch (zero charge) ----------
// For unambiguous rejections (401/403/429-class: no inference stream was
// accepted). Terminalizes as failed WITHOUT touching usage/request/school
// analytics. If this write itself cannot persist, the durable DISPATCHED
// record stays and stale recovery charges conservatively later —
// overcharge-on-outage is the accepted fail-closed direction.
async function failDispatched({ reservationId, period }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof reservationId !== "string" || !reservationId) invalidRequest("missing reservationId");
  const m = period === undefined ? currentMonthIST() : String(period);
  return d.store.runTransaction(async (tx) => {
    const ref = reservationRef(d.store, m, reservationId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { reservationId, released: true, charged: 0 };
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) return { reservationId, released: true, charged: 0 };
    if (doc.state === "started") {
      const err = new Error("invalid reservation state");
      err.code = "INTERNAL";
      throw err;
    }
    // Phase 9B.2J: the active-entry drop (which reads the user doc) runs
    // BEFORE the reservation write so no read follows a write. Same reads,
    // same writes, same conditions — only ordering changes.
    const now = new Date();
    await dropActiveEntry(tx, d.store, m, doc.uid, reservationId, now);
    tx.set(ref, { ...doc, state: "failed", finalReason: "provider-rejected", completedAt: now });
    return { reservationId, released: true, charged: 0, state: "failed" };
  });
}

// ---------- Commit (exact actuals; truthful even over reservation) ----------
async function commitUsage({ reservationId, period, actualInputTokens, actualOutputTokens, finalState = "completed" }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof reservationId !== "string" || !reservationId) invalidRequest("missing reservationId");
  if (!["completed", "failed", "cancelled"].includes(finalState)) invalidRequest("invalid final state");
  const inT = cleanNonNegativeInt(actualInputTokens, "actualInputTokens");
  const outT = cleanNonNegativeInt(actualOutputTokens, "actualOutputTokens");
  const m = period === undefined ? currentMonthIST() : String(period);
  return d.store.runTransaction(async (tx) => {
    const ref = reservationRef(d.store, m, reservationId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error("unknown reservation");
      err.code = "INTERNAL";
      throw err;
    }
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) {
      return { reservationId, alreadyTerminal: true, state: doc.state, committed: 0 };
    }
    const now = new Date();
    const uid = String(doc.uid || "");
    const schoolId = String(doc.schoolId || "");
    const role = String(doc.role || "");
    const accountType = normalizeAccountType(doc.accountType);
    const modelKey = String(doc.modelKey || "");
    const actualTotal = inT + outT;

    const uRef = userRef(d.store, m, uid);
    const uSnap = await tx.get(uRef);
    const uData = uSnap.exists ? uSnap.data() || {} : {};
    const activeMap = (uData.activeReservations && typeof uData.activeReservations === "object")
      ? { ...uData.activeReservations }
      : {};
    delete activeMap[reservationId];
    const byModel = (uData.byModel && typeof uData.byModel === "object") ? { ...uData.byModel } : {};
    if (modelKey && Object.keys(byModel).length < MAX_MODELKEYS_PER_USER_MONTH + 1) {
      const prev = byModel[modelKey] || {};
      byModel[modelKey] = {
        inputTokens: num(prev.inputTokens) + inT,
        outputTokens: num(prev.outputTokens) + outT,
        conservativeChargedTokens: num(prev.conservativeChargedTokens),
        requests: num(prev.requests) + 1,
      };
    }
    // Phase 9B.2J: school read hoisted above ALL writes (Firestore
    // reads-before-writes rule). Values/conditions below are unchanged.
    let sRef = null;
    let sData = {};
    if (schoolId) {
      sRef = schoolRef(d.store, m, schoolId);
      try {
        const sSnap = await tx.get(sRef);
        if (sSnap.exists) sData = sSnap.data() || {};
      } catch (_) {
        sData = {};
      }
    }
    tx.set(uRef, {
      schemaVersion: 1,
      uid,
      period: m,
      inputTokens: num(uData.inputTokens) + inT,
      outputTokens: num(uData.outputTokens) + outT,
      conservativeChargedTokens: num(uData.conservativeChargedTokens),
      requests: num(uData.requests) + 1,
      // Phase 9B.2M: explicit nested delete — merge:true would otherwise
      // preserve the terminal entry as a fossil.
      activeReservations: withPrunedEntries(activeMap, [reservationId]),
      byModel,
      lastKnownSchoolId: schoolId || uData.lastKnownSchoolId || null,
      lastKnownAccountType: accountType,
      lastKnownRole: role || uData.lastKnownRole || null,
      ...(uSnap.exists ? {} : { createdAt: now }),
      updatedAt: now,
    }, { merge: true });

    // School analytics (request-time school): exactly-once with commit.
    // Phase 9B.2J: the school read below was hoisted above (before the
    // user write); see sData/sRef captured earlier. Values unchanged.
    if (schoolId && sRef) {
      const sByRole = (sData.byRole && typeof sData.byRole === "object") ? { ...sData.byRole } : {};
      const sByModel = (sData.byModel && typeof sData.byModel === "object") ? { ...sData.byModel } : {};
      if (role === "student" || role === "teacher") {
        const prev = sByRole[role] || {};
        sByRole[role] = {
          inputTokens: num(prev.inputTokens) + inT,
          outputTokens: num(prev.outputTokens) + outT,
          conservativeChargedTokens: num(prev.conservativeChargedTokens),
          requests: num(prev.requests) + 1,
        };
      }
      if (modelKey && Object.keys(sByModel).length < MAX_MODELKEYS_PER_USER_MONTH + 1) {
        const prev = sByModel[modelKey] || {};
        sByModel[modelKey] = {
          inputTokens: num(prev.inputTokens) + inT,
          outputTokens: num(prev.outputTokens) + outT,
          conservativeChargedTokens: num(prev.conservativeChargedTokens),
          requests: num(prev.requests) + 1,
        };
      }
      tx.set(sRef, {
        schoolId,
        month: m,
        inputTokens: num(sData.inputTokens) + inT,
        outputTokens: num(sData.outputTokens) + outT,
        conservativeChargedTokens: num(sData.conservativeChargedTokens),
        requests: num(sData.requests) + 1,
        byRole: sByRole,
        byModel: sByModel,
        updatedAt: now,
      }, { merge: true });
    }

    tx.set(ref, {
      ...doc,
      state: finalState,
      actualInputTokens: inT,
      actualOutputTokens: outT,
      completedAt: now,
      finalReason: finalState === "completed" ? "committed-actual" : `committed-actual-${finalState}`,
    });
    return {
      reservationId,
      alreadyTerminal: false,
      state: finalState,
      committed: actualTotal,
      overReservation: actualTotal > num(doc.reservedTokens),
    };
  });
}

// ---------- Pre-start release (provider never dispatched: zero charge) ----------
// Valid ONLY for RESERVED (no upstream HTTP left the process). Provider-risk
// states (dispatched/started) reaching here indicate caller confusion —
// charge conservatively instead of releasing. Never silent zero-release.
async function failBeforeStart({ reservationId, period }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof reservationId !== "string" || !reservationId) invalidRequest("missing reservationId");
  const m = period === undefined ? currentMonthIST() : String(period);
  return d.store.runTransaction(async (tx) => {
    const ref = reservationRef(d.store, m, reservationId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { reservationId, released: true, charged: 0 };
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) return { reservationId, released: true, charged: 0 };
    if (isProviderRisk(doc.state)) {
      // Wrong-path guard with fail-safe direction: a provider-risk
      // reservation is never silently released — charge conservatively.
      return finalizeUnknown(tx, d.store, m, ref, doc);
    }
    // Phase 9B.2J: drop runs before the reservation write (reads first).
    const now = new Date();
    await dropActiveEntry(tx, d.store, m, doc.uid, reservationId, now);
    tx.set(ref, { ...doc, state: "failed", finalReason: "pre-start-release", completedAt: now });
    return { reservationId, released: true, charged: 0 };
  });
}

// ---------- Unknown post-start usage: conservative full charge ----------
async function finalizeStartedUnknownUsage({ reservationId, period, finalState = "failed" }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof reservationId !== "string" || !reservationId) invalidRequest("missing reservationId");
  if (!["failed", "cancelled", "expired"].includes(finalState)) invalidRequest("invalid final state");
  const m = period === undefined ? currentMonthIST() : String(period);
  return d.store.runTransaction(async (tx) => {
    const ref = reservationRef(d.store, m, reservationId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { reservationId, charged: 0, alreadyTerminal: true };
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) return { reservationId, charged: 0, alreadyTerminal: true };
    return finalizeUnknown(tx, d.store, m, ref, doc, finalState);
  });
}

// ---------- Accepted-but-unrecoverable: conservative full charge ----------
// SERVER-INTERNAL ONLY. Called when the provider is known (2xx observed by
// this process) to have possibly started inference, but exact usage cannot
// be recovered AND the normal started-state write path is unavailable
// (e.g. markStarted persistence failed). Works from ANY non-terminal state
// — including still-"reserved" — because provider acceptance is passed
// explicitly by trusted server code, never by clients. Exactly once:
// terminal docs are no-ops.
async function finalizeAcceptedUnknownUsage({ reservationId, period, finalState = "failed" }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof reservationId !== "string" || !reservationId) invalidRequest("missing reservationId");
  if (!["failed", "cancelled"].includes(finalState)) invalidRequest("invalid final state");
  const m = period === undefined ? currentMonthIST() : String(period);
  return d.store.runTransaction(async (tx) => {
    const ref = reservationRef(d.store, m, reservationId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { reservationId, charged: 0, alreadyTerminal: true };
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) return { reservationId, charged: 0, alreadyTerminal: true };
    // Trusted server assertion: provider acceptance was observed in-process
    // (2xx). Persisted on the terminal record for audit clarity.
    return finalizeUnknown(tx, d.store, m, ref, { ...doc, providerAccepted: true }, finalState, "accepted-unknown");
  });
}

async function finalizeUnknown(tx, store, period, ref, doc, finalState = "failed", reasonPrefix = "unknown-usage-charged") {
  const now = new Date();
  const rid = String((doc && doc.reservationId) || "");
  if (!rid) {
    const err = new Error("corrupt reservation record");
    err.code = "INTERNAL";
    throw err;
  }
  const amount = num(doc.reservedTokens);
  const uid = String(doc.uid || "");
  const schoolId = String(doc.schoolId || "");
  const role = String(doc.role || "");
  const accountType = normalizeAccountType(doc.accountType);
  const modelKey = String(doc.modelKey || "");
  if (uid) {
    const uRef = userRef(store, period, uid);
    let uData = {};
    try {
      const uSnap = await tx.get(uRef);
      if (uSnap.exists) uData = uSnap.data() || {};
    } catch (_) {
      uData = {};
    }
    const activeMap = (uData.activeReservations && typeof uData.activeReservations === "object")
      ? { ...uData.activeReservations }
      : {};
    delete activeMap[rid];
    const byModel = (uData.byModel && typeof uData.byModel === "object") ? { ...uData.byModel } : {};
    if (modelKey && Object.keys(byModel).length < MAX_MODELKEYS_PER_USER_MONTH + 1) {
      const prev = byModel[modelKey] || {};
      byModel[modelKey] = {
        inputTokens: num(prev.inputTokens),
        outputTokens: num(prev.outputTokens),
        conservativeChargedTokens: num(prev.conservativeChargedTokens) + amount,
        requests: num(prev.requests) + 1,
      };
    }
    // Phase 9B.2J: school read hoisted above ALL writes (Firestore
    // reads-before-writes rule). Values/conditions below are unchanged.
    let sRefForSchool = null;
    let sData = {};
    if (schoolId) {
      sRefForSchool = schoolRef(store, period, schoolId);
      try {
        const sSnap = await tx.get(sRefForSchool);
        if (sSnap.exists) sData = sSnap.data() || {};
      } catch (_) {
        sData = {};
      }
    }
    tx.set(uRef, {
      schemaVersion: 1,
      uid,
      period,
      inputTokens: num(uData.inputTokens),
      outputTokens: num(uData.outputTokens),
      conservativeChargedTokens: num(uData.conservativeChargedTokens) + amount,
      requests: num(uData.requests) + 1,
      // Phase 9B.2M: explicit nested delete (see commitUsage note).
      activeReservations: withPrunedEntries(activeMap, [rid]),
      byModel,
      lastKnownSchoolId: schoolId || uData.lastKnownSchoolId || null,
      lastKnownAccountType: accountType,
      lastKnownRole: role || uData.lastKnownRole || null,
      updatedAt: now,
    }, { merge: true });
    // Phase 9B.2J: school read hoisted above (before the user write); the
    // hoisted sRefForSchool/sData below replace the inline read. Values
    // and conditions are unchanged.
    if (schoolId && sRefForSchool) {
      const sByModel = (sData.byModel && typeof sData.byModel === "object") ? { ...sData.byModel } : {};
      if (modelKey) {
        const prev = sByModel[modelKey] || {};
        sByModel[modelKey] = {
          inputTokens: num(prev.inputTokens),
          outputTokens: num(prev.outputTokens),
          conservativeChargedTokens: num(prev.conservativeChargedTokens) + amount,
          requests: num(prev.requests) + 1,
        };
      }
      tx.set(sRefForSchool, {
        schoolId,
        month: period,
        inputTokens: num(sData.inputTokens),
        outputTokens: num(sData.outputTokens),
        conservativeChargedTokens: num(sData.conservativeChargedTokens) + amount,
        requests: num(sData.requests) + 1,
        byRole: sData.byRole && typeof sData.byRole === "object" ? sData.byRole : {},
        byModel: sByModel,
        updatedAt: now,
      }, { merge: true });
    }
  }
  tx.set(ref, {
    ...doc,
    state: finalState,
    conservativeChargedTokens: amount,
    ...(doc.providerAccepted === true ? { providerAccepted: true } : {}),
    finalReason: `${reasonPrefix}-${finalState}`,
    completedAt: now,
  });
  return { reservationId: String(doc.reservationId || ""), charged: amount, alreadyTerminal: false, state: finalState };
}

async function dropActiveEntry(tx, store, period, uid, reservationId, now) {
  if (!uid) return;
  let uData = {};
  try {
    const uSnap = await tx.get(userRef(store, period, uid));
    if (uSnap.exists) uData = uSnap.data() || {};
  } catch (_) {
    return;
  }
  const activeMap = (uData.activeReservations && typeof uData.activeReservations === "object")
    ? { ...uData.activeReservations }
    : {};
  if (!activeMap[reservationId]) return;
  delete activeMap[reservationId];
  // Phase 9B.2M: explicit nested delete — merge:true deep-merges, so the
  // in-memory delete alone would leave a fossil entry counting live risk.
  tx.set(userRef(store, period, uid), { activeReservations: withPrunedEntries(activeMap, [reservationId]), updatedAt: now || new Date() }, { merge: true });
}

// ---------- Cancel dispatcher: reserved→release, started→conservative ----------
async function cancelUsage({ reservationId, period, actualInputTokens, actualOutputTokens }, deps) {
  const hasActual = actualInputTokens !== undefined || actualOutputTokens !== undefined;
  if (hasActual) {
    return commitUsage({
      reservationId,
      period,
      actualInputTokens: actualInputTokens === undefined ? 0 : actualInputTokens,
      actualOutputTokens: actualOutputTokens === undefined ? 0 : actualOutputTokens,
      finalState: "cancelled",
    }, deps);
  }
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof reservationId !== "string" || !reservationId) invalidRequest("missing reservationId");
  const m = period === undefined ? currentMonthIST() : String(period);
  return d.store.runTransaction(async (tx) => {
    const ref = reservationRef(d.store, m, reservationId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { reservationId, charged: 0, alreadyTerminal: true };
    const doc = snap.data() || {};
    if (TERMINAL_STATES.has(doc.state)) return { reservationId, charged: 0, alreadyTerminal: true };
    if (isProviderRisk(doc.state)) {
      return finalizeUnknown(tx, d.store, m, ref, doc, "cancelled");
    }
    // Phase 9B.2J: drop runs before the reservation write (reads first).
    const now = new Date();
    await dropActiveEntry(tx, d.store, m, doc.uid, reservationId, now);
    tx.set(ref, { ...doc, state: "cancelled", finalReason: "cancel-before-start", completedAt: now });
    return { reservationId, released: true, charged: 0, state: "cancelled" };
  });
}

// ---------- Managed usage view (read-only; effective, never mutating) ----------
async function getManagedUsage({ uid, schoolId, role, accountType }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const school = cleanId(schoolId);
  const cleanRole = String(role || "").trim().toLowerCase();
  const cleanAccountType = normalizeAccountType(accountType);
  const policyAccountType = accountType === undefined ? undefined : cleanAccountType;
  if (!id || !school || (cleanRole !== "student" && cleanRole !== "teacher")) {
    const err = new Error("invalid usage identity");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const period = currentMonthIST();
  const limit = await monthlyLimits.resolveEffectiveMonthlyLimit(
    { uid: id, schoolId: school, role: cleanRole, accountType: policyAccountType },
    { store: d.store }
  );
  let uData = null;
  try {
    const snap = await userRef(d.store, period, id).get();
    if (snap.exists) uData = snap.data() || {};
  } catch (_) {
    uData = null;
  }
  const nowMs = Date.now();
  const activeMap = (uData && uData.activeReservations && typeof uData.activeReservations === "object")
    ? uData.activeReservations
    : {};
  let effectiveExtraUsed = 0;
  let effectiveActive = 0;
  for (const e of Object.values(activeMap)) {
    if (!e || typeof e !== "object" || !ACTIVE_STATES.has(e.state)) continue;
    const expired = typeof e.expiresAt === "number" && e.expiresAt <= nowMs;
    // Expired provider-risk entries count as conservatively used; expired
    // RESERVED entries are ignored (releasable). Never overstates remaining.
    if (expired && isProviderRisk(e.state)) effectiveExtraUsed += num(e.amount);
    else if (!expired) effectiveActive += num(e.amount);
  }
  const usedTokens =
    num(uData && uData.inputTokens) + num(uData && uData.outputTokens) +
    num(uData && uData.conservativeChargedTokens) + effectiveExtraUsed;
  if (!limit || limit.configured !== true) {
    return { configured: false, period, monthlyTokenLimit: null, usedTokens, remainingTokens: null };
  }
  return {
    configured: true,
    period,
    monthlyTokenLimit: limit.monthlyTokenLimit,
    usedTokens,
    remainingTokens: Math.max(0, limit.monthlyTokenLimit - usedTokens - effectiveActive),
  };
}

module.exports = {
  RESERVATION_TTL_SECONDS,
  MAX_ACTIVE_RESERVATIONS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  PER_MESSAGE_OVERHEAD_TOKENS,
  REQUEST_OVERHEAD_TOKENS,
  MAX_MODELKEYS_PER_USER_MONTH,
  PROVIDER_RISK_STATES,
  estimateInputUpperBound,
  reservationIdFor,
  classifyFinalization,
  reserveUsage,
  markDispatched,
  markStarted,
  failDispatched,
  commitUsage,
  failBeforeStart,
  finalizeStartedUnknownUsage,
  finalizeAcceptedUnknownUsage,
  cancelUsage,
  getManagedUsage,
  currentMonthIST,
};
