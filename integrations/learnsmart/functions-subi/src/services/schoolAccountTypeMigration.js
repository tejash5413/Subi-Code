// functions-subi/src/services/schoolAccountTypeMigration.js
// One-time legacy directory migration helper (migration/readiness ONLY).
//
// Problem: functions-subi admin school guards require
//   schools/{schoolId}.accountType === "school"
// but school docs created by older website flows may carry no accountType.
// Those schools return INVALID_REQUEST on:
//   GET/POST /admin/schools/:id/subi-access
//   GET/POST /admin/schools/:id/models
//   GET/POST /admin/schools/:id/monthly-limits
//
// The runtime guard MUST stay fail-closed (never infer school). This module
// only CLASSIFIES existing school docs for an explicit, operator-approved
// backfill (scripts/backfill-school-account-type.js, --apply required).
// Never touches users. Never runs automatically.
//
// BOUNDARY: pure functions only — no Firestore import, no writes. The runner
// script (outside src/) performs reads/writes with admin credentials.

function cleanString(value, max = 32) {
  return String(value || "").trim().slice(0, max);
}

// Classify one existing schools/{id} doc snapshot (plain data object).
// Returns one of:
//   "update_to_school" — accountType missing/null/blank; safe backfill candidate.
//   "already_correct"   — accountType is already "school" (case-insensitive); no-op.
//   "conflict"          — accountType is explicitly "individual" or another
//                         non-empty value; MUST NOT overwrite, needs review.
function classifySchoolDoc(data, docId = '') {
  const raw = data && typeof data === "object" ? data.accountType : undefined;
  const kind = cleanString(raw, 32).toLowerCase();
  if (kind === "") return /^individual_/i.test(String(docId)) ? 'conflict' : 'update_to_school';
  if (kind === "school") return "already_correct";
  return "conflict";
}

// Summarize a list of {id, data} school docs. IDs only are echoed back
// (caller redacts display names/other fields when printing).
// Returns { total, alreadyCorrect, missing, conflicts, wouldUpdate,
//           updateIds, conflictIds } with ID lists capped for safe printing.
function summarizeSchoolDocs(docs, maxListedIds = 50) {
  const list = Array.isArray(docs) ? docs : [];
  const cap = Number.isSafeInteger(maxListedIds) && maxListedIds > 0 ? maxListedIds : 50;
  const updateIds = [];
  const conflictIds = [];
  let alreadyCorrect = 0;
  let missing = 0;
  let conflicts = 0;
  for (const entry of list) {
    const id = entry && typeof entry.id === "string" ? entry.id : "";
    const action = classifySchoolDoc(entry && entry.data, id);
    if (action === "already_correct") {
      alreadyCorrect += 1;
    } else if (action === "update_to_school") {
      missing += 1;
      if (updateIds.length < cap) updateIds.push(id);
    } else {
      conflicts += 1;
      if (conflictIds.length < cap) conflictIds.push(id);
    }
  }
  return {
    total: list.length,
    alreadyCorrect,
    missing,
    conflicts,
    wouldUpdate: missing,
    updateIds,
    conflictIds,
    truncated: missing > updateIds.length || conflicts > conflictIds.length,
  };
}

module.exports = { classifySchoolDoc, summarizeSchoolDocs };
