// functions-subi/src/services/individualCreditShadowService.js
// Individual ONLY shadow credit accounting (observational, non-authoritative).
// Answers "what WOULD credit enforcement have charged/blocked?" WITHOUT
// deducting credits, mutating wallet buckets, blocking requests, or touching
// school behavior. Schools NEVER enter this module (shouldShadow fails closed
// for accountType == "school" before any store access).
//
// STORAGE (clearly non-authoritative, never the credit ledger):
//   creditAccounts/{uid}/shadowUsage/{sha(uid + requestId)}
// Every doc carries mode:"shadow" + authoritative:false so no reader can
// mistake it for a real charge. Doc id reuses the reservation identity
// (reservationDocId) so start/finalize are idempotent on the same turn.
//
// PRICING: pinned once at start via pricingSnapshot.pinPricing (same function
// real enforcement uses). Finalize reuses the STORED pin — never live
// catalog pricing — so mid-turn repricing cannot move the shadow result.
// CHARGE MATH: creditsMilliForUsage + the 1-credit minimum for successful
// chargeable FREE-model requests, mirroring commitCredits exactly.
// SPEND ORDER: planCreditSpend (creditBucketMath) — rollover -> monthly ->
// topup — with ZERO mutation. No spend-order math is duplicated here.
//
// FAILURE MODE: every public entry point throws on store failure; CALLERS
// (the agent route) must catch and continue the live request. Shadow
// telemetry must never break an otherwise-valid request while enforcement
// is OFF.
//
// PRIVACY: numeric/metadata only. Never prompt/response content, file or
// terminal output, secrets, ID tokens, or provider keys.
//
// BOUNDARY: uses ONLY subiDb (injected store). Never learnsmartDb, secrets,
// provider fetch. DI supports fakes.

const { subiDb } = require("../db");
const { creditsMilliForUsage } = require("./creditMath");
const { pinPricing } = require("./pricingSnapshot");
const { planCreditSpend } = require("./creditBucketMath");
const { getCreditAccount } = require("./individualCreditAccountService");
const { reservationDocId } = require("./individualCreditQuotaService");
const {
  info: logInfo,
  warn: logWarn,
  hashRequestId,
} = require("../utils/structuredLogger");

const SHADOW_SUBCOLLECTION = "shadowUsage";

// Mirrors commitCredits' default minChargeMilli: 1 displayed credit per
// successful chargeable FREE-model request. Paid models may burn < 1000.
const MIN_FREE_CHARGE_MILLI = 1000;

const SHADOW_OUTCOMES = Object.freeze([
  "provider_success",
  "provider_error",
  "cancelled",
  "pre_dispatch_failure",
  "unknown_post_dispatch",
]);

function defaultDeps() {
  return { store: subiDb };
}
function cleanId(v, max = 128) {
  return String(v || "").trim().slice(0, max);
}
function cleanRequestId(v) {
  const s = String(v || "");
  if (!s || s.length > 128) {
    const e = new Error("missing uid/requestId");
    e.code = "INVALID_REQUEST";
    throw e;
  }
  return s;
}
function invalidRequest(m) {
  const e = new Error(m || "invalid shadow payload");
  e.code = "INVALID_REQUEST";
  return e;
}
function coded(m, c) {
  const e = new Error(m);
  e.code = c;
  return e;
}
function num(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}
function cleanTokens(v) {
  return num(v);
}
function emitInfo(action, fields) {
  try {
    logInfo(action, fields);
  } catch (_) {
    // Observability must never affect the shadow path.
  }
}
function emitWarn(action, fields) {
  try {
    logWarn(action, fields);
  } catch (_) {
    // Observability must never affect the shadow path.
  }
}

// Gate (FAIL CLOSED): true only for an individual turn while real
// enforcement is OFF and the UID is explicitly listed in a non-empty
// shadowTestUids allowlist. An empty allowlist shadows nobody. Schools (and
// any unknown account type) fail closed here before any store access.
function shouldShadow({ quotaMode, accountType, flags, uid, enforcementEnabled } = {}) {
  const claimed = String(accountType || "").trim().toLowerCase();
  if (claimed === "school") return false;
  if (quotaMode !== "individual_credits") return false;
  if (claimed !== "" && claimed !== "individual") return false;
  if (enforcementEnabled === true) return false;
  if (!flags || flags.shadowEnabled !== true) return false;
  const list = Array.isArray(flags.shadowTestUids) ? flags.shadowTestUids : [];
  // FAIL CLOSED: an empty/missing allowlist shadows nobody (no implicit
  // global rollout). Mirrors isShadowEnabledForUid.
  if (list.length === 0) return false;
  const id = String(uid || "").trim().slice(0, 128);
  return id !== "" && list.includes(id);
}

// Pre-request wallet snapshot (authoritative read, no mutation). Balances
// are already net of any live reserved holds (reserve deducts balances and
// tracks the hold in reservedCreditsMilli), so totalAvailable matches what
// real enforcement would consider available — reserved money is never
// double-counted.
function buildWalletSnapshot(acct) {
  const a = (acct && typeof acct === "object") ? acct : {};
  const rollover = num(a.rolloverRemainingCreditsMilli);
  const monthly = num(a.monthlyRemainingCreditsMilli);
  const topup = num(a.topupRemainingCreditsMilli);
  return {
    cycleId: typeof a.cycleId === "string" ? a.cycleId : null,
    rolloverMilli: rollover,
    monthlyMilli: monthly,
    topupMilli: topup,
    reservedMilli: num(a.reservedCreditsMilli),
    totalAvailableMilli: rollover + monthly + topup,
  };
}

// What authoritative enforcement WOULD reserve before dispatch: upper-bound
// usage priced at the pinned snapshot, with the same 1-credit floor free
// models use to prevent empty-reserve loops.
function estimateReservationMilli({ inputUpperBound, maxOutputTokens, snap } = {}) {
  const s = (snap && typeof snap === "object") ? snap : {};
  if (typeof s.inputPricePerMillion !== "number" || typeof s.outputPricePerMillion !== "number") {
    throw invalidRequest("estimate requires a pinned pricing snapshot");
  }
  const milli = creditsMilliForUsage({
    inputTokens: cleanTokens(inputUpperBound),
    outputTokens: cleanTokens(maxOutputTokens),
    inputPricePerMillion: s.inputPricePerMillion,
    outputPricePerMillion: s.outputPricePerMillion,
  });
  return s.isFree === true ? 0 : Math.max(MIN_FREE_CHARGE_MILLI, milli);
}

// Shadow actual charge: same math + same free-model minimum as commitCredits.
// isFree comes from the PINNED snapshot, so catalog flips mid-request never
// reprice the turn. Zero-token turns stay 0 (no minimum on empty usage).
function computeActualChargeMilli({ snap, inputTokens, outputTokens, minChargeMilli = MIN_FREE_CHARGE_MILLI, successful = true } = {}) {
  const s = (snap && typeof snap === "object") ? snap : {};
  if (typeof s.inputPricePerMillion !== "number" || typeof s.outputPricePerMillion !== "number") {
    throw invalidRequest("actual charge requires a pinned pricing snapshot");
  }
  const inn = cleanTokens(inputTokens);
  const out = cleanTokens(outputTokens);
  let milli = creditsMilliForUsage({
    inputTokens: inn,
    outputTokens: out,
    inputPricePerMillion: s.inputPricePerMillion,
    outputPricePerMillion: s.outputPricePerMillion,
  });
  const floor = num(minChargeMilli) > 0 ? num(minChargeMilli) : MIN_FREE_CHARGE_MILLI;
  if (s.isFree !== true && successful && milli < floor) {
    milli = floor;
  }
  return milli;
}

// Multi-segment accumulation: one logical turn may stream several provider
// segments (tool chains). The shadow boundary equals the reservation
// boundary (one /agent/turn requestId), and the charge applies to the summed
// server-observed totals — the same aggregation authoritative enforcement
// settles. Pure helper so future multi-call turns share one definition.
function sumUsage(segments) {
  const list = Array.isArray(segments) ? segments : [];
  let inn = 0;
  let out = 0;
  for (const seg of list) {
    const s = (seg && typeof seg === "object") ? seg : {};
    inn += cleanTokens(s.inputTokens);
    out += cleanTokens(s.outputTokens);
  }
  return { inputTokens: inn, outputTokens: out };
}

function shadowRef(store, uid, requestId) {
  return store.collection("creditAccounts").doc(uid).collection(SHADOW_SUBCOLLECTION).doc(reservationDocId(uid, requestId));
}

// Shadow preflight: capture the wallet + pin pricing + project the
// reservation. Idempotent: a retry for the same requestId returns the
// existing doc without overwriting. Throws when there is no wallet or no
// usable pricing — callers treat that as "skip shadow, continue live".
async function startShadow(
  { uid, requestId, modelKey, storedPricing, inputUpperBound, maxOutputTokens, cycleId } = {},
  deps
) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = cleanRequestId(requestId);
  if (!id) throw invalidRequest("missing uid/requestId");
  const key = String(modelKey || "").slice(0, 128);
  const acct = typeof d.getCreditAccountFn === "function"
    ? await d.getCreditAccountFn(id)
    : await getCreditAccount(id, { store: d.store });
  if (!acct) throw coded("no credit account", "CREDITS_NOT_CONFIGURED");
  const snap = pinPricing({ pricing: storedPricing, modelKey: key });
  const estimated = estimateReservationMilli({ inputUpperBound, maxOutputTokens, snap });
  const wallet = buildWalletSnapshot(acct);
  const projection = planCreditSpend({
    availableBuckets: { rolloverMilli: wallet.rolloverMilli, monthlyMilli: wallet.monthlyMilli, topupMilli: wallet.topupMilli },
    requestedMilli: estimated,
  });
  const wouldBlock = projection.shortfallMilli > 0;
  const nowMs = Date.now();
  const doc = {
    mode: "shadow",
    authoritative: false,
    uid: id,
    requestId: rid,
    cycleId: (typeof cycleId === "string" && cycleId ? cycleId : wallet.cycleId),
    modelKey: key,
    status: "open",
    pricingSnapshot: {
      priceVersion: snap.priceVersion,
      inputPricePerMillion: snap.inputPricePerMillion,
      outputPricePerMillion: snap.outputPricePerMillion,
      isFree: snap.isFree === true,
      costClass: snap.costClass,
      capturedAtMs: snap.capturedAtMs,
    },
    walletBefore: wallet,
    estimatedReservationMilli: estimated,
    projectedReservationBreakdown: {
      rolloverMilli: projection.rolloverMilli,
      monthlyMilli: projection.monthlyMilli,
      topupMilli: projection.topupMilli,
    },
    wouldBlockAtReservation: wouldBlock,
    reservationShortfallMilli: projection.shortfallMilli,
    actualInputTokens: null,
    actualOutputTokens: null,
    actualChargeMilli: null,
    projectedActualBreakdown: null,
    wouldCoverActual: null,
    actualShortfallMilli: null,
    outcome: null,
    createdAtMs: nowMs,
    finalizedAtMs: null,
  };
  const out = await d.store.runTransaction(async (tx) => {
    const ref = shadowRef(d.store, id, rid);
    const existing = await tx.get(ref);
    if (existing.exists) {
      return { deduped: true, record: existing.data() || {} };
    }
    tx.set(ref, doc);
    return { deduped: false, record: doc };
  });
  emitInfo("credit_shadow.started", {
    requestIdHash: hashRequestId(rid),
    uidHash: hashRequestId(id),
    modelKey: key,
    estimatedMilli: estimated,
    wouldBlock,
  });
  if (wouldBlock) {
    emitWarn("credit_shadow.would_block", {
      requestIdHash: hashRequestId(rid),
      uidHash: hashRequestId(id),
      modelKey: key,
      stage: "reservation",
      shortfallMilli: projection.shortfallMilli,
    });
  }
  return { started: !out.deduped, deduped: out.deduped === true, record: out.record };
}

// Shadow finalize: settle the actual charge projection against the SAME
// pre-request wallet snapshot. Idempotent: repeated calls return the stored
// charge with no duplicate records. Unknown post-dispatch usage (dispatched
// but no trustworthy token counts) conservatively projects the full held
// estimate — mirroring finalizeCreditUnknownUsage — while pre-dispatch
// failures project 0 (real enforcement would release: no provider risk).
async function finalizeShadow(
  { uid, requestId, inputTokens, outputTokens, outcome, dispatched } = {},
  deps
) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = cleanRequestId(requestId);
  if (!id) throw invalidRequest("missing uid/requestId");
  const finalOutcome = SHADOW_OUTCOMES.includes(outcome) ? outcome : "unknown_post_dispatch";
  const wasDispatched = dispatched === true;
  const inn = cleanTokens(inputTokens);
  const out = cleanTokens(outputTokens);
  const result = await d.store.runTransaction(async (tx) => {
    const ref = shadowRef(d.store, id, rid);
    const snapDoc = await tx.get(ref);
    if (!snapDoc.exists) return { missing: true };
    const doc = snapDoc.data() || {};
    if (typeof doc.finalizedAtMs === "number") {
      return {
        alreadyFinalized: true,
        actualChargeMilli: num(doc.actualChargeMilli),
        outcome: doc.outcome || null,
      };
    }
    const pinned = (doc.pricingSnapshot && typeof doc.pricingSnapshot === "object") ? doc.pricingSnapshot : null;
    if (!pinned || typeof pinned.inputPricePerMillion !== "number" || typeof pinned.outputPricePerMillion !== "number") {
      throw coded("pinned pricing missing", "INTERNAL");
    }
    let actual;
    if (finalOutcome === "unknown_post_dispatch" && wasDispatched && inn + out === 0) {
      actual = num(doc.estimatedReservationMilli);
    } else {
      actual = computeActualChargeMilli({ snap: pinned, inputTokens: inn, outputTokens: out, successful: finalOutcome === "provider_success" });
    }
    const wallet = (doc.walletBefore && typeof doc.walletBefore === "object") ? doc.walletBefore : {};
    const projection = planCreditSpend({
      availableBuckets: {
        rolloverMilli: num(wallet.rolloverMilli),
        monthlyMilli: num(wallet.monthlyMilli),
        topupMilli: num(wallet.topupMilli),
      },
      requestedMilli: actual,
    });
    const wouldCover = projection.shortfallMilli === 0;
    const nowMs = Date.now();
    tx.set(ref, {
      actualInputTokens: inn,
      actualOutputTokens: out,
      actualChargeMilli: actual,
      projectedActualBreakdown: {
        rolloverMilli: projection.rolloverMilli,
        monthlyMilli: projection.monthlyMilli,
        topupMilli: projection.topupMilli,
      },
      wouldCoverActual: wouldCover,
      actualShortfallMilli: projection.shortfallMilli,
      outcome: finalOutcome,
      status: "finalized",
      finalizedAtMs: nowMs,
    }, { merge: true });
    return {
      finalized: true,
      actualChargeMilli: actual,
      wouldCoverActual: wouldCover,
      actualShortfallMilli: projection.shortfallMilli,
      outcome: finalOutcome,
    };
  });
  if (result.missing === true) return result;
  emitInfo("credit_shadow.finalized", {
    requestIdHash: hashRequestId(rid),
    uidHash: hashRequestId(id),
    outcome: result.outcome || finalOutcome,
    actualChargeMilli: num(result.actualChargeMilli),
  });
  if (result.wouldCoverActual === false) {
    emitWarn("credit_shadow.shortfall", {
      requestIdHash: hashRequestId(rid),
      uidHash: hashRequestId(id),
      outcome: result.outcome || finalOutcome,
      shortfallMilli: num(result.actualShortfallMilli),
    });
  }
  return result;
}

async function getShadowRecord({ uid, requestId } = {}, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const rid = cleanRequestId(requestId);
  if (!id) throw invalidRequest("missing uid/requestId");
  const snapDoc = await shadowRef(d.store, id, rid).get();
  if (!snapDoc.exists) return null;
  return snapDoc.data() || null;
}

// Recent shadow docs for one UID (newest-first is NOT guaranteed by the
// fake-friendly limit query; callers sort if ordering matters).
async function listShadowRecords({ uid, limit = 50 } = {}, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const snapDocs = await d.store.collection("creditAccounts").doc(id)
    .collection(SHADOW_SUBCOLLECTION).limit(n).get();
  return (snapDocs.docs || []).map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

// Global shadow telemetry for readiness analysis (Superadmin only via the
// admin route). Requires a collectionGroup-capable store (real Firestore).
async function fetchAllShadowRecords({ limit = 200 } = {}, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  if (typeof d.store.collectionGroup !== "function") {
    throw coded("shadow collectionGroup unavailable", "INTERNAL");
  }
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const snapDocs = await d.store.collectionGroup(SHADOW_SUBCOLLECTION).limit(n).get();
  return (snapDocs.docs || []).map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

// Pure readiness aggregation over shadow records. Counts only what the docs
// say; never touches wallets or the authoritative ledger.
function summarizeShadowRecords(records) {
  const list = Array.isArray(records) ? records : [];
  const summary = {
    requestCount: list.length,
    finalizedCount: 0,
    openCount: 0,
    totalEstimatedMilli: 0,
    totalActualMilli: 0,
    actualizedCount: 0,
    estimateVsActualDeltaMilli: 0,
    wouldBlockReservationCount: 0,
    wouldNotCoverActualCount: 0,
    insufficientUsers: [],
    freeModelCount: 0,
    paidModelCount: 0,
    unknownPricingCount: 0,
    byOutcome: {},
    byCostClass: {},
  };
  const insufficient = new Set();
  for (const rec of list) {
    const r = (rec && typeof rec === "object") ? rec : {};
    if (typeof r.finalizedAtMs === "number" || r.status === "finalized") {
      summary.finalizedCount += 1;
    } else {
      summary.openCount += 1;
    }
    summary.totalEstimatedMilli += num(r.estimatedReservationMilli);
    if (typeof r.actualChargeMilli === "number" && Number.isSafeInteger(r.actualChargeMilli)) {
      summary.totalActualMilli += r.actualChargeMilli;
      summary.actualizedCount += 1;
    }
    if (r.wouldBlockAtReservation === true) {
      summary.wouldBlockReservationCount += 1;
      if (typeof r.uid === "string" && r.uid) insufficient.add(r.uid);
    }
    if (r.wouldCoverActual === false) {
      summary.wouldNotCoverActualCount += 1;
      if (typeof r.uid === "string" && r.uid) insufficient.add(r.uid);
    }
    const snap = (r.pricingSnapshot && typeof r.pricingSnapshot === "object") ? r.pricingSnapshot : null;
    if (!snap || typeof snap.isFree !== "boolean") {
      summary.unknownPricingCount += 1;
    } else if (snap.isFree === true) {
      summary.freeModelCount += 1;
    } else {
      summary.paidModelCount += 1;
    }
    const outcome = typeof r.outcome === "string" && r.outcome ? r.outcome : "open";
    summary.byOutcome[outcome] = (summary.byOutcome[outcome] || 0) + 1;
    if (snap && typeof snap.costClass === "string" && snap.costClass) {
      summary.byCostClass[snap.costClass] = (summary.byCostClass[snap.costClass] || 0) + 1;
    }
  }
  summary.estimateVsActualDeltaMilli = summary.totalActualMilli - summary.totalEstimatedMilli;
  summary.insufficientUsers = [...insufficient].sort();
  return summary;
}

module.exports = {
  SHADOW_SUBCOLLECTION,
  MIN_FREE_CHARGE_MILLI,
  SHADOW_OUTCOMES,
  shouldShadow,
  buildWalletSnapshot,
  estimateReservationMilli,
  computeActualChargeMilli,
  sumUsage,
  shadowDocId: reservationDocId,
  startShadow,
  finalizeShadow,
  getShadowRecord,
  listShadowRecords,
  fetchAllShadowRecords,
  summarizeShadowRecords,
};
