// functions-subi/src/services/usagePeriod.js
// Single authoritative calendar-month helper for SUBI usage/quota code.
//
// Asia/Kolkata YYYY-MM is the canonical monthly period across monthly
// limits, usage accounting, and quota enforcement. Every service imports
// from here — never a second implementation.
//
// No store, no secrets, no network. Pure date logic only.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function invalidPeriod(message) {
  const err = new Error(message || "invalid month (expected YYYY-MM)");
  err.code = "INVALID_REQUEST";
  throw err;
}

// Current calendar month in Asia/Kolkata.
function currentMonthIST(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    return `${y}-${m}`;
  } catch (_) {
    const d = now instanceof Date ? now : new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}

function cleanMonth(value) {
  const m = String(value || "").trim();
  if (!MONTH_RE.test(m)) invalidPeriod();
  return m;
}

// Empty/omitted month defaults to current; explicit values validated.
// Future months are rejected (usage is recorded history, never forecast).
function resolveMonth(value) {
  if (value === undefined || value === null || value === "") return currentMonthIST();
  const m = cleanMonth(value);
  if (m > currentMonthIST()) invalidPeriod("month is in the future");
  return m;
}

module.exports = { currentMonthIST, cleanMonth, resolveMonth };
