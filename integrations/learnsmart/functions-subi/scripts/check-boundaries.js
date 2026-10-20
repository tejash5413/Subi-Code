// scripts/check-boundaries.js — static database-boundary gate (Phase 2A).
// Fails if learnsmartDb leaks outside its allowed files, or if any write
// pattern targets learnsmartDb. Predefined Firestore IAM is project-scoped,
// so this scan (not IAM) is the (default)-read-only guarantee.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "src");
const ALLOWED_LEARNSMART_FILES = new Set([
  "db.js",
  path.join("services", "learnsmartDirectoryService.js"),
  path.join("middleware", "auth.js"),
  // Sole learnsmartDb WRITER: individual SUBI subscription activation by the
  // billing webhook path only (reviewed exception; everything else stays
  // read-only and the write-pattern rules below still apply to all files).
  path.join("services", "subiSubscriptionWriter.js"),
]);
const WRITE_PATTERNS = [
  /learnsmartDb\s*\.\s*(set|update|delete|add|create)\s*\(/,
  /learnsmartDb\s*\.\s*runTransaction\s*\(/,
  /learnsmartDb\s*\.\s*batch\s*\(/,
  /learnsmartDb\s*\.\s*bulkWriter\s*\(/,
];

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

let failures = [];
for (const file of files(ROOT)) {
  const rel = path.relative(ROOT, file);
  const src = stripComments(fs.readFileSync(file, "utf8"));
  if (/child_process|node-pty|\b(?:spawn|exec|execSync)\s*\(/.test(src)) failures.push(rel + ': backend process execution is forbidden');
  if (src.includes("learnsmartDb") && !ALLOWED_LEARNSMART_FILES.has(rel)) {
    failures.push(`${rel}: imports/uses learnsmartDb (not allowlisted)`);
  }
  for (const re of WRITE_PATTERNS) {
    if (re.test(src)) failures.push(`${rel}: learnsmartDb write pattern ${re}`);
  }
  if (/\badmin\s*\.\s*firestore\s*\(/.test(src)) {
    failures.push(`${rel}: uses admin.firestore() (must use getFirestore with explicit DB)`);
  }
  if (/from\s+["']\.\.\/functions["']|require\(["']\.\.\/functions|chatHandler|apiV2/.test(src)) {
    failures.push(`${rel}: references legacy functions stack`);
  }
  // managedOnly must be route-scoped (managedAccess/managedModels), never
  // app-level: an app.use managedOnly chain rejects superadmins for every
  // path, including the superadmin catalogue route.
  if (rel === "app.js" && /managedOnly/.test(src)) {
    failures.push(`${rel}: app-level managedOnly gate (must be route-scoped)`);
  }
  // Phase 8 separation: the chat service implements no policy itself —
  // Access/model/limit/usage authorities stay injected or route-side.
  // Phase 13: same separation for the agent service.
  if (rel === path.join("services", "managedChatService.js") || rel === path.join("services", "managedAgentService.js")) {
    for (const re of [
      /accessService/,
      /monthlyLimitService/,
      /usageService/,
      /modelPolicyService/,
      /approvedModelService/,
      /secretService/,
    ]) {
      if (re.test(src)) failures.push(`${rel}: chat service must not implement policy ${re}`);
    }
  }
  // Phase 8 separation: the chat route never touches secrets or the
  // upstream; key resolution + provider call live in the service.
  // Phase 13: same for the agent route.
  if (rel === path.join("routes", "managedChat.js") || rel === path.join("routes", "managedAgent.js")) {
    for (const re of [/secretService/, /aiConnectionService/, /openrouter\.ai/, /resolveActiveManagedKey/]) {
      if (re.test(src)) failures.push(`${rel}: chat route must not touch secrets/upstream ${re}`);
    }
  }
}
if (failures.length) {
  console.error("boundary check FAILED:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("boundary check OK");
