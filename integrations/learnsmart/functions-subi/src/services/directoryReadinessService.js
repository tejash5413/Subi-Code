// functions-subi/src/services/directoryReadinessService.js
// Read-only migration/readiness checks for LearnSmart directory profiles
// (migration/readiness ONLY — never loosens production auth).
//
// Production guards stay fail-closed:
//   normalizeAccountType(): "school" -> school, "individual" -> individual,
//   anything else -> null (ACCOUNT_TYPE_UNSUPPORTED downstream).
// This module only REPORTS readiness so operators can fix data explicitly.
// Never auto-repairs ambiguous users.
//
// Status codes:
//   READY                — usable on the managed runtime as-is.
//   MISSING_ACCOUNT_TYPE — accountType missing/blank/unknown (runtime: unsupported).
//   INVALID_ROLE         — role is not student/teacher (runtime: rejected).
//   INACTIVE             — status is not active (runtime: rejected).
//   MISSING_SCHOOL       — school account with no schoolId (runtime: invalid).
//   SCHOOL_ID_NOT_FOUND  — school account whose schoolId has no schools doc.
//
// BOUNDARY: pure functions only — no Firestore import, no writes.

const MANAGED_ROLES = new Set(["student", "teacher"]);

function cleanString(value, max = 128) {
  return String(value || "").trim().slice(0, max);
}

// profile: { status, role, accountType, schoolId } (already normalized or raw;
// role/accountType matching is case-insensitive, consistent with the runtime).
// schoolExists: boolean|null — whether schools/{schoolId} exists. Required
// only for school accounts; pass null/undefined when unchecked (treated as
// unknown -> SCHOOL_ID_NOT_FOUND only when a schoolId is present).
function checkUserReadiness(profile, schoolExists) {
  const p = profile && typeof profile === "object" ? profile : {};
  const status = cleanString(p.status, 32).toLowerCase();
  if (status !== "active") return "INACTIVE";
  const role = cleanString(p.role, 60).toLowerCase();
  if (!MANAGED_ROLES.has(role)) return "INVALID_ROLE";
  const accountType = cleanString(p.accountType, 32).toLowerCase();
  if (accountType !== "school" && accountType !== "individual") return "MISSING_ACCOUNT_TYPE";
  if (accountType === "individual") return "READY";
  const schoolId = cleanString(p.schoolId, 128);
  if (!schoolId) return "MISSING_SCHOOL";
  if (schoolExists !== true) return "SCHOOL_ID_NOT_FOUND";
  return "READY";
}

module.exports = { checkUserReadiness };
