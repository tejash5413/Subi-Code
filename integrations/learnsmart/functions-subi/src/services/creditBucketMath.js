// functions-subi/src/services/creditBucketMath.js
// Single authoritative credit-bucket arithmetic (individual ONLY).
// Schools NEVER use this module (token quota has no buckets).
//
// CONSUMPTION ORDER (authoritative, do not reorder without a migration):
//   rollover -> monthly -> topup
// Rollover expires first so it burns first; the current monthly grant keeps
// later usefulness; purchased top-up credits are protected last.
//
// All amounts are integer milliCredits (>= 0). All helpers are pure
// (no store, no Date, no Math.random) and return null on insufficient
// funds instead of producing negative balances.

function num(v) {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function readBuckets(src) {
  const s = (src && typeof src === "object") ? src : {};
  return {
    rollover: num(s.rolloverRemainingMilli),
    monthly: num(s.monthlyRemainingMilli),
    topup: num(s.topupRemainingMilli),
  };
}

// Deduct amountMilli from live balances in authoritative order.
// Returns { remaining:{rolloverMilli,monthlyMilli,topupMilli},
//           consumed:{rolloverMilli,monthlyMilli,topupMilli} }
// or null when the three buckets together cannot cover amountMilli.
function deductCreditsFromBuckets(balances, amountMilli) {
  const need = num(amountMilli);
  // Zero-amount deduction is a no-op that always succeeds (pure helper must
  // not reject it; callers validate chargeable minimums separately).
  const b = readBuckets(balances);
  let r = b.rollover;
  let m = b.monthly;
  let t = b.topup;
  let remaining = need;
  const useR = Math.min(r, remaining); remaining -= useR; r -= useR;
  const useM = Math.min(m, remaining); remaining -= useM; m -= useM;
  const useT = Math.min(t, remaining); remaining -= useT; t -= useT;
  if (remaining > 0) return null;
  return {
    remaining: { rolloverMilli: r, monthlyMilli: m, topupMilli: t },
    consumed: { rolloverMilli: useR, monthlyMilli: useM, topupMilli: useT },
  };
}

// Split an actual burn against a PREVIOUSLY RESERVED breakdown (same order).
// actualMilli is capped at the reserved total by the caller; values above
// the reserved total consume the whole reservation (extra handled separately).
// Returns { consumed:{...}, refund:{...} } where refund per bucket returns to
// the SAME bucket it was reserved from (never blindly to monthly).
function splitActualFromReserved(reservedBreakdown, actualMilli) {
  const rb = (reservedBreakdown && typeof reservedBreakdown === "object") ? reservedBreakdown : {};
  const rRes = num(rb.rolloverMilli);
  const mRes = num(rb.monthlyMilli);
  const tRes = num(rb.topupMilli);
  const total = rRes + mRes + tRes;
  let need = Math.min(num(actualMilli), total);
  const useR = Math.min(rRes, need); need -= useR;
  const useM = Math.min(mRes, need); need -= useM;
  const useT = Math.min(tRes, need); need -= useT;
  return {
    consumed: { rolloverMilli: useR, monthlyMilli: useM, topupMilli: useT },
    refund: {
      rolloverMilli: rRes - useR,
      monthlyMilli: mRes - useM,
      topupMilli: tRes - useT,
    },
  };
}

// Pure NON-MUTATING spend projection for shadow accounting (individual ONLY).
// Uses deductCreditsFromBuckets as the single spend-order implementation —
// the rollover -> monthly -> topup order is NOT duplicated here. Shadow mode
// calls this to answer "what WOULD enforcement have charged/blocked?" with
// zero DB mutation: inputs are plain milli numbers, output is a projection.
//
// availableBuckets: { rolloverMilli, monthlyMilli, topupMilli } (available,
//   i.e. already net of any authoritative reserved holds).
// requestedMilli: integer milliCredits the request would cost.
// Returns { rolloverMilli, monthlyMilli, topupMilli, coveredMilli,
//   shortfallMilli } where covered + shortfall == requested.
function planCreditSpend({ availableBuckets, requestedMilli } = {}) {
  const b = (availableBuckets && typeof availableBuckets === "object") ? availableBuckets : {};
  const balances = {
    rolloverRemainingMilli: num(b.rolloverMilli),
    monthlyRemainingMilli: num(b.monthlyMilli),
    topupRemainingMilli: num(b.topupMilli),
  };
  const need = num(requestedMilli);
  const total = balances.rolloverRemainingMilli
    + balances.monthlyRemainingMilli
    + balances.topupRemainingMilli;
  const covered = Math.min(need, total);
  // Single order implementation: deduct the coverable prefix in authoritative
  // order. Cannot return null here (covered <= total by construction; the
  // zero-need case yields an all-zero projection).
  const deducted = deductCreditsFromBuckets(balances, covered);
  const consumed = deducted
    ? deducted.consumed
    : { rolloverMilli: 0, monthlyMilli: 0, topupMilli: 0 };
  return {
    rolloverMilli: consumed.rolloverMilli,
    monthlyMilli: consumed.monthlyMilli,
    topupMilli: consumed.topupMilli,
    coveredMilli: covered,
    shortfallMilli: need - covered,
  };
}

module.exports = { deductCreditsFromBuckets, splitActualFromReserved, planCreditSpend };
