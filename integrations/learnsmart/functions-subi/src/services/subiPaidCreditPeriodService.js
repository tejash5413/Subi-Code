// Shared payment-backed cycle selection for settlement and normal readiness.
// Grant math stays in the cycle engine. Directory access stays in its adapter.
const { resolveCurrentCycleBounds } = require('./subiBillingPeriodService');
const { readPaidFundingWindow } = require('./subiSubscriptionWriter');
const { getCreditAccount } = require('./individualCreditAccountService');

async function resolvePaidCreditCycle({ uid, periodStartMs, paidThroughMs, nowMs }, deps = {}) {
  const window = await (deps.readFundingWindow || readPaidFundingWindow)(uid, nowMs,
    deps.directoryDb ? { directoryDb: deps.directoryDb } : undefined);
  const funding = window.current;
  const start = funding ? funding.periodStartMs : periodStartMs;
  const end = Math.min(paidThroughMs, funding ? funding.periodEndMs : window.nextStartMs || paidThroughMs);
  let bounds = resolveCurrentCycleBounds({ periodStartMs: start, paidThroughMs: end, nowMs });
  const wallet = await getCreditAccount(uid, { store: deps.store });
  // Preserve a live historical allowance on refresh; renewing never mints
  // the same allowance again under a newly synthesized legacy anchor.
  if (wallet?.cycleId && wallet.cycleStartedAtMs >= start && wallet.cycleStartedAtMs <= nowMs
    && wallet.cycleEndsAtMs > nowMs && wallet.cycleEndsAtMs <= end) {
    bounds = { paidPeriodStartMs: wallet.cycleStartedAtMs, paidPeriodEndMs: wallet.cycleEndsAtMs };
  }
  return { ...bounds, economics: funding?.economicsSnapshot || undefined };
}

module.exports = { resolvePaidCreditCycle };
