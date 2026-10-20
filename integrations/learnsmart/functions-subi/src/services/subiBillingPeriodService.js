// functions-subi/src/services/subiBillingPeriodService.js
// ONE authoritative SUBI paid-period resolver (individual-only).
// Calendaring matches the existing LearnSmart billing convention:
// calendar-month advance via Date.setMonth (+ whole months), no fixed 30-day
// blocks, no invented periods. Only whole billingMonths=1 is reachable today
// (checkout has no N-month option); the resolver still takes billingMonths so
// future multi-month support cannot silently grant N cycles upfront.
//
// Pure (no store, no Date.now inside the math — nowMs is an input).

const { BILLING_MONTHS } = require("./subiBillingConfig");

function invalidRequest(m) { const e = new Error(m || "invalid billing period"); e.code = "INVALID_REQUEST"; return e; }
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

// Add whole calendar months to an epoch-ms instant (setMonth convention,
// same as the existing purchase/webhook renewal math).
function addCalendarMonths(ms, months) {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

// Resolve the NEW paid coverage for a successful SUBI payment.
//   existing: { periodStartMs, paidThroughMs } | null (from subscription.subiCode)
//   nowMs: payment/verification time. billingMonths: whole months (1 today).
// First/expired purchase: coverage starts now (no resurrection of old cycles).
// Early renewal (paid-through in the future): coverage extends the existing
// paid-through with NO overlap and NO gap; the original start is preserved
// so the current credit cycle stays addressable.
// Resolve the CURRENT monthly credit-cycle sub-period inside paid-through
// coverage (lazy recovery entry point).
//   periodStartMs: anchored original paid start (preserved across renewals).
//   paidThroughMs: current coverage end (extends on early renewal).
//   nowMs: evaluation time.
// Returns { paidPeriodStartMs, paidPeriodEndMs } for the monthly sub-period
// containing nowMs: [anchor + k months, anchor + (k+1) months), truncated to
// paidThroughMs for a final partial month. Early prepaid future months never
// grant early; missed historical months never stack (caller creates only the
// returned current period; the cycle engine grants zero rollover on gaps).
// Throws INVALID_REQUEST when now precedes the anchor (future-paid),
// SUBI_PLAN_EXPIRED when now >= paidThroughMs.
function resolveCurrentCycleBounds({ periodStartMs, paidThroughMs, nowMs } = {}) {
  const start = num(periodStartMs);
  const paidThrough = num(paidThroughMs);
  const now = num(nowMs);
  if (start === null || start <= 0) throw invalidRequest("periodStartMs required");
  if (paidThrough === null || paidThrough <= start) throw invalidRequest("paidThroughMs must exceed start");
  if (now === null || now <= 0) throw invalidRequest("nowMs required");
  if (now < Math.floor(start)) throw invalidRequest("paid period has not started");
  if (now >= paidThrough) {
    const e = new Error("subscription period ended");
    e.code = "SUBI_PLAN_EXPIRED";
    throw e;
  }
  let curStart = Math.floor(start);
  for (let i = 0; i < 120; i += 1) {
    let curEnd = addCalendarMonths(curStart, 1);
    if (!Number.isFinite(curEnd) || curEnd <= curStart) throw invalidRequest("period math overflow");
    curEnd = Math.floor(curEnd);
    if (curEnd > Math.floor(paidThrough)) curEnd = Math.floor(paidThrough);
    if (now < curEnd) {
      return { paidPeriodStartMs: curStart, paidPeriodEndMs: curEnd };
    }
    if (curEnd >= Math.floor(paidThrough)) {
      const e = new Error("subscription period ended");
      e.code = "SUBI_PLAN_EXPIRED";
      throw e;
    }
    curStart = curEnd;
  }
  throw invalidRequest("paid period exceeds supported range");
}

function resolveSubiPaidPeriod({ existing, nowMs, billingMonths = BILLING_MONTHS } = {}) {
  const now = num(nowMs);
  if (now === null || now <= 0) throw invalidRequest("nowMs required");
  const months = Math.floor(Number(billingMonths));
  if (!Number.isSafeInteger(months) || months < 1 || months > 60) {
    throw invalidRequest("billingMonths must be 1..60");
  }
  const prevEnd = existing && num(existing.paidThroughMs);
  const prevStart = existing && num(existing.periodStartMs);
  if (prevEnd !== null && prevEnd > now) {
    if (prevStart === null || prevStart <= 0 || prevStart >= prevEnd) {
      throw invalidRequest("existing paid period is malformed");
    }
    return { periodStartMs: prevStart, periodEndMs: addCalendarMonths(prevEnd, months), extended: true };
  }
  return { periodStartMs: Math.floor(now), periodEndMs: addCalendarMonths(Math.floor(now), months), extended: false };
}

// The credit-cycle bounds for "now": the paid period containing nowMs.
// First/expired purchase → the fresh coverage itself. Early renewal → the
// still-running previous period (current cycle keeps running; the new money
// only extends paid-through, it never grants a second monthly allowance).
function resolveCycleBoundsForNow({ previous, coverage, nowMs } = {}) {
  const now = num(nowMs);
  if (now === null || now <= 0) throw invalidRequest("nowMs required");
  if (!coverage || num(coverage.periodStartMs) === null || num(coverage.periodEndMs) === null) {
    throw invalidRequest("coverage period required");
  }
  const prevEnd = previous && num(previous.paidThroughMs);
  const prevStart = previous && num(previous.periodStartMs);
  if (prevEnd !== null && now < prevEnd && prevStart !== null && prevStart < prevEnd) {
    return { paidPeriodStartMs: prevStart, paidPeriodEndMs: prevEnd };
  }
  return { paidPeriodStartMs: coverage.periodStartMs, paidPeriodEndMs: coverage.periodEndMs };
}

module.exports = { addCalendarMonths, resolveSubiPaidPeriod, resolveCycleBoundsForNow, resolveCurrentCycleBounds };
