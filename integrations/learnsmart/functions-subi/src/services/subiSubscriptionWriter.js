// functions-subi/src/services/subiSubscriptionWriter.js
// SOLE learnsmartDb WRITER in functions-subi (explicit boundary exception —
// see scripts/check-boundaries.js allowlist). Only the SUBI billing webhook
// path may activate/extend an individual SUBI subscription. Everything else
// in this codebase treats learnsmartDb as READ-ONLY.
//
// Writes, for accountType === "individual" ONLY (school users are refused
// before any write):
//   users/{uid}.subscription.subiCode = {
//     enabled: true, status: "active", product: "subi",
//     periodStartMs, periodEndMs, paidThroughMs, renewalDateMs,
//     lastPaymentOrderId, updatedAtMs,
//   }
//   users/{uid}/subiPayments/{orderId}: immutable application receipt
//   users/{uid}/subiPaidPeriods/{fundingStartMs}: paid economics snapshot
// Education status and renewal dates are independent and never written here.
// No tier is ever written. No credit amounts (cycles own their grants).
// No ledger/usage deletion on expiry (audit data is never erased).

const { learnsmartDb } = require("../db");
const { resolveSubiPaidPeriod } = require("./subiBillingPeriodService");
const { normalizeSubscription } = require('./learnsmartDirectoryService');
const { resolvePaidThroughMs } = require('./subiCodeEntitlementService');

function defaultDeps() {
  return { directoryDb: learnsmartDb };
}
function cleanId(v, max = 128) { return String(v || "").trim().slice(0, max); }
function invalidRequest(m) { const e = new Error(m || "invalid subscription payload"); e.code = "INVALID_REQUEST"; return e; }
function coded(m, c) { const e = new Error(m); e.code = c; return e; }
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

// Read the current SUBI billing period for period math (raw fields only).
async function readSubiPeriod(uid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  if (!id) throw invalidRequest("missing uid");
  const snap = await d.directoryDb.collection("users").doc(id).get();
  if (!snap.exists) return { exists: false, accountType: null, period: null };
  const data = snap.data() || {};
  const sub = (data.subscription && typeof data.subscription === "object") ? data.subscription : {};
  const code = (sub.subiCode && typeof sub.subiCode === "object") ? sub.subiCode : null;
  return {
    exists: true,
    accountType: typeof data.accountType === "string" ? data.accountType.trim().toLowerCase() : null,
    period: code ? {
      periodStartMs: num(code.periodStartMs),
      periodEndMs: num(code.periodEndMs),
      paidThroughMs: num(code.paidThroughMs ?? code.renewalDateMs),
      lastPaymentOrderId: typeof code.lastPaymentOrderId === "string" ? code.lastPaymentOrderId : null,
    } : null,
  };
}

// Persistent per-order receipts also prevent OLD callbacks from extending
// coverage again after a newer renewal. Period math runs in the same user
// transaction, so concurrent distinct payments extend consecutive months.
async function activateSubiSubscription({ uid, periodStartMs, periodEndMs, orderId, billingMonths, economicsSnapshot, configVersion, existingCycle, nowMs: clock }, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(uid);
  const oid = cleanId(orderId, 128);
  const start = num(periodStartMs);
  const end = num(periodEndMs);
  if (!id || !oid) throw invalidRequest("missing uid/orderId");
  if (billingMonths === undefined && (start === null || start <= 0 || end === null || end <= start)) {
    throw invalidRequest("paid period must satisfy start > 0 and end > start");
  }
  const ref = d.directoryDb.collection("users").doc(id);
  const receiptRef = ref.collection("subiPayments").doc(oid);
  return d.directoryDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const receipt = await tx.get(receiptRef);
    if (!snap.exists) throw coded("unknown user", "SUBI_UNKNOWN_USER");
    const data = snap.data() || {};
    const dirType = typeof data.accountType === "string" ? data.accountType.trim().toLowerCase() : null;
    // Never charge/activate a school account with the ₹499 SUBI product.
    if (dirType !== "individual") {
      throw coded("school accounts cannot buy individual subi", "SUBI_WRONG_ACCOUNT_TYPE");
    }
    const sub = (data.subscription && typeof data.subscription === "object") ? data.subscription : {};
    const code = (sub.subiCode && typeof sub.subiCode === "object") ? sub.subiCode : {};
    const nowMs = Number.isSafeInteger(clock) ? clock : Date.now();
    const normalized = normalizeSubscription(sub);
    const paidThrough = normalized?.subiCodeActive ? resolvePaidThroughMs(normalized) : null;
    const walletAnchor = existingCycle && Number.isSafeInteger(existingCycle.cycleStartedAtMs)
      && Number.isSafeInteger(existingCycle.cycleEndsAtMs) && existingCycle.cycleId
      && existingCycle.cycleStartedAtMs > 0 && existingCycle.cycleStartedAtMs <= nowMs
      && existingCycle.cycleEndsAtMs > nowMs && existingCycle.cycleEndsAtMs <= paidThrough
      ? existingCycle.cycleStartedAtMs : null;
    const previous = paidThrough ? {
      // Some pre-period entitlements stored only a renewal horizon. Preserve
      // paid time and an existing wallet's authoritative cycle anchor.
      periodStartMs: num(code.periodStartMs) || walletAnchor || Math.min(nowMs, paidThrough - 1),
      periodEndMs: num(code.periodEndMs),
      paidThroughMs: paidThrough,
      lastPaymentOrderId: typeof code.lastPaymentOrderId === "string" ? code.lastPaymentOrderId : null,
    } : null;
    if (receipt.exists || code.lastPaymentOrderId === oid) {
      // Duplicate retry: return the ALREADY-APPLIED period so callers reuse
      // the original paid extension instead of deriving a fresh one (which
      // would overstate coverage by another month). Deterministic per orderId.
      return {
        applied: false,
        previous,
        duplicate: true,
        appliedPeriod: receipt.exists ? receipt.data().appliedPeriod : {
          periodStartMs: num(code.periodStartMs),
          periodEndMs: num(code.periodEndMs),
          paidThroughMs: num(code.paidThroughMs ?? code.renewalDateMs),
        },
      };
    }
    const coverage = billingMonths === undefined ? { periodStartMs: start, periodEndMs: end }
      : resolveSubiPaidPeriod({ existing: previous, nowMs, billingMonths });
    const fundingStartMs = previous && previous.paidThroughMs > nowMs ? previous.paidThroughMs : coverage.periodStartMs;
    const appliedPeriod = { ...coverage, paidThroughMs: coverage.periodEndMs };
    const next = {
      enabled: true,
      status: "active",
      product: "subi",
      periodStartMs: coverage.periodStartMs,
      periodEndMs: coverage.periodEndMs,
      paidThroughMs: coverage.periodEndMs,
      renewalDateMs: coverage.periodEndMs,
      lastPaymentOrderId: oid,
      updatedAtMs: nowMs,
    };
    tx.set(ref, {
      subscription: {
        ...sub,
        subiCode: { ...code, ...next },
      },
      updatedAt: new Date(nowMs),
    }, { merge: true });
    tx.set(receiptRef, { orderId: oid, appliedPeriod, fundingStartMs, createdAtMs: nowMs });
    if (economicsSnapshot) tx.set(ref.collection("subiPaidPeriods").doc(String(fundingStartMs)), {
      orderId: oid, periodStartMs: fundingStartMs, periodEndMs: coverage.periodEndMs,
      economicsSnapshot, configVersion: configVersion || 1, createdAtMs: nowMs,
    });
    return { applied: true, previous, duplicate: false, appliedPeriod };
  });
}

async function readPaidEconomics(uid, periodStartMs, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const snap = await d.directoryDb.collection("users").doc(cleanId(uid)).collection("subiPaidPeriods").doc(String(periodStartMs)).get();
  return snap.exists ? snap.data().economicsSnapshot || null : null;
}

// A paid extension can start between legacy monthly boundaries. Look up
// the payment interval containing now, rather than assuming its document ID
// equals a reconstructed credit-cycle start. Both queries use bounded reads.
async function readPaidFundingWindow(uid, nowMs, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const collection = d.directoryDb.collection('users').doc(cleanId(uid)).collection('subiPaidPeriods');
  const [past, future] = await Promise.all([
    collection.where('periodStartMs', '<=', nowMs).orderBy('periodStartMs', 'desc').limit(1).get(),
    collection.where('periodStartMs', '>', nowMs).orderBy('periodStartMs', 'asc').limit(1).get(),
  ]);
  const candidate = past.docs[0]?.data();
  const next = future.docs[0]?.data();
  return {
    current: candidate && Number.isSafeInteger(candidate.periodStartMs) && Number.isSafeInteger(candidate.periodEndMs)
      && candidate.periodStartMs <= nowMs && nowMs < candidate.periodEndMs ? candidate : null,
    nextStartMs: Number.isSafeInteger(next?.periodStartMs) ? next.periodStartMs : null,
  };
}

module.exports = { readSubiPeriod, activateSubiSubscription, readPaidEconomics, readPaidFundingWindow };
