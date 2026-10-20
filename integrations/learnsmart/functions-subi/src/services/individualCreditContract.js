// One safe projection for managed balances and the admin wallet view.
function toCreditSnapshot(account) {
  if (!account) return null;
  return {
    monthlyGrantMilli: account.monthlyGrantCreditsMilli,
    monthlyRemainingMilli: account.monthlyRemainingCreditsMilli,
    rolloverRemainingMilli: account.rolloverRemainingCreditsMilli,
    topupRemainingMilli: account.topupRemainingCreditsMilli,
    reservedMilli: account.reservedCreditsMilli,
    totalAvailableMilli: account.monthlyRemainingCreditsMilli + account.rolloverRemainingCreditsMilli + account.topupRemainingCreditsMilli,
    cycleId: account.cycleId,
    cycleEndsAtMs: account.cycleEndsAtMs,
  };
}
module.exports = { toCreditSnapshot };
