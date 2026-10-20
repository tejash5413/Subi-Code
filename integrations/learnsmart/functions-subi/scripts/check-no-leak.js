// scripts/check-no-leak.js — static secret-leak gate (Phase 2A).
// Fails on patterns that could log, persist, or return key material.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "src");
const RULES = [
  [/console\s*\.\s*(log|error|warn|info)\s*\([^)]*apiKey/i, "logs apiKey"],
  [/res\s*\.\s*json\s*\([^)]*apiKey/i, "serializes apiKey to response"],
  [/\.add\s*\([^)]*apiKey/i, "persists apiKey to Firestore"],
  [/\.set\s*\([^)]*apiKey/i, "persists apiKey to Firestore"],
  [/process\.env\.\s*SUBI_OPENROUTER_API_KEY|process\.env\[["']SUBI_OPENROUTER_API_KEY/, "reads key from env (must use Secret Manager)"],
  [/Authorization["']?\s*:\s*[^,}\n]*\+|Bearer\s*"\s*\+/, "builds Authorization header outside validator"],
];

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const ALLOW = new Map([
  // file -> allowed rule indexes (documented exceptions)
  ["services/keyValidator.js", [5]], // validator is the single place building the auth header
  ["services/secretService.js", []],
  ["services/managedChatService.js", [5]], // chat gateway builds Bearer from the resolved Buffer, then wipes it
  ["services/managedAgentService.js", [5]], // agent gateway builds Bearer from the resolved Buffer, then wipes it
  ["services/modelCatalogService.js", [5]], // catalogue builds Bearer from the resolved Buffer, then wipes it
]);
let failures = [];
function referencesUpstreamChat(source) {
  // The native client's exact local route is not an upstream provider URL.
  // Keep rejecting every other occurrence, including full URLs using this path.
  return /chat\/completions/.test(source.replace(/(["'])\/agent\/chat\/completions\1/g, '""'));
}
for (const file of files(ROOT)) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, "utf8");
  RULES.forEach(([re, msg], i) => {
    if (re.test(src) && !(ALLOW.get(rel) || []).includes(i)) {
      failures.push(`${rel}: ${msg}`);
    }
  });
}
// accessVersion result must never reach res.json in routes
const routes = fs.readFileSync(path.join(ROOT, "routes", "adminAiConnection.js"), "utf8");
if (/accessVersion/.test(routes)) failures.push("routes/adminAiConnection.js: references accessVersion");
// Phase 3A: access-control code must be independent of AI Connection secrets
for (const rel of [
  path.join("services", "accessService.js"),
  path.join("routes", "managedAccess.js"),
  path.join("routes", "adminAccess.js"),
  path.join("routes", "adminUsers.js"),
  path.join("services", "approvedModelService.js"),
  path.join("services", "monthlyLimitService.js"),
  path.join("services", "modelPolicyService.js"),
  path.join("services", "usageService.js"),
  path.join("services", "usageQuotaService.js"),
  path.join("services", "usagePeriod.js"),
  path.join("routes", "managedUsage.js"),
  path.join("services", "modelPolicyReadinessService.js"),
  path.join("routes", "adminReadiness.js"),
  path.join("services", "managedChatConfigService.js"),
  path.join("routes", "adminManagedChatConfig.js"),
  path.join("routes", "adminModels.js"),
  path.join("routes", "adminModelPolicies.js"),
  path.join("routes", "adminUsage.js"),
  path.join("routes", "adminLimits.js"),
  path.join("routes", "managedLimits.js"),
  path.join("routes", "managedModels.js"),
  path.join("services", "effectiveModelService.js"),
  // Phase 8 chat route: preflights + SSE framing only. Key resolution and
  // the upstream call live in managedChatService.js, never here.
  // Phase 13 agent route: same separation via managedAgentService.js.
  path.join("routes", "managedChat.js"),
  path.join("routes", "managedAgent.js"),
  path.join("services", "managedAgentConfigService.js"),
  path.join("routes", "adminManagedAgentConfig.js"),
]) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  for (const re of [
    /secretService/,
    /aiConnectionService/,
    /SUBI_OPENROUTER_API_KEY/,
    /OPENROUTER_API_KEY/,
    /openrouter\.ai/,
    /resolveActiveManagedKey/,
  ]) {
    // modelCatalogService is the single allowed key-resolution + upstream caller.
    if (rel === path.join("services", "modelCatalogService.js")) continue;
    if (re.test(code)) failures.push(`${rel}: forbidden AI-connection dependency ${re}`);
  }
  // upstreamModelId is admin/server configuration: allowed in the catalogue
  // service and admin approved-model paths, but NEVER in the normal-user
  // managed-models route.
  if (rel === path.join("routes", "managedModels.js") && /upstreamModelId/.test(code)) {
    failures.push(`${rel}: normal-user route references upstreamModelId`);
  }
  // Phase 8 chat route holds upstreamModelId in backend memory only. It
  // must never reach a response writer. Phase 13: same for agent route.
  if (rel === path.join("routes", "managedChat.js") || rel === path.join("routes", "managedAgent.js")) {
    for (const line of code.split("\n")) {
      if (/upstreamModelId/.test(line) && /writeEvent|res\.json|JSON\.stringify/.test(line)) {
        failures.push(`${rel}: upstreamModelId reaches response writer: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  // Phase 5 anti-aggregate-pool gate: school values are per-user defaults,
  // never a shared/decrementing balance. Ban pool-like field names.
  const AGGREGATE_PATTERNS = [
    /schoolMonthlyTokenPool/,
    /studentTokenPool/,
    /teacherTokenPool/,
    /studentSharedTokens/,
    /teacherSharedTokens/,
    /remainingSchoolTokens/,
    /schoolTokenBalance/,
    /totalMonthlyTokens/,
    /sharedMonthlyTokens/,
  ];
  for (const rel of [
    path.join("services", "monthlyLimitService.js"),
    path.join("routes", "adminLimits.js"),
    path.join("routes", "managedLimits.js"),
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const re of AGGREGATE_PATTERNS) {
      if (re.test(src)) failures.push(`${rel}: forbidden aggregate-pool field ${re}`);
    }
    // Phase 5 must not fabricate usage accounting.
    for (const re of [/usedTokens/, /remainingTokens/, /consumedTokens/]) {
      if (re.test(src)) failures.push(`${rel}: forbidden usage-accounting field ${re}`);
    }
  }
  // Usage accounting lives ONLY in usageService.js (counters) + adminUsage.js
  // (reads). Counters only — never prompt/completion/message text.
  for (const rel of [
    path.join("services", "usageService.js"),
    path.join("routes", "adminUsage.js"),
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const re of [/promptText/, /completionText/, /messageContent/, /transcript/, /\.add\s*\([^)]*prompt/i, /\.set\s*\([^)]*messages/i]) {
      if (re.test(src)) failures.push(`${rel}: forbidden message-text persistence ${re}`);
    }
  }
  // Phase 8: the OpenRouter chat URL lives ONLY in managedChatService.js
  // and (Phase 13) managedAgentService.js.
  for (const file of files(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join("services", "managedChatService.js")) continue;
    if (rel === path.join("services", "managedAgentService.js")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (referencesUpstreamChat(src)) {
      failures.push(`${rel}: references OpenRouter chat URL outside managedChatService.js`);
    }
  }
  // Phase 9A: legacy recordUsage stays unwired (single quota finalization
  // path only). Definition + export inside usageService.js are the only
  // allowed matches; quota writes go through usageQuotaService instead.
  for (const file of files(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join("services", "usageService.js")) continue;
    const src = fs.readFileSync(file, "utf8");
    if (/recordUsage\s*\(\s*\{/.test(src)) {
      failures.push(`${rel}: legacy recordUsage must stay unwired (use usageQuotaService)`);
    }
  }
  // Phase 9A: quota/accounting files persist counters only — never message
  // text, prompts, or completions. Phase 9A.1: chat config files carry mode
  // + test UIDs only — never secrets or message content. Phase 13: same for
  // agent config/route.
  for (const rel of [
    path.join("services", "usageQuotaService.js"),
    path.join("services", "usageService.js"),
    path.join("services", "usagePeriod.js"),
    path.join("routes", "managedUsage.js"),
    path.join("routes", "managedChat.js"),
    path.join("services", "managedChatConfigService.js"),
    path.join("routes", "adminManagedChatConfig.js"),
    path.join("routes", "managedAgent.js"),
    path.join("services", "managedAgentConfigService.js"),
    path.join("routes", "adminManagedAgentConfig.js"),
    path.join("services", "managedAgentValidator.js"),
    path.join("services", "managedAgentService.js"),
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const re of [/promptText/, /completionText/, /messageContent/, /transcript/, /\.add\s*\([^)]*prompt/i, /\.set\s*\([^)]*messages/i]) {
      if (re.test(src)) failures.push(`${rel}: forbidden message-text persistence ${re}`);
    }
  }
  // Phase 9A: no upstreamModelId in usage/reservation documents or the
  // managed usage response path.
  for (const rel of [
    path.join("services", "usageQuotaService.js"),
    path.join("routes", "managedUsage.js"),
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    if (/upstreamModelId/.test(code)) {
      failures.push(`${rel}: usage path must not reference upstreamModelId`);
    }
  }
  // Phase 9A: the chat validator must not know client token-count fields —
  // the backend owns every number. Phase 13: same for agent validator.
  {
    const src = fs.readFileSync(path.join(ROOT, "services", "managedChatValidator.js"), "utf8");
    for (const re of [/inputTokens/, /outputTokens/, /reservedTokens/, /maxOutputTokens/, /remainingTokens/, /monthlyTokenLimit/, /usedTokens/]) {
      if (re.test(src)) failures.push(`services/managedChatValidator.js: client token field leaked into validator ${re}`);
    }
  }
  {
    const src = fs.readFileSync(path.join(ROOT, "services", "managedAgentValidator.js"), "utf8");
    for (const re of [/inputTokens/, /outputTokens/, /reservedTokens/, /maxOutputTokens/, /remainingTokens/, /monthlyTokenLimit/, /usedTokens/]) {
      if (re.test(src)) failures.push(`services/managedAgentValidator.js: client token field leaked into validator ${re}`);
    }
  }
  // Phase 8: chat path performs zero Firestore access of its own — all
  // policy reads go through the injected authority services.
  // Phase 13: same for the agent path.
  for (const rel of [
    path.join("routes", "managedChat.js"),
    path.join("services", "managedChatService.js"),
    path.join("services", "managedChatValidator.js"),
    path.join("routes", "managedAgent.js"),
    path.join("services", "managedAgentService.js"),
    path.join("services", "managedAgentValidator.js"),
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/.*$/gm, "$1");
    if (/\.collection\s*\(/.test(code)) {
      failures.push(`${rel}: chat path must not touch Firestore collections directly`);
    }
  }
}
if (failures.length) {
  console.error("secret-leak check FAILED:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log("secret-leak check OK");
