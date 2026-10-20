// functions-subi/src/services/effectiveModelService.js
// Single effective-model resolver seam (Phase 8).
//
// GET /managed/models AND POST /managed/chat preflight must authorize
// against the SAME authority. This selector owns the cutover branch so
// model eligibility rules are never duplicated in managedChatService or
// any route.
//
// MODEL_POLICY_CUTOVER is true (production cutover complete): the new
// school/individual policy resolver is authoritative for both callers
// (GET /managed/models, POST /managed/chat preflight). The legacy flags
// (enabled/roles/usage) must NOT be re-encoded anywhere else; they live
// only in approvedModelService.listEligibleManagedModels (deprecated).
//
// BOUNDARY: policy reads only. No secrets, no OpenRouter, no Firestore
// writes, no logging of model internals beyond safe keys.

const legacyModels = require("./approvedModelService");
const modelPolicies = require("./modelPolicyService");

// Production cutover COMPLETE (readiness GO): the new school/individual
// model policy is authoritative. Legacy approved flags are ignored for
// eligibility. No fallback: missing new policy means [].
const MODEL_POLICY_CUTOVER = true;

// Resolve the currently-effective safe model list for a normal user.
// Returns { mode, models } where models are safe projections
// ({modelKey, displayName, capabilities, contextLength}).
// deps: { store?, basis? } — basis scopes the legacy path exactly like
// GET /managed/models; ignored by the new policy path.
async function resolveEffectiveModels({ uid, schoolId, role, accountType }, deps) {
  const d = deps || {};
  if (MODEL_POLICY_CUTOVER) {
    const resolved = await modelPolicies.resolveManagedModels(
      { uid, schoolId, role, accountType },
      d.store ? { store: d.store } : undefined
    );
    return { mode: resolved.mode, models: resolved.models };
  }
  const storeDeps = d.store ? { store: d.store } : {};
  if (d.basis !== undefined) storeDeps.basis = d.basis;
  const list = await legacyModels.listEligibleManagedModels(role, storeDeps);
  return { mode: "legacy", models: list };
}

// Server-only upstream lookup for an already-authorized modelKey.
// Returns the upstreamModelId string for backend-memory use ONLY.
// Throws MODEL_NOT_AVAILABLE when the backing doc is missing or has no
// upstreamModelId (e.g. stale assignment after admin removal).
async function resolveUpstreamModelId(modelKey, deps) {
  const store = deps && deps.store ? { store: deps.store } : undefined;
  let doc;
  try {
    doc = await legacyModels.getApprovedModel(modelKey, store);
  } catch (_) {
    const err = new Error("model not available");
    err.code = "MODEL_NOT_AVAILABLE";
    throw err;
  }
  const upstream = doc && typeof doc.upstreamModelId === "string" ? doc.upstreamModelId.trim() : "";
  if (!upstream || upstream.length > 200) {
    const err = new Error("model not available");
    err.code = "MODEL_NOT_AVAILABLE";
    throw err;
  }
  return upstream;
}

module.exports = {
  MODEL_POLICY_CUTOVER,
  resolveEffectiveModels,
  resolveUpstreamModelId,
};
