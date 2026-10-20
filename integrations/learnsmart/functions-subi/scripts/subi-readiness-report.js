// Read-only directory/config readiness. Never creates, repairs or migrates
// documents; prints counts/config only, never IDs/emails/tokens.
const { learnsmartDb, subiDb } = require('../src/db');
const { getFxRate } = require('../src/services/fxRateService');
const { getEconomicsConfig } = require('../src/services/individualCreditEconomicsConfig');
const { monthlyGrantCredits } = require('../src/services/individualCreditEconomics');
const { normalizeSubscription } = require('../src/services/learnsmartDirectoryService');
const { resolvePaidThroughMs } = require('../src/services/subiCodeEntitlementService');
const { getIndividualCreditFlags } = require('../src/services/individualCreditFlags');
const { classifySchoolDoc } = require('../src/services/schoolAccountTypeMigration');
async function countPages(db, collection, visit) {
  let cursor;
  let count = 0;
  for (;;) {
    let query = db.collection(collection).orderBy('__name__').limit(250);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) { visit(doc.data() || {}, doc.id); count++; }
    if (page.docs.length < 250) return count;
    cursor = page.docs[page.docs.length - 1];
  }
}
async function main() {
  const schoolCounts = { total: 0, missingAccountType: 0, conflicts: 0, migrationCandidates: 0, migrationConflicts: 0 };
  const validSchools = new Set();
  const userCounts = { total: 0, schoolMalformed: 0, individualMalformed: 0, unsupportedAccountType: 0, individualMissingPaidPeriod: 0 };
  schoolCounts.total = await countPages(learnsmartDb, 'schools', (row, id) => {
    const action = classifySchoolDoc(row, id);
    if (action === 'update_to_school') schoolCounts.migrationCandidates++;
    if (action === 'conflict') schoolCounts.migrationConflicts++;
    if (row.accountType === 'school') validSchools.add(id);
    if (row.accountType === undefined || row.accountType === null || row.accountType === '') schoolCounts.missingAccountType++;
    else if (row.accountType !== 'school' && row.accountType !== 'individual') schoolCounts.conflicts++;
  });
  userCounts.total = await countPages(learnsmartDb, 'users', row => {
    if (!['student', 'teacher'].includes(row.role)) return;
    const malformed = row.status !== 'active' || !['student', 'teacher'].includes(row.role);
    if (row.accountType === 'school') { if (malformed || !validSchools.has(row.schoolId)) userCounts.schoolMalformed++; }
    else if (row.accountType === 'individual') {
      if (malformed) userCounts.individualMalformed++;
      const sub = normalizeSubscription(row.subscription);
      if (sub?.subiCodeActive === true && (!(sub.periodStartMs > 0) || !(resolvePaidThroughMs(sub) > sub.periodStartMs))) userCounts.individualMissingPaidPeriod++;
    }
    else userCounts.unsupportedAccountType++;
  });
  const access = await subiDb.collection('systemConfig').doc('subiAccess').get();
  const fxDocument = await subiDb.collection('fxRates').doc('USD_INR').get();
  const fx = await getFxRate();
  const economics = await getEconomicsConfig();
  let approvedCount = 0; let enabledToolCallingCount = 0; let terminalVerifiedCount = 0; let verifyVerifiedCount = 0;
  await countPages(subiDb, 'approvedModels', row => { approvedCount++; if (row.enabled === true && row.capabilities?.toolCalling === true) enabledToolCallingCount++;
    if (row.capabilities?.agentTerminal === 'verified') terminalVerifiedCount++; if (row.capabilities?.agentVerify === 'verified') verifyVerifiedCount++; });
  const flags = await getIndividualCreditFlags();
  let previewGrant = null;
  if (fx) previewGrant = monthlyGrantCredits({ fxRate: fx.rate, ...economics }).monthlyGrant;
  console.log(JSON.stringify({ databases: { directory: '(default)', managed: 'subi' }, schools: schoolCounts, users: userCounts,
    managed: { globalAccessExists: access.exists, fxExists: fxDocument.exists, fxValid: fx !== null,
      effectiveFx: fx?.rate ?? null, economics: { priceINR: economics.priceINR, bufferINR: economics.bufferINR, providerFundingMultiplier: economics.providerFundingMultiplier, rolloverPct: economics.rolloverPct, topupMarginPct: economics.topupMarginPct },
      previewMonthlyGrant: previewGrant, approvedCount, enabledToolCallingCount, terminalVerifiedCount, verifyVerifiedCount,
      flags: { shadowEnabled: flags.shadowEnabled, shadowTestUidCount: flags.shadowTestUids.length, enforcementEnabled: flags.enforcementEnabled, billingEnabled: flags.billingEnabled, topupsEnabled: flags.topupsEnabled } } }, null, 2));
}
if (require.main === module) main().catch(() => { console.error('Read-only readiness unavailable. Check runtime read permissions.'); process.exitCode = 1; });
module.exports = { countPages, main };
