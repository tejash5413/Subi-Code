// test/storeErrorClass.test.js — safe store-code classifier (Phase 9B.2C).
// No Firestore, no network. Pure unit tests over representative inputs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyStoreErrorCode } = require("../src/utils/storeErrorClass");

test("string codes classify case- and separator-insensitively", () => {
  for (const [input, expected] of [
    [{ code: "UNAVAILABLE" }, "UNAVAILABLE"],
    [{ code: "unavailable" }, "UNAVAILABLE"],
    [{ code: "Unavailable" }, "UNAVAILABLE"],
    [{ code: "ABORTED" }, "ABORTED"],
    [{ code: "aborted" }, "ABORTED"],
    [{ code: "DEADLINE_EXCEEDED" }, "DEADLINE_EXCEEDED"],
    [{ code: "deadline-exceeded" }, "DEADLINE_EXCEEDED"],
    [{ code: "deadline exceeded" }, "DEADLINE_EXCEEDED"],
    [{ code: "FAILED_PRECONDITION" }, "FAILED_PRECONDITION"],
    [{ code: "failed-precondition" }, "FAILED_PRECONDITION"],
    [{ code: "RESOURCE_EXHAUSTED" }, "RESOURCE_EXHAUSTED"],
    [{ code: "resource_exhausted" }, "RESOURCE_EXHAUSTED"],
    [{ code: "INTERNAL" }, "INTERNAL"],
    [{ code: "internal" }, "INTERNAL"],
    [{ code: "UNKNOWN" }, "UNKNOWN"],
  ]) {
    assert.equal(classifyStoreErrorCode(input), expected, JSON.stringify(input));
  }
});

test("gRPC numeric codes classify", () => {
  for (const [input, expected] of [
    [14, "UNAVAILABLE"],
    [{ code: 14 }, "UNAVAILABLE"],
    [10, "ABORTED"],
    [{ code: 10 }, "ABORTED"],
    [4, "DEADLINE_EXCEEDED"],
    [{ code: 4 }, "DEADLINE_EXCEEDED"],
    [9, "FAILED_PRECONDITION"],
    [8, "RESOURCE_EXHAUSTED"],
    [13, "INTERNAL"],
    [2, "UNKNOWN"],
  ]) {
    assert.equal(classifyStoreErrorCode(input), expected, JSON.stringify(input));
  }
});

test("missing/foreign codes collapse to UNKNOWN", () => {
  for (const input of [
    undefined,
    null,
    {},
    { code: undefined },
    { code: null },
    { code: 7 },
    { code: 5 },
    { code: 99 },
    { code: "PERMISSION_DENIED" },
    { code: "NOT_FOUND" },
    { code: "SOME_FUTURE_CODE" },
    { code: "" },
    { code: "   " },
    { code: 1.5 },
    { code: Number.NaN },
    "a bare string is not an error envelope",
    42,
  ]) {
    assert.equal(classifyStoreErrorCode(input), "UNKNOWN", JSON.stringify(input));
  }
});

test("hostile message/stack never influence the class", () => {
  const hostile = Object.assign(new Error("token secret prompt upstreamModelId sk-test Bearer abc"), {
    code: "UNAVAILABLE",
    stack: "Error: secret leak\n    at evil (x.js:1:1)",
    customField: { nested: "prompt content here" },
  });
  assert.equal(classifyStoreErrorCode(hostile), "UNAVAILABLE");
  const hostileUnknown = Object.assign(new Error("Bearer xyz"), { code: "WEIRD_CODE" });
  assert.equal(classifyStoreErrorCode(hostileUnknown), "UNKNOWN");
});
