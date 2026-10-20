const { createHash } = require('crypto');

/** Preserve every deployed short identity; hash the entire overlong tuple with a version prefix. */
function accountingRequestId(clientRunId, providerRequestIndex) {
  if (typeof clientRunId !== 'string' || !clientRunId || !Number.isSafeInteger(providerRequestIndex) || providerRequestIndex < 0) throw new Error('Invalid accounting identity');
  const legacy = `${clientRunId}:${providerRequestIndex}`;
  return legacy.length <= 64 ? legacy : `j1_${createHash('sha256').update(legacy).digest('base64url')}`;
}
function accountingPeriod(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 7);
}
module.exports = { accountingRequestId, accountingPeriod };
