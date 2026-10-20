// functions-subi/src/routes/status.js
// Minimal health/status endpoints (Phase 1A). Return only safe,
// non-sensitive data. Never leak secrets, credentials, tokens, or profiles.

const express = require("express");

function managedStatusRouter() {
  const router = express.Router();
  router.get("/status", (req, res) => {
    res.json({ ok: true, service: "subi-managed" });
  });
  return router;
}

function adminStatusRouter() {
  const router = express.Router();
  router.get("/status", (req, res) => {
    res.json({ ok: true, service: "subi-admin" });
  });
  return router;
}

module.exports = { managedStatusRouter, adminStatusRouter };
