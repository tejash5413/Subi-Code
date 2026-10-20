// test/errorOrigin.test.js — error-origin classifier (Phase 9B.2F).
// No Firestore, no network. Pure unit tests over representative inputs.
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyErrorOrigin, classifyDomainCode } = require("../src/utils/errorOrigin");
const {
  classifyErrorCodeType,
  classifyErrorKind,
} = require("../src/utils/errorOrigin");

function marked(code, message) {
  const err = new Error(message || "domain failure");
  err.code = code;
  err.isSubiDomainError = true;
  return err;
}

test("marked SUBI errors classify domain regardless of code", () => {
  for (const code of ["INVALID_REQUEST", "REQUEST_ALREADY_PROCESSED", "INTERNAL", "WEIRD_CUSTOM"]) {
    assert.equal(classifyErrorOrigin(marked(code)), "domain", code);
  }
});

test("domain code class maps allowlisted codes, others to OTHER_DOMAIN", () => {
  assert.equal(classifyDomainCode(marked("INVALID_REQUEST")), "INVALID_REQUEST");
  assert.equal(classifyDomainCode(marked("REQUEST_ALREADY_PROCESSED")), "REQUEST_ALREADY_PROCESSED");
  assert.equal(classifyDomainCode(marked("INTERNAL")), "INTERNAL");
  assert.equal(classifyDomainCode(marked("WEIRD_CUSTOM")), "OTHER_DOMAIN");
  assert.equal(classifyDomainCode({ code: "INVALID_REQUEST" }), null);
  assert.equal(classifyDomainCode({ code: "permission-denied" }), null);
  assert.equal(classifyDomainCode(null), null);
});

test("numeric gRPC codes classify store", () => {
  for (const code of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 16]) {
    assert.equal(classifyErrorOrigin({ code }), "store", String(code));
    assert.equal(classifyErrorOrigin(code), "store", String(code));
  }
  for (const code of [-1, 17, 99, 1.5, Number.NaN]) {
    assert.equal(classifyErrorOrigin({ code }), "unknown", String(code));
  }
});

test("recognized store code names classify store without marker", () => {
  for (const code of [
    "UNAVAILABLE",
    "unavailable",
    "ABORTED",
    "deadline-exceeded",
    "PERMISSION_DENIED",
    "permission-denied",
    "NOT_FOUND",
    "not-found",
    "INVALID_ARGUMENT",
    "invalid-argument",
    "CANCELLED",
    "cancelled",
    "ALREADY_EXISTS",
    "OUT_OF_RANGE",
    "UNIMPLEMENTED",
    "DATA_LOSS",
    "UNAUTHENTICATED",
  ]) {
    assert.equal(classifyErrorOrigin({ code }), "store", code);
  }
});

test("unmarked SUBI-owned code strings stay unknown (marker is authoritative)", () => {
  for (const code of ["INVALID_REQUEST", "REQUEST_ALREADY_PROCESSED", "REQUEST_IN_PROGRESS", "INTERNAL"]) {
    assert.equal(classifyErrorOrigin({ code }), "unknown", code);
    assert.equal(classifyDomainCode({ code }), null, code);
  }
});

test("missing and foreign shapes classify unknown", () => {
  for (const input of [
    undefined,
    null,
    {},
    { code: undefined },
    { code: null },
    { code: "" },
    { code: "   " },
    { code: "SOME_FUTURE_CODE" },
    { code: {} },
    { code: true },
    "a bare string",
  ]) {
    assert.equal(classifyErrorOrigin(input), "unknown", JSON.stringify(input));
  }
});

test("hostile message/stack never influence origin or domain class", () => {
  const hostile = Object.assign(
    new Error("token secret prompt upstreamModelId sk-test Bearer abc payload content"),
    {
      code: "TOTALLY_WEIRD",
      stack: "Error: hostile stack Bearer xyz\n    at evil (x.js:1:1)",
      custom: { nested: "completion delta text" },
    }
  );
  assert.equal(classifyErrorOrigin(hostile), "unknown");
  assert.equal(classifyDomainCode(hostile), null);
  const hostileMarked = Object.assign(new Error("Bearer xyz secret"), {
    code: "INVALID_REQUEST",
    isSubiDomainError: true,
  });
  assert.equal(classifyErrorOrigin(hostileMarked), "domain");
  assert.equal(classifyDomainCode(hostileMarked), "INVALID_REQUEST");
});

test("codeType is categorical: missing/number/string/other, never the value", () => {
  assert.equal(classifyErrorCodeType(null), "missing");
  assert.equal(classifyErrorCodeType(undefined), "missing");
  assert.equal(classifyErrorCodeType(new Error("no code here")), "missing");
  assert.equal(classifyErrorCodeType(new TypeError("HOSTILE SECRET PROMPT TOKEN")), "missing");
  assert.equal(classifyErrorCodeType({}), "missing");
  assert.equal(classifyErrorCodeType({ code: undefined }), "missing");
  assert.equal(classifyErrorCodeType({ code: null }), "missing");
  assert.equal(classifyErrorCodeType({ code: 14 }), "number");
  assert.equal(classifyErrorCodeType({ code: 7 }), "number");
  assert.equal(classifyErrorCodeType(14), "missing");
  assert.equal(classifyErrorCodeType({ code: "unavailable" }), "string");
  assert.equal(classifyErrorCodeType({ code: "WEIRD_CODE" }), "string");
  assert.equal(classifyErrorCodeType({ code: {} }), "other");
  assert.equal(classifyErrorCodeType({ code: ["x"] }), "other");
  assert.equal(classifyErrorCodeType({ code: true }), "other");
  assert.equal(classifyErrorCodeType("a bare string"), "missing");
});

test("errorKind uses fixed categories, never raw names", () => {
  assert.equal(classifyErrorKind(new TypeError("x")), "type_error");
  assert.equal(classifyErrorKind(new RangeError("x")), "range_error");
  assert.equal(classifyErrorKind(new ReferenceError("x")), "reference_error");
  assert.equal(classifyErrorKind(new SyntaxError("x")), "syntax_error");
  assert.equal(classifyErrorKind(new Error("x")), "generic_error");
  const google = new Error("boom");
  google.name = "GoogleError";
  assert.equal(classifyErrorKind(google), "google_error");
  for (const name of ["FirebaseError", "FirebaseAppError", "FirebaseFirestoreError"]) {
    const e = new Error("boom");
    e.name = name;
    assert.equal(classifyErrorKind(e), "firebase_error", name);
  }
  const hostile = new Error("SECRET TOKEN PROMPT");
  hostile.name = "EvilCustomError";
  assert.equal(classifyErrorKind(hostile), "generic_error");
  assert.equal(classifyErrorKind(null), "unknown");
  assert.equal(classifyErrorKind(undefined), "unknown");
  assert.equal(classifyErrorKind({}), "unknown");
  assert.equal(classifyErrorKind("nope"), "unknown");
});
