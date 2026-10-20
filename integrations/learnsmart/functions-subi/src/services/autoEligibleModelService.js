// functions-subi/src/services/autoEligibleModelService.js
// Auto-register rule for SUBI Model Registry (Free + Cheap).
//
// DEFINITION (authoritative, mirrors frontend modelFilterUtils):
// - Free = Input per-1M == 0 AND Output per-1M == 0 (both $0/1M).
// - Cheap-auto = Output per-1M is a valid number AND <= 0.5 (inclusive).
//   Examples: Out $0.17/1M, $0.18/1M, $0.50/1M qualify.
//   Out $0.60/1M, $0.66/1M, $1.00/1M do NOT qualify.
//   Missing/invalid pricing never qualifies.
// - isAutoEligible = Cheap-auto (which already includes Free).
//   getAutoReason distinguishes "free" vs "cheap_output" for display/audit.
//
// BOUNDARY: pure evaluation here (no store, no secrets, no fetch).
// Registry/policy callers fetch snapshots and call these helpers.
// Never logs pricing internals beyond safe reason strings.

const AUTO_OUTPUT_THRESHOLD_PER_M = 0.5;

// Per-token upstream price (string|number) -> per-1M number. Null when missing/invalid.
function priceToPerMillion(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 1000000;
}

function modelInputPerMillion(item) {
  return priceToPerMillion(item && item.pricing && item.pricing.input);
}

function modelOutputPerMillion(item) {
  return priceToPerMillion(item && item.pricing && item.pricing.output);
}

// Both sides exactly $0/1M. Missing/invalid -> false (fail closed).
function isFreeModel(item) {
  const inp = modelInputPerMillion(item);
  const out = modelOutputPerMillion(item);
  return inp !== null && out !== null && inp === 0 && out === 0;
}

// Output <= $0.5/1M (inclusive). Includes Free (0 <= 0.5).
// Missing/invalid output -> false (fail closed, never auto).
function isAutoEligible(item) {
  const out = modelOutputPerMillion(item);
  if (out === null) return false;
  return out <= AUTO_OUTPUT_THRESHOLD_PER_M;
}

function getAutoReason(item) {
  if (!isAutoEligible(item)) return null;
  if (isFreeModel(item)) return "free";
  return "cheap_output";
}

function filterAutoEligible(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((m) => isAutoEligible(m));
}

// Build ensureCatalogueModels selections for missing auto-eligible items.
// Auto records end Enabled + UNCERTIFIED: no terminal/verify marks are set
// here because OpenRouter metadata is sufficient only for basic toolCalling
// eligibility, never proof of SUBI terminal/verification compatibility.
// Uncertified records join the certification backfill queue (unknown state)
// instead of falsely carrying verified marks.
function buildAutoSelections(catalogItems) {
  const out = [];
  const seen = new Set();
  for (const item of catalogItems || []) {
    if (!item || typeof item.upstreamModelId !== "string") continue;
    const id = item.upstreamModelId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ upstreamModelId: id });
  }
  return out;
}

// Scan already-fetched approved docs (admin shape {modelKey, pricing, enabled})
// and return the modelKeys that are Enabled + auto-eligible.
// Pure: no store access, safe for unit tests and resolver use.
function autoKeysFromApprovedDocs(docs) {
  const keys = [];
  for (const doc of docs || []) {
    if (!doc || typeof doc.modelKey !== "string" || !doc.modelKey) continue;
    if (doc.enabled !== true) continue; // Disabled opt-out wins over auto
    if (!isAutoEligible(doc)) continue;
    keys.push(doc.modelKey);
  }
  return keys;
}

module.exports = {
  AUTO_OUTPUT_THRESHOLD_PER_M,
  priceToPerMillion,
  modelInputPerMillion,
  modelOutputPerMillion,
  isFreeModel,
  isAutoEligible,
  getAutoReason,
  filterAutoEligible,
  buildAutoSelections,
  autoKeysFromApprovedDocs,
};
