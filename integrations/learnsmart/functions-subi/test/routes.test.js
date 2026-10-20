// test/routes.test.js — HTTP-level checks: body cap, auth chain, safe shapes.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildManagedApp, buildAdminApp } = require("../src/app");

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

test("managed /status is public and safe", async () => {
  const s = await listen(buildManagedApp());
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/status`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, service: "subi-managed" });
  } finally {
    s.close();
  }
});

test("admin routes require auth (401 without token)", async () => {
  const s = await listen(buildAdminApp());
  try {
    const port = s.address().port;
    for (const [m, p] of [
      ["GET", "/status"],
      ["GET", "/admin/ai-connection"],
      ["POST", "/admin/ai-connection/configure"],
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: m });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  } finally {
    s.close();
  }
});

test("CORS preflight from allowed origin succeeds without auth", async () => {
  const s = await listen(buildAdminApp());
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/admin/ai-connection`, {
      method: "OPTIONS",
      headers: { Origin: "https://stlearnsmart.in" },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://stlearnsmart.in");
    assert.equal(r.headers.get("vary"), "Origin");
  } finally {
    s.close();
  }
});

test("CORS reflects no origin for unknown callers", async () => {
  const s = await listen(buildAdminApp());
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/status`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  } finally {
    s.close();
  }
});

test("access routes require auth (401 without token)", async () => {
  const managed = await listen(buildManagedApp());
  try {
    const port = managed.address().port;
    for (const p of ["/managed/access-status", "/managed/models", "/managed/usage", "/admin/model-catalog"]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(r.status, 401, `GET ${p}`);
    }
  } finally {
    managed.close();
  }
  const s = await listen(buildAdminApp());
  try {
    const port = s.address().port;
    for (const [m, p, body] of [
      ["GET", "/admin/subi-access", null],
      ["POST", "/admin/subi-access", { enabled: true }],
      ["GET", "/admin/schools/s1/subi-access", null],
      ["POST", "/admin/schools/s1/subi-access", { studentEnabled: true, teacherEnabled: false }],
      ["GET", "/admin/subi-users?q=arun", null],
      ["GET", "/admin/users/u1/subi-access", null],
      ["POST", "/admin/users/u1/subi-access", { accessMode: "enabled" }],
      ["GET", "/admin/approved-models", null],
      ["POST", "/admin/approved-models/approve", { upstreamModelId: "x/y" }],
      ["POST", "/admin/approved-models/mdl_x", { enabled: true }],
      ["GET", "/admin/usage/schools/s1", null],
      ["GET", "/admin/usage/schools/s1/users", null],
      ["GET", "/admin/users/u1/usage", null],
    ]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: m,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
      assert.equal(r.status, 401, `${m} ${p}`);
    }
  } finally {
    s.close();
  }
});

test("oversized credential body rejected before auth", async () => {
  const s = await listen(buildAdminApp());
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/admin/ai-connection/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "x".repeat(5000) }),
    });
    assert.equal(r.status, 413);
  } finally {
    s.close();
  }
});
