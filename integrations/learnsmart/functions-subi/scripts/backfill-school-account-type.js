// scripts/backfill-school-account-type.js — legacy school accountType backfill.
//
// DEFAULT MODE IS DRY RUN (read-only). Nothing is written unless --apply is
// passed explicitly on the command line.
//
// Reads the DEFAULT (LearnSmart) database `schools` collection and classifies
// each doc via src/services/schoolAccountTypeMigration.js:
//   missing/null/blank accountType -> candidate, set accountType:"school"
//   already "school"                -> no-op
//   explicitly "individual"/other   -> CONFLICT, never overwritten
//
// Never touches users. Never infers anything else. Prints counts plus doc
// IDs only (no names, emails, or other PII).
//
// Usage (from functions-subi/, with Google ADC / service-account env):
//   node scripts/backfill-school-account-type.js            # dry run only
//   node scripts/backfill-school-account-type.js --apply    # explicit migration
/* eslint-disable no-console */
const admin = require("firebase-admin");
const { summarizeSchoolDocs } = require("../src/services/schoolAccountTypeMigration");

const APPLY = process.argv.includes("--apply");
const redactedIds = ids => ids.map(id => require("node:crypto").createHash("sha256").update(String(id)).digest("hex").slice(0, 12));

function getDefaultDb() {
  if (admin.apps.length === 0) {
    admin.initializeApp();
  }
  return admin.firestore();
}

async function main() {
  const db = getDefaultDb();
  const snap = await db.collection("schools").get();
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  const summary = summarizeSchoolDocs(docs);

  console.log("school accountType backfill — " + (APPLY ? "APPLY MODE" : "DRY RUN (no writes)"));
  console.log(JSON.stringify({
    total: summary.total,
    alreadyCorrect: summary.alreadyCorrect,
    missing: summary.missing,
    conflicts: summary.conflicts,
    wouldUpdate: APPLY ? 0 : summary.wouldUpdate,
  }));
  if (summary.updateIds.length > 0) {
    console.log("would-update ids: " + JSON.stringify(redactedIds(summary.updateIds)));
  }
  if (summary.conflictIds.length > 0) {
    console.log("conflict ids (needs review, never auto-written): " + JSON.stringify(redactedIds(summary.conflictIds)));
  }
  if (summary.truncated) {
    console.log("id lists truncated at 50 entries; counts above are complete.");
  }

  if (!APPLY) {
    console.log("dry run complete — re-run with --apply to migrate.");
    return;
  }
  if (summary.missing === 0) {
    console.log("nothing to update.");
    return;
  }
  let updated = 0;
  for (const doc of docs) {
    const { classifySchoolDoc } = require("../src/services/schoolAccountTypeMigration");
    if (classifySchoolDoc(doc.data, doc.id) !== "update_to_school") continue;
    // Belt-and-braces re-check inside the write path: only merge the single
    // field onto docs that still lack it.
    const ref = db.collection("schools").doc(doc.id);
    const fresh = await ref.get();
    if (!fresh.exists) continue;
    const current = (fresh.data() || {}).accountType;
    if (typeof current === "string" && current.trim() !== "") continue;
    await ref.set({ accountType: "school" }, { merge: true });
    updated += 1;
  }
  console.log("migration complete — updated: " + updated);
}

main().catch((err) => {
  console.error("backfill failed: check database credentials and permissions.");
  process.exitCode = 1;
});
