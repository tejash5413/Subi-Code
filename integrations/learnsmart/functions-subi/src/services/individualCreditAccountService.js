// functions-subi/src/services/individualCreditAccountService.js
// Phase 2 — individual ONLY wallet + immutable ledger.
// Schools NEVER create/read these docs (quotaMode routes them to tokens).
//
// Collection: creditAccounts/{uid}
//   { uid, cycleId, cycleStartedAtMs, cycleEndsAtMs,
//     monthlyGrantCreditsMilli, monthlyRemainingCreditsMilli,
//     rolloverGrantedCreditsMilli, rolloverRemainingCreditsMilli, rolloverExpiresAtMs,
//     topupRemainingCreditsMilli, reservedCreditsMilli,
//     fxSnapshot, economicsSnapshot, subscriptionActive, updatedAtMs }
// Ledger: creditAccounts/{uid}/ledger/{entryId}
//   { type, amountMilli, balanceAfterMilli, cycleId, reason, requestId?, priceVersion?, createdAtMs }
//
// BOUNDARY: uses ONLY subiDb. Never learnsmartDb. DI supports fakes.
// All mutations via runTransaction; ledger entries immutable (no updates).

const { subiDb } = require("../db");

const COLLECTION = "creditAccounts";
const LEDGER = "ledger";

function defaultDeps() {
  return { store: subiDb };
}

function cleanId(v, max = 128) {
  return String(v || "").trim().slice(0, max);
}

function invalidRequest(msg) {
  const err = new Error(msg || "invalid credit account payload");
  err.code = "INVALID_REQUEST";
  return err;
}

function num(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function emptyAccount(uid, cycle) {
  return {
    uid,
    cycleId: (cycle && cycle.cycleId) || null,
    cycleStartedAtMs: (cycle && cycle.cycleStartedAtMs) || null,
    cycleEndsAtMs: (cycle && cycle.cycleEndsAtMs) || null,
    monthlyGrantCreditsMilli: 0,
    monthlyRemainingCreditsMilli: 0,
    rolloverGrantedCreditsMilli: 0,
    rolloverRemainingCreditsMilli: 0,
    rolloverExpiresAtMs: null,
    topupRemainingCreditsMilli: 0,
    reservedCreditsMilli: 0,
    fxSnapshot: null,
    economicsSnapshot: null,
    subscriptionActive: false,
    updatedAtMs: Date.now(),
  };
}

function toSafeAccount(uid, data) {
  const d = (data && typeof data === "object") ? data : {};
  const rawActive = d.activeReservations && typeof d.activeReservations === "object" && !Array.isArray(d.activeReservations)
    ? d.activeReservations : {};
  const activeReservations = {};
  for (const [k, v] of Object.entries(rawActive)) {
    if (v && typeof v === "object") activeReservations[String(k).slice(0, 128)] = v;
  }
  return {
    uid,
    cycleId: typeof d.cycleId === "string" ? d.cycleId : null,
    cycleStartedAtMs: typeof d.cycleStartedAtMs === "number" ? d.cycleStartedAtMs : null,
    cycleEndsAtMs: typeof d.cycleEndsAtMs === "number" ? d.cycleEndsAtMs : null,
    monthlyGrantCreditsMilli: num(d.monthlyGrantCreditsMilli),
    monthlyRemainingCreditsMilli: num(d.monthlyRemainingCreditsMilli),
    rolloverGrantedCreditsMilli: num(d.rolloverGrantedCreditsMilli),
    rolloverRemainingCreditsMilli: num(d.rolloverRemainingCreditsMilli),
    rolloverExpiresAtMs: typeof d.rolloverExpiresAtMs === "number" ? d.rolloverExpiresAtMs : null,
    topupRemainingCreditsMilli: num(d.topupRemainingCreditsMilli),
    reservedCreditsMilli: num(d.reservedCreditsMilli),
    // Bounded live-reservation index for MAX_ACTIVE + TTL sweep. Terminal
    // entries are pruned (never fossils); the ledger docs stay authoritative.
    activeReservations,
    fxSnapshot: d.fxSnapshot && typeof d.fxSnapshot === "object" ? d.fxSnapshot : null,
    economicsSnapshot: d.economicsSnapshot && typeof d.economicsSnapshot === "object" ? d.economicsSnapshot : null,
    subscriptionActive: d.subscriptionActive === true,
    updatedAtMs: typeof d.updatedAtMs === "number" ? d.updatedAtMs : null,
  };
}

function totalAvailableMilli(acct) {
  return (
    num(acct.monthlyRemainingCreditsMilli) +
    num(acct.rolloverRemainingCreditsMilli) +
    num(acct.topupRemainingCreditsMilli)
  );
}

async function getCreditAccount(uid, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const snap = await store.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  return toSafeAccount(id, snap.data() || {});
}

// REMOVED (cutover hardening): the superseded ensureCycleGrant implementation
// lived here (non-deterministic `grant-${cid}-${nowMs}` ledger IDs, hardcoded
// 0.8 rollover, caller-supplied dates). Zero production/test callers existed.
// The single authoritative grant path is now
// individualCreditCycleService.ensureCurrentCreditCycle (deterministic
// `grant-${cycleId}` ledger IDs, paid-period-bound cycleId, configured
// rolloverPct). Do not reintroduce a second grant implementation.

async function listLedger({ uid, limit = 20 }, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const snap = await store.collection(COLLECTION).doc(id).collection(LEDGER).orderBy('createdAtMs', 'desc').limit(Math.min(Math.max(Number(limit) || 20, 1), 50)).get();
  return (snap.docs || []).map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

module.exports = {
  COLLECTION,
  LEDGER,
  totalAvailableMilli,
  toSafeAccount,
  emptyAccount,
  getCreditAccount,
  listLedger,
};
