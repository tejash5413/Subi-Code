// test/autoEligible.test.js — Free + Cheap auto-register rule (fakes only).
// Free = In $0 AND Out $0. Cheap-auto = Out <=$0.5/1M inclusive (so $0.50
// qualifies, $0.60 does not). Missing/invalid pricing never qualifies.
const test = require("node:test");
const assert = require("node:assert/strict");

const auto = require("../src/services/autoEligibleModelService");

test("free requires both In and Out $0", () => {
  assert.equal(auto.isFreeModel({ pricing: { input: "0", output: "0" } }), true);
  assert.equal(auto.isFreeModel({ pricing: { input: 0, output: 0 } }), true);
  assert.equal(auto.isFreeModel({ pricing: { input: "0", output: "0.00000017" } }), false);
  assert.equal(auto.isFreeModel({ pricing: { input: null, output: null } }), false);
});

test("cheap auto uses Output <=$0.5/1M inclusive", () => {
  // Qualifying cheap outputs (both school + individual auto-serve)
  assert.equal(auto.isAutoEligible({ pricing: { input: "0.00000004", output: "0.00000017" } }), true);
  assert.equal(auto.isAutoEligible({ pricing: { input: "0.00000009", output: "0.00000018" } }), true);
  assert.equal(auto.isAutoEligible({ pricing: { input: "0.0000005", output: "0.0000005" } }), true);
  // Free also auto (0 <= 0.5)
  assert.equal(auto.isAutoEligible({ pricing: { input: "0", output: "0" } }), true);
  // Boundary: $0.60 does NOT auto, $0.66 does NOT auto, $1.00 does NOT auto
  assert.equal(auto.isAutoEligible({ pricing: { input: "0.0000006", output: "0.0000006" } }), false);
  assert.equal(auto.isAutoEligible({ pricing: { input: "0.00000022", output: "0.00000066" } }), false);
  assert.equal(auto.isAutoEligible({ pricing: { input: "0.000001", output: "0.000001" } }), false);
  // Expensive never auto
  assert.equal(auto.isAutoEligible({ pricing: { input: "0.000005", output: "0.000005" } }), false);
  // Missing/invalid never auto (fail closed)
  assert.equal(auto.isAutoEligible({ pricing: { input: null, output: null } }), false);
  assert.equal(auto.isAutoEligible({ pricing: {} }), false);
  assert.equal(auto.isAutoEligible(null), false);
});

test("reason distinguishes free vs cheap_output", () => {
  assert.equal(auto.getAutoReason({ pricing: { input: "0", output: "0" } }), "free");
  assert.equal(auto.getAutoReason({ pricing: { input: "0.00000004", output: "0.00000017" } }), "cheap_output");
  assert.equal(auto.getAutoReason({ pricing: { input: "0.00000022", output: "0.00000066" } }), null);
  assert.equal(auto.getAutoReason({ pricing: { input: "0.000005", output: "0.000005" } }), null);
});

test("autoKeysFromApprovedDocs respects Enabled opt-out", () => {
  const docs = [
    { modelKey: "mdl_free", enabled: true, pricing: { input: "0", output: "0" } },
    { modelKey: "mdl_cheap", enabled: true, pricing: { input: "0.00000004", output: "0.00000017" } },
    { modelKey: "mdl_over", enabled: true, pricing: { input: "0.00000022", output: "0.00000066" } },
    { modelKey: "mdl_disabled", enabled: false, pricing: { input: "0", output: "0" } },
    { modelKey: "mdl_exp", enabled: true, pricing: { input: "0.000005", output: "0.000005" } },
    { modelKey: "mdl_noprice", enabled: true, pricing: { input: null, output: null } },
  ];
  assert.deepEqual(auto.autoKeysFromApprovedDocs(docs), ["mdl_free", "mdl_cheap"]);
});
