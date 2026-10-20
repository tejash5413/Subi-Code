// functions-subi/src/services/policyService.js
// Minimal PolicyService foundation using ONLY subiDb (Phase 1A).
//
// BOUNDARY: this module may import ONLY subiDb. It must never import
// learnsmartDb and never read from or write to the `(default)` database.

const { subiDb } = require("../db");

function cleanId(value) {
  return String(value || "").trim().slice(0, 128);
}

// Safe foundation read. Returns the school policy doc or null when none
// exists. Phase 1 never auto-creates default policies.
async function getSchoolPolicy(schoolId) {
  const id = cleanId(schoolId);
  if (!id) throw new Error("getSchoolPolicy: missing schoolId");
  const snap = await subiDb.collection("schoolPolicies").doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

module.exports = { getSchoolPolicy };
