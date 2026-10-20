// functions-subi/src/middleware/cors.js
// Allowlist CORS for SUBI backends (Phase 2C). Browser frontend calls
// subiAdminApi directly, so preflight OPTIONS must succeed.
//
// Sourcing: production origin https://stlearnsmart.in matches the existing
// LearnSmart deployment (functions ALLOWED_ORIGINS, Cashfree return base,
// hosting rewrites); localhost:3000 matches the React dev server.
// Reflects the exact Origin (never "*") and always sets Vary: Origin.
// Mount FIRST, before body parsers and auth, so OPTIONS never sees 401.

const ALLOWED_ORIGINS = new Set([
  "https://stlearnsmart.in",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function subiCors(req, res, next) {
  const origin = String(req.headers.origin || "");
  res.set("Vary", "Origin");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  return next();
}

module.exports = { subiCors, ALLOWED_ORIGINS };
