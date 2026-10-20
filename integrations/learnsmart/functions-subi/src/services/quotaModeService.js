// functions-subi/src/services/quotaModeService.js
// Phase 1 foundation (NO behavior change yet — not wired into routes).
// Authoritative account-type routing for dual quota systems:
//
//   directory.accountType == "school"     -> "school_tokens" (monthlyLimitService + usageQuotaService tokens)
//   directory.accountType == "individual"  -> "individual_credits" (new credit wallet/ledger)
//
// BOUNDARY: pure decision only. Callers must pass the trusted directory
// profile (from learnsmartDirectoryService.getUserProfile via requireAuth).
// Never accepts quotaMode/accountType/schoolId/role from client bodies.
//
// DI: none (pure). Fail closed on unknown/missing.

function normalizeAccountType(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveQuotaMode(directoryUser) {
  const kind = normalizeAccountType(directoryUser && directoryUser.accountType);
  if (kind === "school") return "school_tokens";
  if (kind === "individual") return "individual_credits";
  // Fail closed: unknown/missing account type never coerces to school.
  // Callers must surface this code (403) and reach neither provider nor quota.
  const err = new Error("unsupported account type for quota routing");
  err.code = "ACCOUNT_TYPE_UNSUPPORTED";
  throw err;
}

function isSchoolQuotaMode(mode) {
  return mode === "school_tokens";
}

function isIndividualQuotaMode(mode) {
  return mode === "individual_credits";
}

module.exports = {
  resolveQuotaMode,
  isSchoolQuotaMode,
  isIndividualQuotaMode,
  normalizeAccountType,
};
