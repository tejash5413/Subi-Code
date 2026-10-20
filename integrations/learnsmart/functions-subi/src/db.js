// functions-subi/src/db.js
// Two-database Admin initialization (Phase 1A foundation).
//
// DATABASE BOUNDARY (must stay explicit):
// - learnsmartDb = existing LearnSmart `(default)` database.
//   Directory/identity source of truth. READ ONLY by architecture.
//   Only learnsmartDirectoryService.js may use it.
// - subiDb = NEW dedicated `subi` named database.
//   All future SUBI policy/quota/usage/audit data lives here.
//   Only SUBI repositories (policyService, future quota/usage/audit) may use it.
//
// Never export a generic `db`. Never use admin.firestore() here or anywhere
// in functions-subi (it silently targets `(default)` and risks cross-DB writes).

const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");

if (!admin.apps.length) {
  admin.initializeApp();
}

// Existing LearnSmart system — reference reads only.
const learnsmartDb = getFirestore(admin.app());

// New SUBI Managed AI database — all managed data.
const subiDb = getFirestore(admin.app(), "subi");

module.exports = { admin, learnsmartDb, subiDb };
