// functions-subi/src/services/individualCreditQuotaService.js
// Individual ONLY credit reservation/commit (wallet safety phase).
// Schools NEVER call this (routed to usageQuotaService tokens).
//
// STATE (per reservation ledger doc `creditAccounts/{uid}/ledger/{sha}`):
//   reserved   = quota held, NO provider dispatch yet. Only this state may
//                release for zero usage.
//   dispatched = provider dispatch attempted; cost is now POSSIBLE (risk).
//   started    = provider accepted/streamed; cost is now LIKELY (risk).
// Terminal: committed | released | charged. Terminal docs stay for
// idempotency; only the ACTIVE map on the account doc is bounded (25).
//
// WALLET (single account doc `creditAccounts/{uid}`):
//   monthly/rollover/topup remaining + reservedCreditsMilli +
//   activeReservations { <reservationDocId>: { amountMilli, state,
//     expiresAtMs, modelKey, breakdown, createdAtMs } }.
// Bucket arithmetic lives ONLY in creditBucketMath (order rollover ->
// monthly -> topup). Every reservation persists its reservedBreakdown so
// release/commit restore the SAME buckets. TTL sweep (600s, mirrored from
// the token quota) bounds crashed-request holds: reserved-expired releases
// exactly; dispatched/started-expired charges conservatively (never silent
// release after provider risk began).
//
// BOUNDARY: uses ONLY subiDb. Never learnsmartDb. DI supports fakes.

const crypto = require("crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { subiDb } = require("../db");
const { creditsMilliForUsage } = require("./creditMath");
const { pinPricing } = require("./pricingSnapshot");
const { toSafeAccount } = require("./individualCreditAccountService");
const {
  deductCreditsFromBuckets,
  splitActualFromReserved,
} = require("./creditBucketMath");

const COLLECTION = "creditAccounts";

// Mirrors the proven token quota (usageQuotaService): 500s stream ceiling +
// buffer, 25 concurrent reservations per UID. Same values, local constants
// so the credit path never depends on token internals.
const CREDIT_RESERVATION_TTL_MS = 600_000;
const MAX_ACTIVE_CREDIT_RESERVATIONS = 25;

const ACTIVE_CREDIT_STATES = new Set(["reserved", "dispatched", "started"]);
const PROVIDER_RISK_CREDIT_STATES = new Set(["dispatched", "started"]);

function defaultDeps() {
  return { store: subiDb };
}
function cleanId(v, max = 128) { return String(v || "").trim().slice(0, max); }
function invalidRequest(m) { const e = new Error(m || "invalid credit quota payload"); e.code = "INVALID_REQUEST"; return e; }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }
function num(v) { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0; }

function reservationDocId(uid, requestId) {
  return crypto.createHash("sha256").update(`${uid}\0${requestId}`, "utf8").digest("hex");
}

function isTerminalDoc(doc) {
  const d = (doc && typeof doc === "object") ? doc : {};
  return d.committed === true || d.released === true
    || d.state === "committed" || d.state === "released" || d.state === "charged";
}

function docState(doc) {
  const d = (doc && typeof doc === "object") ? doc : {};
  if (typeof d.state === "string" && (ACTIVE_CREDIT_STATES.has(d.state)
    || d.state === "committed" || d.state === "released" || d.state === "charged")) {
    return d.state;
  }
  // Legacy docs (pre-state): terminal flags win, else pre-dispatch.
  if (d.committed === true) return "committed";
  if (d.released === true) return "released";
  return "reserved";
}

function isProviderRiskState(state) {
  return PROVIDER_RISK_CREDIT_STATES.has(state);
}

// Missing expiry means stale (fail-safe toward settlement, never toward
// holding funds forever).
function isExpiredMs(expiresAtMs, nowMs) {
  return typeof expiresAtMs !== "number" || expiresAtMs <= nowMs;
}

function activeMapOf(acct) {
  const m = acct && acct.activeReservations && typeof acct.activeReservations === "object"
    ? acct.activeReservations : {};
  return { ...m };
}

function readBreakdown(doc, fallbackTotal) {
  const b = doc && typeof doc.reservedBreakdown === "object" ? doc.reservedBreakdown : null;
  if (b) {
    return {
      rolloverMilli: num(b.rolloverMilli),
      monthlyMilli: num(b.monthlyMilli),
      topupMilli: num(b.topupMilli),
    };
  }
  // Legacy reservation (pre-breakdown): total was deducted monthly-first, so
  // restoring to monthly preserves the old composition exactly.
  return { rolloverMilli: 0, monthlyMilli: num(fallbackTotal), topupMilli: 0 };
}

function balancesOf(acct) {
  return {
    rolloverRemainingMilli: num(acct.rolloverRemainingCreditsMilli),
    monthlyRemainingMilli: num(acct.monthlyRemainingCreditsMilli),
    topupRemainingMilli: num(acct.topupRemainingCreditsMilli),
  };
}

// Settle one expired non-terminal reservation against in-memory balances.
// Returns { balances, counterDelta, ledgerPatch, activePrune, charged, released }.
//   reserved (no provider risk) -> release exact breakdown to SAME buckets.
//   dispatched/started (provider risk) -> charge: no refund, hold stays spent.
function settleExpiredReservation(acct, resDoc) {
  const balances = balancesOf(acct);
  const reserved = num(resDoc.amountMilli);
  const breakdown = readBreakdown(resDoc, reserved);
  const state = docState(resDoc);
  if (isProviderRiskState(state)) {
    return {
      balances,
      counterDelta: -reserved,
      ledgerPatch: { state: "charged", finalReason: "stale-risk-charged", chargedAtMs: Date.now() },
      charged: reserved,
      released: 0,
    };
  }
  return {
    balances: {
      rolloverRemainingMilli: balances.rolloverRemainingMilli + breakdown.rolloverMilli,
      monthlyRemainingMilli: balances.monthlyRemainingMilli + breakdown.monthlyMilli,
      topupRemainingMilli: balances.topupRemainingMilli + breakdown.topupMilli,
    },
    counterDelta: -reserved,
    ledgerPatch: { released: true, state: "released", finalReason: "stale-reserved-released", releasedAtMs: Date.now() },
    charged: 0,
    released: reserved,
  };
}

async function reserveCredits({ uid, requestId, estimateMilli, pricing, modelKey, cycleId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = String(requestId || "");
  if (!id || !rid || rid.length > 64) throw invalidRequest("missing uid/requestId");
  const need = num(estimateMilli);
  const snap = pinPricing({ pricing, modelKey });
  if (!Number.isSafeInteger(estimateMilli) || estimateMilli < 0 || (need === 0 && !snap.isFree)) {
    throw invalidRequest('Only zero-price models can reserve zero credits');
  }
  const nowMs = Date.now();
  const ref = d.store.collection(COLLECTION).doc(id);
  const resRef = ref.collection("ledger").doc(reservationDocId(id, rid));
  // Idempotency outcomes are RETURNED from the transaction (never thrown
  // inside it): same-request stale cleanup must COMMIT before the refusal is
  // produced. Refusal errors are raised OUTSIDE, after commit.
  const outcome = await d.store.runTransaction(async (tx) => {
    // Reads first (Firestore rule): reservation, account, then any expired
    // active reservation docs. No writes until all reads complete.
    const existing = await tx.get(resRef);
    const uSnap = await tx.get(ref);
    if (existing.exists) {
      const doc = existing.data() || {};
      if (!isTerminalDoc(doc) && !isExpiredMs(doc.expiresAtMs, nowMs)) {
        return { outcome: "in_progress" };
      }
      if (!isTerminalDoc(doc) && isExpiredMs(doc.expiresAtMs, nowMs)) {
        // Same-request retry after expiry: reconcile the dead attempt now
        // (charge if provider-risk, release if reserved) and persist it.
        if (!uSnap.exists) throw coded("no credit account", "CREDITS_NOT_CONFIGURED");
        const acct = toSafeAccount(id, uSnap.data() || {});
        const settled = settleExpiredReservation(acct, doc);
        const active = activeMapOf(acct);
        delete active[reservationDocId(id, rid)];
        tx.set(ref, {
          monthlyRemainingCreditsMilli: settled.balances.monthlyRemainingMilli,
          rolloverRemainingCreditsMilli: settled.balances.rolloverRemainingMilli,
          topupRemainingCreditsMilli: settled.balances.topupRemainingMilli,
          reservedCreditsMilli: Math.max(0, num(acct.reservedCreditsMilli) + settled.counterDelta),
          activeReservations: { ...active, [reservationDocId(id, rid)]: FieldValue.delete() },
          updatedAtMs: Date.now(),
        }, { merge: true });
        tx.set(resRef, { ...doc, ...settled.ledgerPatch }, { merge: true });
      }
      return { outcome: "already_processed" };
    }
    if (!uSnap.exists) throw coded("no credit account", "CREDITS_NOT_CONFIGURED");
    const acct = toSafeAccount(id, uSnap.data() || {});
    if (acct.subscriptionActive !== true) throw coded("subscription inactive", "SUBI_PLAN_EXPIRED");
    // General stale sweep over the active map (reads before any write).
    const active = activeMapOf(acct);
    const expiredReads = [];
    for (const [entryId, entry] of Object.entries(active)) {
      const e = (entry && typeof entry === "object") ? entry : {};
      if (!isExpiredMs(e.expiresAtMs, nowMs)) continue;
      const snapEntry = await tx.get(ref.collection("ledger").doc(entryId));
      expiredReads.push({ entryId, entry: e, snap: snapEntry });
    }
    let balances = balancesOf(acct);
    let reservedCounter = num(acct.reservedCreditsMilli);
    const prunes = {};
    const sweptLedgerSets = [];
    for (const { entryId, snap: entrySnap } of expiredReads) {
      if (!entrySnap.exists) {
        // Ledger doc missing (impossible via atomic creation): prune the
        // index but hold funds (fail-safe, never fabricate a refund).
        prunes[entryId] = FieldValue.delete();
        continue;
      }
      const entryDoc = entrySnap.data() || {};
      if (isTerminalDoc(entryDoc)) {
        prunes[entryId] = FieldValue.delete();
        continue;
      }
      const settled = settleExpiredReservation({ ...acct, ...balancesToAcctShape(balances) }, entryDoc);
      balances = settled.balances;
      reservedCounter = Math.max(0, reservedCounter + settled.counterDelta);
      prunes[entryId] = FieldValue.delete();
      sweptLedgerSets.push({ ref: ref.collection("ledger").doc(entryId), patch: { ...entryDoc, ...settled.ledgerPatch } });
    }
    const liveActive = {};
    for (const [entryId, entry] of Object.entries(active)) {
      if (prunes[entryId]) continue;
      const e = (entry && typeof entry === "object") ? entry : {};
      // Non-expired entries are live by construction (expired ones were read
      // above and either settled+pruned or terminal+pruned).
      if (!isExpiredMs(e.expiresAtMs, nowMs)) liveActive[entryId] = e;
      else prunes[entryId] = FieldValue.delete();
    }
    if (Object.keys(liveActive).length >= MAX_ACTIVE_CREDIT_RESERVATIONS) {
      throw coded("too many active requests", "TOO_MANY_ACTIVE_REQUESTS");
    }
    const deducted2 = deductCreditsFromBuckets(
      {
        rolloverRemainingMilli: balances.rolloverRemainingMilli,
        monthlyRemainingMilli: balances.monthlyRemainingMilli,
        topupRemainingMilli: balances.topupRemainingMilli,
      },
      need
    );
    if (!deducted2) throw coded("insufficient credits", "INSUFFICIENT_CREDITS");
    const breakdown = {
      rolloverMilli: deducted2.consumed.rolloverMilli,
      monthlyMilli: deducted2.consumed.monthlyMilli,
      topupMilli: deducted2.consumed.topupMilli,
    };
    const expiresAtMs = nowMs + CREDIT_RESERVATION_TTL_MS;
    const newEntry = {
      amountMilli: need,
      state: "reserved",
      expiresAtMs,
      modelKey: String(modelKey || "").slice(0, 128),
      breakdown,
      createdAtMs: nowMs,
    };
    for (const { ref: ledgerRef, patch } of sweptLedgerSets) {
      tx.set(ledgerRef, patch, { merge: true });
    }
    tx.set(ref, {
      monthlyRemainingCreditsMilli: deducted2.remaining.monthlyMilli,
      rolloverRemainingCreditsMilli: deducted2.remaining.rolloverMilli,
      topupRemainingCreditsMilli: deducted2.remaining.topupMilli,
      reservedCreditsMilli: reservedCounter + need,
      activeReservations: { ...liveActive, ...prunes, [reservationDocId(id, rid)]: newEntry },
      updatedAtMs: Date.now(),
    }, { merge: true });
    tx.set(resRef, {
      type: "reservation", amountMilli: need, cycleId: cycleId || acct.cycleId,
      modelKey: String(modelKey || "").slice(0, 128),
      // Pinned pricing snapshot: commit MUST reuse these exact per-1M numbers
      // and this priceVersion. Never re-read live catalog pricing for this
      // requestId. Aliases inputUsdPerMillion/outputUsdPerMillion are the
      // spec-preferred names for the same normalized numbers.
      priceVersion: snap.priceVersion, inputPricePerMillion: snap.inputPricePerMillion,
      outputPricePerMillion: snap.outputPricePerMillion,
      inputUsdPerMillion: snap.inputPricePerMillion,
      outputUsdPerMillion: snap.outputPricePerMillion,
      capturedAtMs: snap.capturedAtMs,
      isFree: snap.isFree === true,
      costClass: snap.costClass,
      reservedBreakdown: breakdown,
      state: "reserved",
      createdAtMs: nowMs,
      expiresAtMs,
      released: false, committed: false,
    });
    return {
      outcome: "reserved",
      reservationDocId: reservationDocId(id, rid),
      reservedMilli: need,
      priceVersion: snap.priceVersion,
      reservedBreakdown: breakdown,
      expiresAtMs,
    };
  });
  if (outcome.outcome === "in_progress") {
    throw coded("request already in progress", "CREDIT_REQUEST_IN_PROGRESS");
  }
  if (outcome.outcome === "already_processed") {
    throw coded("request already processed", "CREDIT_REQUEST_ALREADY_PROCESSED");
  }
  return outcome;
}

function balancesToAcctShape(balances) {
  return {
    monthlyRemainingCreditsMilli: balances.monthlyRemainingMilli,
    rolloverRemainingCreditsMilli: balances.rolloverRemainingMilli,
    topupRemainingCreditsMilli: balances.topupRemainingMilli,
  };
}

async function markCreditState({ uid, requestId, toState }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = String(requestId || "");
  if (!id || !rid) throw invalidRequest("missing uid/requestId");
  if (toState !== "dispatched" && toState !== "started") throw invalidRequest("invalid credit state");
  const ref = d.store.collection(COLLECTION).doc(id);
  const resRef = ref.collection("ledger").doc(reservationDocId(id, rid));
  return d.store.runTransaction(async (tx) => {
    const rSnap = await tx.get(resRef);
    if (!rSnap.exists) throw coded("unknown credit reservation", "CREDIT_RESERVATION_NOT_FOUND");
    const rDoc = rSnap.data() || {};
    if (isTerminalDoc(rDoc)) return { alreadyTerminal: true, state: docState(rDoc) };
    const cur = docState(rDoc);
    // Idempotent: already at or past the target state (dispatched -> started
    // is forward progress; started -> dispatched never regresses).
    if (cur === toState || (cur === "started" && toState === "dispatched")) {
      return { alreadyMarked: true, state: cur };
    }
    const uSnap = await tx.get(ref);
    const acct = toSafeAccount(id, (uSnap.exists ? uSnap.data() : {}) || {});
    const active = activeMapOf(acct);
    const entryId = reservationDocId(id, rid);
    const stamp = toState === "dispatched" ? { dispatchedAtMs: Date.now() } : { startedAtMs: Date.now() };
    tx.set(resRef, { ...rDoc, state: toState, ...stamp }, { merge: true });
    if (active[entryId] && typeof active[entryId] === "object") {
      tx.set(ref, {
        activeReservations: { ...active, [entryId]: { ...active[entryId], state: toState } },
        updatedAtMs: Date.now(),
      }, { merge: true });
    }
    return { marked: true, state: toState };
  });
}

async function markCreditDispatched(args, deps) {
  return markCreditState({ ...(args || {}), toState: "dispatched" }, deps);
}

async function markCreditStarted(args, deps) {
  return markCreditState({ ...(args || {}), toState: "started" }, deps);
}

async function commitCredits({ uid, requestId, actualInputTokens, actualOutputTokens, pricing, modelKey, minChargeMilli = 1000, finalState = "completed" }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = String(requestId || "");
  if (!id || !rid) throw invalidRequest("missing uid/requestId");
  // NOTE: live `pricing` arg is LEGACY fallback only. The authoritative prices
  // come from the reservation's pinned snapshot (stored at reserve time).
  // Commit must NOT call live catalog pricing for this requestId: a catalog
  // move from $2/$10 to $3/$15 mid-request must still settle at $2/$10.
  const legacySnap = (pricing !== undefined && pricing !== null)
    ? (() => { try { return pinPricing({ pricing, modelKey }); } catch (_) { return null; } })()
    : null;
  const ref = d.store.collection(COLLECTION).doc(id);
  const resRef = ref.collection("ledger").doc(reservationDocId(id, rid));
  return d.store.runTransaction(async (tx) => {
    const rSnap = await tx.get(resRef);
    if (!rSnap.exists) throw coded("unknown reservation", "CREDIT_RESERVATION_NOT_FOUND");
    const rDoc = rSnap.data() || {};
    if (isTerminalDoc(rDoc)) return { alreadyTerminal: true, actualMilli: 0 };
    // Prefer pinned reservation pricing; fall back to legacy live pin only
    // for reservations written before pinned fields existed.
    const pinnedIn = (typeof rDoc.inputPricePerMillion === "number" ? rDoc.inputPricePerMillion
      : typeof rDoc.inputUsdPerMillion === "number" ? rDoc.inputUsdPerMillion : null);
    const pinnedOut = (typeof rDoc.outputPricePerMillion === "number" ? rDoc.outputPricePerMillion
      : typeof rDoc.outputUsdPerMillion === "number" ? rDoc.outputUsdPerMillion : null);
    let useIn = pinnedIn;
    let useOut = pinnedOut;
    let priceVersion = typeof rDoc.priceVersion === "string" ? rDoc.priceVersion : null;
    let isFree = rDoc.isFree === true;
    if (useIn === null || useOut === null || !priceVersion) {
      if (!legacySnap) throw coded("pinned pricing missing", "INTERNAL");
      useIn = legacySnap.inputPricePerMillion;
      useOut = legacySnap.outputPricePerMillion;
      priceVersion = legacySnap.priceVersion;
      isFree = legacySnap.isFree === true;
    } else if (typeof rDoc.isFree !== "boolean") {
      // Very old reservation with prices but no isFree flag: derive free iff
      // both pinned sides are exactly 0 (same definition as pinPricing).
      isFree = useIn === 0 && useOut === 0;
    }
    let actualMilli = creditsMilliForUsage({
      inputTokens: actualInputTokens, outputTokens: actualOutputTokens,
      inputPricePerMillion: useIn, outputPricePerMillion: useOut,
    });
    // Free pricing always burns zero. Successful paid requests have a one-credit floor.
    // Pinned pricing prevents catalog changes from repricing a request.
    if (!isFree && finalState === 'completed' && actualMilli < minChargeMilli) {
      actualMilli = minChargeMilli;
    }
    const reserved = num(rDoc.amountMilli);
    const breakdown = readBreakdown(rDoc, reserved);
    const uSnap = await tx.get(ref);
    const acct = toSafeAccount(id, (uSnap.exists ? uSnap.data() : {}) || {});
    const active = activeMapOf(acct);
    const entryId = reservationDocId(id, rid);
    let balances = balancesOf(acct);
    let refundMilli = 0;
    let overMilli = 0;
    let shortfallMilli = 0;
    if (actualMilli <= reserved) {
      // Deterministic reconciliation against the reserved breakdown: the
      // actual burn consumes reserved buckets in order; leftovers return to
      // the SAME buckets (never blindly to monthly).
      const split = splitActualFromReserved(breakdown, actualMilli);
      refundMilli = reserved - actualMilli;
      balances = {
        rolloverRemainingMilli: balances.rolloverRemainingMilli + split.refund.rolloverMilli,
        monthlyRemainingMilli: balances.monthlyRemainingMilli + split.refund.monthlyMilli,
        topupRemainingMilli: balances.topupRemainingMilli + split.refund.topupMilli,
      };
    } else {
      // Over-reservation: the full reservation is consumed, then the extra
      // is deducted once from live balances in authoritative order. If live
      // funds cannot cover the extra, charge a bounded amount (reserved +
      // whatever is available — never negative) and record the shortfall in
      // the ledger instead of corrupting the wallet.
      overMilli = actualMilli - reserved;
      const attempt = deductCreditsFromBuckets(
        {
          rolloverRemainingMilli: balances.rolloverRemainingMilli,
          monthlyRemainingMilli: balances.monthlyRemainingMilli,
          topupRemainingMilli: balances.topupRemainingMilli,
        },
        overMilli
      );
      if (attempt) {
        balances = {
          rolloverRemainingMilli: attempt.remaining.rolloverMilli,
          monthlyRemainingMilli: attempt.remaining.monthlyMilli,
          topupRemainingMilli: attempt.remaining.topupMilli,
        };
      } else {
        const availableTotal = balances.rolloverRemainingMilli
          + balances.monthlyRemainingMilli + balances.topupRemainingMilli;
        const bounded = deductCreditsFromBuckets(
          {
            rolloverRemainingMilli: balances.rolloverRemainingMilli,
            monthlyRemainingMilli: balances.monthlyRemainingMilli,
            topupRemainingMilli: balances.topupRemainingMilli,
          },
          availableTotal
        );
        if (bounded) {
          balances = {
            rolloverRemainingMilli: bounded.remaining.rolloverMilli,
            monthlyRemainingMilli: bounded.remaining.monthlyMilli,
            topupRemainingMilli: bounded.remaining.topupMilli,
          };
        }
        shortfallMilli = overMilli - availableTotal;
      }
    }
    tx.set(ref, {
      monthlyRemainingCreditsMilli: balances.monthlyRemainingMilli,
      rolloverRemainingCreditsMilli: balances.rolloverRemainingMilli,
      topupRemainingCreditsMilli: balances.topupRemainingMilli,
      reservedCreditsMilli: Math.max(0, num(acct.reservedCreditsMilli) - reserved),
      activeReservations: { ...active, [entryId]: FieldValue.delete() },
      updatedAtMs: Date.now(),
    }, { merge: true });
    tx.set(resRef, {
      ...rDoc, committed: true, state: "committed",
      actualMilli, shortfallMilli,
      createdAtMs: rDoc.createdAtMs || Date.now(), committedAtMs: Date.now(),
    }, { merge: true });
    const cRef = ref.collection("ledger").doc(`commit-${reservationDocId(id, rid)}`);
    tx.set(cRef, {
      type: "usage_commit", amountMilli: actualMilli, cycleId: rDoc.cycleId || acct.cycleId,
      modelKey: String(modelKey || "").slice(0, 128), priceVersion,
      requestId: rid, shortfallMilli, createdAtMs: Date.now(),
    });
    return { actualMilli, refundMilli, overMilli, shortfallMilli };
  });
}

async function releaseCredits({ uid, requestId }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = String(requestId || "");
  const ref = d.store.collection(COLLECTION).doc(id);
  const resRef = ref.collection("ledger").doc(reservationDocId(id, rid));
  return d.store.runTransaction(async (tx) => {
    const rSnap = await tx.get(resRef);
    if (!rSnap.exists) return { released: true };
    const rDoc = rSnap.data() || {};
    if (isTerminalDoc(rDoc)) return { released: true };
    const reserved = num(rDoc.amountMilli);
    const breakdown = readBreakdown(rDoc, reserved);
    const uSnap = await tx.get(ref);
    const acct = toSafeAccount(id, (uSnap.exists ? uSnap.data() : {}) || {});
    const active = activeMapOf(acct);
    const entryId = reservationDocId(id, rid);
    // Exact same-bucket restoration: each reserved bucket returns to the
    // bucket it came from (rollover->rollover, monthly->monthly, topup->topup).
    tx.set(ref, {
      monthlyRemainingCreditsMilli: num(acct.monthlyRemainingCreditsMilli) + breakdown.monthlyMilli,
      rolloverRemainingCreditsMilli: num(acct.rolloverRemainingCreditsMilli) + breakdown.rolloverMilli,
      topupRemainingCreditsMilli: num(acct.topupRemainingCreditsMilli) + breakdown.topupMilli,
      reservedCreditsMilli: Math.max(0, num(acct.reservedCreditsMilli) - reserved),
      activeReservations: { ...active, [entryId]: FieldValue.delete() },
      updatedAtMs: Date.now(),
    }, { merge: true });
    tx.set(resRef, { ...rDoc, released: true, state: "released", releasedAtMs: Date.now() }, { merge: true });
    return { released: true, releasedMilli: reserved, releasedBreakdown: breakdown };
  });
}

// Unknown usage after provider risk began (dispatch attempted but no
// trustworthy token counts). Conservative bounded charge: the full reserved
// amount stays spent (it was estimated from upper bounds), nothing extra is
// deducted, and a ledger record explains the charge. Reserved-state
// reservations (no provider risk possible) release exactly instead.
// Idempotent: repeated calls after terminal are no-ops.
async function finalizeCreditUnknownUsage({ uid, requestId, modelKey }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = String(requestId || "");
  if (!id || !rid) throw invalidRequest("missing uid/requestId");
  const ref = d.store.collection(COLLECTION).doc(id);
  const resRef = ref.collection("ledger").doc(reservationDocId(id, rid));
  return d.store.runTransaction(async (tx) => {
    const rSnap = await tx.get(resRef);
    if (!rSnap.exists) throw coded("unknown credit reservation", "CREDIT_RESERVATION_NOT_FOUND");
    const rDoc = rSnap.data() || {};
    if (isTerminalDoc(rDoc)) return { alreadyTerminal: true, chargedMilli: 0 };
    const state = docState(rDoc);
    if (!isProviderRiskState(state)) {
      // No provider cost possible: exact same-bucket release.
      const reserved = num(rDoc.amountMilli);
      const breakdown = readBreakdown(rDoc, reserved);
      const uSnap = await tx.get(ref);
      const acct = toSafeAccount(id, (uSnap.exists ? uSnap.data() : {}) || {});
      const active = activeMapOf(acct);
      const entryId = reservationDocId(id, rid);
      tx.set(ref, {
        monthlyRemainingCreditsMilli: num(acct.monthlyRemainingCreditsMilli) + breakdown.monthlyMilli,
        rolloverRemainingCreditsMilli: num(acct.rolloverRemainingCreditsMilli) + breakdown.rolloverMilli,
        topupRemainingCreditsMilli: num(acct.topupRemainingCreditsMilli) + breakdown.topupMilli,
        reservedCreditsMilli: Math.max(0, num(acct.reservedCreditsMilli) - reserved),
        activeReservations: { ...active, [entryId]: FieldValue.delete() },
        updatedAtMs: Date.now(),
      }, { merge: true });
      tx.set(resRef, { ...rDoc, released: true, state: "released", finalReason: "unknown-no-risk-released", releasedAtMs: Date.now() }, { merge: true });
      return { released: true, releasedMilli: reserved, releasedBreakdown: breakdown };
    }
    const reserved = num(rDoc.amountMilli);
    const breakdown = readBreakdown(rDoc, reserved);
    const uSnap = await tx.get(ref);
    const acct = toSafeAccount(id, (uSnap.exists ? uSnap.data() : {}) || {});
    const active = activeMapOf(acct);
    const entryId = reservationDocId(id, rid);
    // Conservative charge: reserved breakdown stays spent. Only the hold
    // counter and the active index move; balances are untouched.
    tx.set(ref, {
      reservedCreditsMilli: Math.max(0, num(acct.reservedCreditsMilli) - reserved),
      activeReservations: { ...active, [entryId]: FieldValue.delete() },
      updatedAtMs: Date.now(),
    }, { merge: true });
    tx.set(resRef, {
      ...rDoc, state: "charged", finalReason: "unknown-post-dispatch-charged",
      chargedMilli: reserved, chargedAtMs: Date.now(),
    }, { merge: true });
    const cRef = ref.collection("ledger").doc(`charge-${reservationDocId(id, rid)}`);
    tx.set(cRef, {
      type: "conservative_charge", amountMilli: reserved, cycleId: rDoc.cycleId || acct.cycleId,
      modelKey: String(modelKey || rDoc.modelKey || "").slice(0, 128),
      priceVersion: typeof rDoc.priceVersion === "string" ? rDoc.priceVersion : null,
      reservedBreakdown: breakdown,
      requestId: rid, reason: "unknown-post-dispatch", createdAtMs: Date.now(),
    });
    return { charged: true, chargedMilli: reserved, reservedBreakdown: breakdown };
  });
}

module.exports = {
  reserveCredits,
  commitCredits,
  releaseCredits,
  finalizeCreditUnknownUsage,
  markCreditDispatched,
  markCreditStarted,
  reservationDocId,
  CREDIT_RESERVATION_TTL_MS,
  MAX_ACTIVE_CREDIT_RESERVATIONS,
};
