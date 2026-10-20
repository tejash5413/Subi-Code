// functions-subi/src/services/approvedModelService.js
// Approved SUBI model administration (Phase 4).
//
// BOUNDARY: uses ONLY subiDb. Never secretService, aiConnectionService,
// OpenRouter, or fetch. Approved models are policy data; the catalogue is
// only a discovery aid and never re-read here.
//
// Uniqueness: approvedModelUpstream/{sha256(upstreamModelId)} mapping docs
// written atomically with the model doc in one transaction.
//
// DI: methods accept optional `deps` ({ store, audits, ids }) for fakes.

const crypto = require("crypto");
const { subiDb } = require("../db");
const auditService = require("./auditService");

const SCHEMA_VERSION = 1;
const MODEL_COLLECTION = "approvedModels";
const UPSTREAM_COLLECTION = "approvedModelUpstream";

const INPUT_MODALITIES = new Set(["text", "image", "file", "audio"]);
const OUTPUT_MODALITIES = new Set(["text", "image", "audio"]);

function defaultDeps() {
  return { store: subiDb, audits: auditService, ids: () => `mdl_${crypto.randomUUID()}` };
}

function cleanId(value, max = 128) {
  return String(value || "").trim().slice(0, max);
}

function isBool(value) {
  return typeof value === "boolean";
}

function upstreamHash(upstreamModelId) {
  return crypto
    .createHash("sha256")
    .update(String(upstreamModelId).trim(), "utf8")
    .digest("hex");
}

function cleanCapabilities(value) {
  const src = value && typeof value === "object" ? value : {};
  const pick = (list, allow) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const v of list) {
      if (typeof v !== "string") continue;
      const m = v.trim().toLowerCase();
      if (allow.has(m) && !out.includes(m)) out.push(m);
      if (out.length >= 10) break;
    }
    return out;
  };
  // Terminal-agent compatibility (Phase 16 production): explicit three-state
  // metadata. 'verified' = certified for terminal_v1 turns; 'unsupported' =
  // blocked pre-dispatch with zero provider usage; absent/unknown = allowed
  // while managedAgentMode=test (compatibility probe with diagnostics), and
  // reserved for fail-closed production policy later. Never model-name based.
  const agentTerminalRaw =
    typeof src.agentTerminal === "string" ? src.agentTerminal.trim().toLowerCase() : "";
  const agentTerminal =
    agentTerminalRaw === "verified" || agentTerminalRaw === "unsupported"
      ? agentTerminalRaw
      : undefined;
  // Verification-agent compatibility (Phase 17): explicit verified /
  // unsupported / unknown for the 18-tool verify_v1 bundle. 'verified'
  // allows verify_v1; 'unsupported' blocks pre-dispatch; 'unknown' probes in
  // test mode and fails closed in production (route policy). Absent means a
  // pre-17I record (treated as unknown downstream).
  const agentVerifyRaw =
    typeof src.agentVerify === "string" ? src.agentVerify.trim().toLowerCase() : "";
  const agentVerify =
    agentVerifyRaw === "verified" || agentVerifyRaw === "unsupported" || agentVerifyRaw === "unknown"
      ? agentVerifyRaw
      : undefined;
  const capabilities = {
    inputModalities: pick(src.inputModalities, INPUT_MODALITIES),
    outputModalities: pick(src.outputModalities, OUTPUT_MODALITIES),
    toolCalling: src.toolCalling === true,
  };
  if (agentTerminal !== undefined) capabilities.agentTerminal = agentTerminal;
  if (agentVerify !== undefined) capabilities.agentVerify = agentVerify;
  return capabilities;
}

function cleanContextLength(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), 10_000_000);
}

// Pricing is a read-only reference copied from the catalogue at approve
// time (never used for billing). Same per-token string shape as
// modelCatalogService.cleanPrice; invalid/missing → null (filter passes).
function cleanPriceValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim().slice(0, 32);
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return s;
}

function cleanPricing(value) {
  const src = value && typeof value === "object" ? value : {};
  return { input: cleanPriceValue(src.input), output: cleanPriceValue(src.output) };
}

// Per-model usage scope (Phase B2). Missing flags default to true so
// pre-migration docs stay fully available (backward compatible).
function cleanUsageFlag(value, defaultOn = true) {
  if (value === undefined || value === null) return defaultOn;
  return value === true;
}

function cleanUsage(value) {
  const src = value && typeof value === "object" ? value : {};
  // Also accept flat approve/update payload keys (schoolwiseEnabled /
  // individualEnabled alongside capabilities) for frontend convenience.
  const schoolwise =
    src.schoolwiseEnabled !== undefined ? src.schoolwiseEnabled : src.schoolwise;
  const individual =
    src.individualEnabled !== undefined ? src.individualEnabled : src.individual;
  return {
    schoolwiseEnabled: cleanUsageFlag(schoolwise, true),
    individualEnabled: cleanUsageFlag(individual, true),
  };
}

function toUsageShape(data) {
  const src = (data && data.usage) || {};
  // Pre-migration docs have no usage block → both ON.
  return {
    schoolwiseEnabled: src.schoolwiseEnabled !== false,
    individualEnabled: src.individualEnabled !== false,
  };
}

function toAdminShape(id, data) {
  const roles = (data && data.roles) || {};
  return {
    modelKey: id,
    displayName: (data && data.displayName) || id,
    upstreamModelId: (data && data.upstreamModelId) || null,
    enabled: (data && data.enabled) === true,
    roles: {
      student: { enabled: ((roles.student || {}).enabled) === true },
      teacher: { enabled: ((roles.teacher || {}).enabled) === true },
    },
    capabilities: cleanCapabilities(data && data.capabilities),
    contextLength: cleanContextLength(data && data.contextLength),
    pricing: cleanPricing(data && data.pricing),
    usage: toUsageShape(data),
    createdAt: (data && data.createdAt) || null,
    updatedAt: (data && data.updatedAt) || null,
  };
}

function toManagedShape(id, data) {
  const full = toAdminShape(id, data);
  return {
    modelKey: full.modelKey,
    displayName: full.displayName,
    capabilities: full.capabilities,
    contextLength: full.contextLength,
    ...(require('./freeCodingModel').isFreeCodingModel(data) ? { freeCoding: true } : {}),
  };
}

// Firestore's default ordering is document ID. Advance by document snapshot,
// retaining every registry record while bounding each database read.
async function readApprovedModelDocuments(store) {
  const pageSize = 200;
  const base = store.collection(MODEL_COLLECTION).limit(pageSize);
  let query = base;
  const docs = [];
  for (;;) {
    const page = (await query.get()).docs || [];
    docs.push(...page);
    if (page.length < pageSize) return docs;
    query = base.startAfter(page[page.length - 1]);
  }
}

async function listApprovedModelsAdmin(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const docs = await readApprovedModelDocuments(store);
  return docs.map((doc) => toAdminShape(doc.id, doc.data() || {}));
}

async function getApprovedModel(modelKey, deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(modelKey);
  if (!id) {
    const err = new Error("invalid modelKey");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const snap = await store.collection(MODEL_COLLECTION).doc(id).get();
  if (!snap.exists) {
    const err = new Error("unknown model");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  return toAdminShape(snap.id, snap.data() || {});
}

// Individual credit universe (cutover hardening): ALL approved + enabled +
// agent-compatible models. No school/user model policy, no tier, no costClass
// gate. "Compatible" mirrors the /agent/turn base gate exactly:
// capabilities.toolCalling === true (per-turn image/terminal/verify gates
// still apply at dispatch time). Safe projection only (never upstream ids,
// pricing, or admin metadata).
async function listIndividualCreditModels(deps) {
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const docs = await readApprovedModelDocuments(store);
  const out = [];
  for (const doc of docs) {
    const data = doc.data() || {};
    if (data.enabled !== true) continue;
    const caps = (data.capabilities && typeof data.capabilities === "object") ? data.capabilities : {};
    if (caps.toolCalling !== true) continue;
    out.push(toManagedShape(doc.id, data));
  }
  return out;
}

// Role-filtered eligible list for managed users. Trusts the caller-provided
// role (route supplies the authenticated role). No key/secret involvement.
//
// Usage scoping (Phase B2): when the caller passes the access `basis`
// (from resolveSubiAccess), models opted out of that admission path are
// hidden. Missing basis or missing usage flags → no usage filtering
// (backward compatible, fail open on unknown path, fail closed on malformed
// role as before).
async function listEligibleManagedModels(role, depsOrOpts, maybeOpts) {
  let deps;
  let opts;
  if (depsOrOpts && (depsOrOpts.store || depsOrOpts.audits || depsOrOpts.ids)) {
    deps = depsOrOpts;
    // Accept basis co-located on the deps object (tests + callers may merge).
    opts = { ...(maybeOpts || {}) };
    if (depsOrOpts.basis !== undefined && opts.basis === undefined) opts.basis = depsOrOpts.basis;
  } else {
    deps = undefined;
    opts = depsOrOpts || {};
  }
  const { store } = { ...defaultDeps(), ...(deps || {}) };
  const cleanRole = String(role || "").trim().toLowerCase();
  if (cleanRole !== "student" && cleanRole !== "teacher") {
    const err = new Error("invalid role");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const basis = opts && opts.basis !== undefined ? String(opts.basis) : null;
  const docs = await readApprovedModelDocuments(store);
  const out = [];
  for (const doc of docs) {
    const data = doc.data() || {};
    if (data.enabled !== true) continue;
    const roles = data.roles || {};
    if (((roles[cleanRole] || {}).enabled) !== true) continue;
    if (basis === "individual_enabled" && toUsageShape(data).individualEnabled !== true) continue;
    if (basis === "school_default_enabled" && toUsageShape(data).schoolwiseEnabled !== true) continue;
    out.push(toManagedShape(doc.id, data));
  }
  return out;
}

const APPROVE_FIELDS = new Set([
  "upstreamModelId",
  "displayName",
  "enabled",
  "studentEnabled",
  "teacherEnabled",
  "capabilities",
  "contextLength",
  "pricing",
  "schoolwiseEnabled",
  "individualEnabled",
  "usage",
]);

function validateApprovalInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some((k) => !APPROVE_FIELDS.has(k))) return null;
  const upstreamModelId = cleanId(body.upstreamModelId, 200);
  const displayName = cleanId(body.displayName, 80);
  if (!upstreamModelId || !displayName) return null;
  // Model Redesign: legacy assignment flags are OPTIONAL (older clients may
  // still send them; the new resolver ignores them). Only upstreamModelId +
  // displayName are required. Missing flags persist fail-closed-looking
  // defaults but never gate managed eligibility anymore.
  for (const key of ["enabled", "studentEnabled", "teacherEnabled", "schoolwiseEnabled", "individualEnabled"]) {
    if (body[key] !== undefined && !isBool(body[key])) return null;
  }
  if (body.usage !== undefined && (typeof body.usage !== "object" || body.usage === null || Array.isArray(body.usage))) {
    return null;
  }
  const usage = cleanUsage({ ...(body.usage || {}), schoolwiseEnabled: body.schoolwiseEnabled, individualEnabled: body.individualEnabled });
  return {
    upstreamModelId,
    displayName,
    enabled: body.enabled === true,
    studentEnabled: body.studentEnabled === true,
    teacherEnabled: body.teacherEnabled === true,
    capabilities: cleanCapabilities(body.capabilities),
    contextLength: cleanContextLength(body.contextLength),
    pricing: cleanPricing(body.pricing),
    usage,
  };
}

async function approveModel(input, adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const clean = validateApprovalInput(input);
  if (!clean) {
    const err = new Error("invalid approval payload");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const hash = upstreamHash(clean.upstreamModelId);
  const mapRef = d.store.collection(UPSTREAM_COLLECTION).doc(hash);
  const now = new Date();
  const modelKey = d.ids();
  if (!/^mdl_[A-Za-z0-9-]+$/.test(modelKey)) {
    const err = new Error("invalid generated key");
    err.code = "INTERNAL";
    throw err;
  }
  try {
    await d.store.runTransaction(async (tx) => {
      const existing = await tx.get(mapRef);
      if (existing.exists) {
        const err = new Error("duplicate model");
        err.code = "DUPLICATE_MODEL";
        throw err;
      }
      tx.set(mapRef, {
        schemaVersion: SCHEMA_VERSION,
        upstreamHash: hash,
        upstreamModelId: clean.upstreamModelId,
        modelKey,
        createdAt: now,
      });
      tx.set(d.store.collection(MODEL_COLLECTION).doc(modelKey), {
        schemaVersion: SCHEMA_VERSION,
        modelKey,
        displayName: clean.displayName,
        upstreamModelId: clean.upstreamModelId,
        enabled: clean.enabled,
        roles: {
          student: { enabled: clean.studentEnabled },
          teacher: { enabled: clean.teacherEnabled },
        },
        capabilities: clean.capabilities,
        contextLength: clean.contextLength,
        pricing: clean.pricing,
        usage: clean.usage,
        createdAt: now,
        updatedAt: now,
        updatedBy: String(adminUid || "").slice(0, 128),
      });
    });
  } catch (err) {
    if (err && err.code === "DUPLICATE_MODEL") throw err;
    const e = new Error("model store unavailable");
    e.code = "INTERNAL";
    throw e;
  }
  await d.audits.logAudit(
    {
      adminUid,
      action: "model.approved",
      target: { modelKey },
      result: "success",
      after: { displayName: clean.displayName, enabled: clean.enabled },
    },
    d.store
  );
  return getApprovedModel(modelKey, { store: d.store });
}

// ---------- Catalogue-assignment registry (assignment simplification) ----------
// No manual approval: assignment screens fetch the full provider catalogue and
// SAVE ensures internal mdl_* registry records here, reusing the same hash
// dedup/transaction/audit primitives as approveModel. The catalogue is only a
// discovery aid — canonical metadata ALWAYS comes from the server-fetched
// catalogue array passed in `catalog`, never from the browser. The browser
// may submit ONLY upstreamModelId + explicit certification marks.
//
// Returns { keys, created, reused } with keys in first-seen input order.

// Resolve upstream IDs to existing canonical mdl_* WITHOUT creating.
// Order: upstream-map point reads first, then ONE bounded registry scan for
// legacy records that predate map docs (healed best-effort). Stale map
// entries (target record removed) resolve to null so callers create fresh.
// Returns Map<upstreamModelId, modelKey> for hits only. Read-only except
// the best-effort map healing writes.
async function resolveExistingUpstreamKeys(upstreamIds, opts) {
  const o = opts || {};
  const d = { store: subiDb };
  if (o.store) d.store = o.store;
  const out = new Map();
  const unique = [...new Set((Array.isArray(upstreamIds) ? upstreamIds : []).filter((id) => typeof id === "string" && id))];
  if (unique.length === 0) return out;
  const missing = [];
  for (const id of unique) {
    let hit = null;
    try {
      const snap = await d.store.collection(UPSTREAM_COLLECTION).doc(upstreamHash(id)).get();
      if (snap.exists) {
        const data = snap.data() || {};
        if (typeof data.modelKey === "string" && data.modelKey) {
          const target = await d.store.collection(MODEL_COLLECTION).doc(data.modelKey).get();
          if (target.exists) hit = data.modelKey;
        }
      }
    } catch (_) {
      const err = new Error("model store unavailable");
      err.code = "INTERNAL";
      throw err;
    }
    if (hit) out.set(id, hit);
    else missing.push(id);
  }
  if (missing.length > 0) {
    let docs = [];
    try {
      const snap = await d.store.collection(MODEL_COLLECTION).limit(200).get();
      docs = snap.docs || [];
    } catch (_) {
      const err = new Error("model store unavailable");
      err.code = "INTERNAL";
      throw err;
    }
    const byUpstream = new Map();
    for (const doc of docs) {
      const data = (doc.data && doc.data()) || {};
      if (typeof data.upstreamModelId === "string" && data.upstreamModelId.trim()) {
        if (!byUpstream.has(data.upstreamModelId.trim())) byUpstream.set(data.upstreamModelId.trim(), doc.id);
      }
    }
    for (const id of missing) {
      const key = byUpstream.get(id.trim());
      if (key) {
        out.set(id, key);
        try {
          await d.store.collection(UPSTREAM_COLLECTION).doc(upstreamHash(id)).set({
            schemaVersion: SCHEMA_VERSION,
            upstreamHash: upstreamHash(id),
            upstreamModelId: id.trim(),
            modelKey: key,
            createdAt: new Date(),
          });
        } catch (_) {
          // Healing is best-effort; the reuse itself already succeeded.
        }
      }
    }
  }
  return out;
}

const MAX_ENSURE_ITEMS = 100;

function cleanUpstreamId(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().slice(0, 200);
  return v ? v : null;
}

async function ensureCatalogueModels(selections, opts) {
  const o = opts || {};
  const d = { store: subiDb, audits: auditService, ids: () => `mdl_${crypto.randomUUID()}` };
  if (o.store) d.store = o.store;
  if (o.audits) d.audits = o.audits;
  if (o.ids) d.ids = o.ids;
  const adminUid = o.adminUid;
  const catalog = Array.isArray(o.catalog) ? o.catalog : null;
  if (!Array.isArray(selections) || selections.length > MAX_ENSURE_ITEMS) {
    const err = new Error("invalid catalogue selection");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  if (!catalog) {
    const err = new Error("catalogue unavailable");
    err.code = "UPSTREAM_UNAVAILABLE";
    throw err;
  }
  const byUpstream = new Map();
  for (const item of catalog) {
    if (!item || typeof item.upstreamModelId !== "string") continue;
    const id = item.upstreamModelId.trim();
    if (id && !byUpstream.has(id)) byUpstream.set(id, item);
  }
  // Normalize: dedupe by upstream, first-seen order; validate marks now so
  // junk certification fails the whole SAVE before any write.
  const wanted = [];
  const seen = new Set();
  for (const raw of selections) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      const err = new Error("invalid catalogue selection");
      err.code = "INVALID_REQUEST";
      throw err;
    }
    const upstreamModelId = cleanUpstreamId(raw.upstreamModelId);
    if (!upstreamModelId || seen.has(upstreamModelId)) {
      if (!upstreamModelId) {
        const err = new Error("invalid catalogue selection");
        err.code = "INVALID_REQUEST";
        throw err;
      }
      continue;
    }
    const marks = {};
    if (raw.agentTerminal !== undefined) marks.agentTerminal = raw.agentTerminal;
    if (raw.agentVerify !== undefined) marks.agentVerify = raw.agentVerify;
    // Strict mark validation up front so junk certification fails the whole
    // SAVE before any write. Absent marks stay absent here (default UNMARKED
    // is applied by cleanCapabilities at record build, after merging over
    // the catalogue capabilities — never the reverse).
    const allowedMarks = {
      agentTerminal: new Set(["verified", "unsupported"]),
      agentVerify: new Set(["verified", "unsupported", "unknown"]),
    };
    for (const k of ["agentTerminal", "agentVerify"]) {
      if (marks[k] === undefined) continue;
      if (typeof marks[k] !== "string" || !allowedMarks[k].has(marks[k].trim().toLowerCase())) {
        const err = new Error("invalid certification mark");
        err.code = "INVALID_REQUEST";
        throw err;
      }
      marks[k] = marks[k].trim().toLowerCase();
    }
    seen.add(upstreamModelId);
    wanted.push({ upstreamModelId, marks });
  }
  // Fail the whole SAVE before any write when any selection is not in the
  // current authoritative catalogue (no orphan registry records). CLASS 2
  // rule: only NEW upstream identities are validated here; existing mdl_*
  // keys never pass through this check (see assertKeysApproved).
  for (const w of wanted) {
    if (!byUpstream.has(w.upstreamModelId)) {
      const err = new Error("unknown catalogue model");
      err.code = "UNKNOWN_CATALOGUE_MODEL";
      throw err;
    }
  }
  // Pre-resolve existing mappings (map doc + legacy records without one)
  // so resubmissions and key+upstream duplicates reuse instead of duping.
  const preResolved = await resolveExistingUpstreamKeys(
    wanted.map((w) => w.upstreamModelId),
    { store: d.store }
  );
  const keys = [];
  const created = [];
  const reused = [];
  for (const w of wanted) {
    const canonical = byUpstream.get(w.upstreamModelId);
    const hash = upstreamHash(w.upstreamModelId);
    const mapRef = d.store.collection(UPSTREAM_COLLECTION).doc(hash);
    let modelKey = preResolved.get(w.upstreamModelId) || null;
    if (!modelKey) {
      const candidate = d.ids();
      if (!/^mdl_[A-Za-z0-9-]+$/.test(candidate)) {
        const err = new Error("invalid generated key");
        err.code = "INTERNAL";
        throw err;
      }
      const displayName = cleanId(
        (canonical.name || canonical.upstreamModelId || w.upstreamModelId),
        80
      ) || candidate;
      const capabilities = cleanCapabilities({ ...(canonical.capabilities || {}), ...w.marks });
      const now = new Date();
      try {
        await d.store.runTransaction(async (tx) => {
          const snap = await tx.get(mapRef);
          if (snap.exists) {
            // A concurrent creator may have won the race — or the map is
            // stale (points at a removed record). Reuse only live targets.
            const data = snap.data() || {};
            if (typeof data.modelKey === "string" && data.modelKey) {
              const target = await tx.get(d.store.collection(MODEL_COLLECTION).doc(data.modelKey));
              if (target.exists) {
                modelKey = data.modelKey;
                return;
              }
            }
          }
          tx.set(mapRef, {
            schemaVersion: SCHEMA_VERSION,
            upstreamHash: hash,
            upstreamModelId: w.upstreamModelId,
            modelKey: candidate,
            createdAt: now,
          });
          tx.set(d.store.collection(MODEL_COLLECTION).doc(candidate), {
            schemaVersion: SCHEMA_VERSION,
            modelKey: candidate,
            displayName,
            upstreamModelId: w.upstreamModelId,
            enabled: true,
            roles: { student: { enabled: true }, teacher: { enabled: true } },
            capabilities,
            contextLength: cleanContextLength(canonical.contextLength),
            pricing: cleanPricing(canonical.pricing),
            usage: cleanUsage({}),
            createdAt: now,
            updatedAt: now,
            updatedBy: String(adminUid || "").slice(0, 128),
          });
          modelKey = candidate;
        });
      } catch (err) {
        if (err && err.code === "INVALID_REQUEST") throw err;
        const e = new Error("model store unavailable");
        e.code = "INTERNAL";
        throw e;
      }
      if (modelKey === candidate) created.push(modelKey);
      else reused.push(modelKey);
    } else {
      reused.push(modelKey);
    }
    keys.push(modelKey);
  }
  if (created.length > 0) {
    await d.audits.logAudit(
      {
        adminUid,
        action: "model.approved",
        target: {},
        result: "success",
        after: { createdModelKeys: created.slice(0, 20), reusedCount: reused.length, via: "catalogue-assignment" },
      },
      d.store
    );
  }
  return { keys, created, reused };
}

// ---------- Assignment certification ----------
// Unified assignment certification (select + Save): every assigned registry
// record ends enabled + Verified, whether just created or pre-existing.
// Only these three fields are ever touched here — displayName,
// upstreamModelId, modalities, toolCalling, contextLength, pricing, roles,
// and usage are preserved byte-for-byte. Terminal/shell/Git/file-write
// privileges are NOT granted: those live in agent tool bundles + operational
// gates, never in these marks.
//
// Callers must ensure/assert existence first (unknown keys fail before any
// write). All flips land in ONE transaction; keys needing nothing are not
// rewritten. Returns { reenabled[], verified[] } (verified = agentVerify
// and/or agentTerminal newly stamped).
async function applyAssignmentCertification(modelKeys, opts) {
  const o = opts || {};
  const d = { store: subiDb, audits: auditService, ids: () => `mdl_${crypto.randomUUID()}` };
  if (o.store) d.store = o.store;
  if (o.audits) d.audits = o.audits;
  const adminUid = o.adminUid;
  const unique = [...new Set((Array.isArray(modelKeys) ? modelKeys : []).filter((k) => typeof k === "string"))];
  if (unique.length === 0) return { reenabled: [], verified: [] };
  const now = new Date();
  const byKey = new Map();
  for (const key of unique) {
    const snap = await d.store.collection(MODEL_COLLECTION).doc(key).get();
    if (!snap.exists) {
      const err = new Error("unknown modelKey");
      err.code = "UNKNOWN_MODEL_KEY";
      throw err;
    }
    byKey.set(key, snap.data() || {});
  }
  const reenabled = [];
  const verified = [];
  const patches = new Map();
  for (const [key, data] of byKey) {
    const caps = (data.capabilities && typeof data.capabilities === "object") ? data.capabilities : {};
    const patch = {};
    if (data.enabled !== true) {
      patch.enabled = true;
      reenabled.push(key);
    }
    const nextCaps = { ...caps };
    let touched = false;
    if (nextCaps.agentVerify !== "verified") {
      nextCaps.agentVerify = "verified";
      touched = true;
    }
    if (nextCaps.agentTerminal !== "verified") {
      nextCaps.agentTerminal = "verified";
      touched = true;
    }
    if (touched) {
      patch.capabilities = cleanCapabilities(nextCaps);
      if (!verified.includes(key)) verified.push(key);
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = now;
      patch.updatedBy = String(adminUid || "").slice(0, 128);
      patches.set(key, patch);
    }
  }
  if (patches.size > 0) {
    await d.store.runTransaction(async (tx) => {
      for (const [key, patch] of patches) {
        tx.set(d.store.collection(MODEL_COLLECTION).doc(key), patch, { merge: true });
      }
    });
  }
  if (reenabled.length > 0) {
    await d.audits.logAudit(
      {
        adminUid,
        action: "model.reenabled-via-assignment",
        target: {},
        result: "success",
        after: { reenabledModelKeys: reenabled.slice(0, 20), reenabledCount: reenabled.length, via: "assignment-save" },
      },
      d.store
    );
  }
  return { reenabled, verified };
}

const UPDATE_FIELDS = new Set([
  "displayName",
  "enabled",
  "studentEnabled",
  "teacherEnabled",
  "capabilities",
  "contextLength",
  "pricing",
  "schoolwiseEnabled",
  "individualEnabled",
  "usage",
]);

function validateUpdateInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Object.keys(body).some((k) => !UPDATE_FIELDS.has(k))) return null;
  const out = {};
  if (body.displayName !== undefined) {
    const v = cleanId(body.displayName, 80);
    if (!v) return null;
    out.displayName = v;
  }
  for (const key of ["enabled", "studentEnabled", "teacherEnabled", "schoolwiseEnabled", "individualEnabled"]) {
    if (body[key] !== undefined) {
      if (!isBool(body[key])) return null;
      out[key] = body[key];
    }
  }
  if (body.capabilities !== undefined) out.capabilities = cleanCapabilities(body.capabilities);
  if (body.contextLength !== undefined) out.contextLength = cleanContextLength(body.contextLength);
  if (body.pricing !== undefined) out.pricing = cleanPricing(body.pricing);
  if (body.usage !== undefined) {
    if (typeof body.usage !== "object" || body.usage === null || Array.isArray(body.usage)) return null;
    const u = cleanUsage(body.usage);
    out.usage = u;
  }
  return out;
}

async function updateApprovedModel(modelKey, input, adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(modelKey);
  const clean = validateUpdateInput(input);
  if (!id || !clean || Object.keys(clean).length === 0) {
    const err = new Error("invalid update payload");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const ref = d.store.collection(MODEL_COLLECTION).doc(id);
  const before = await getApprovedModel(id, { store: d.store });
  const now = new Date();
  const patch = { updatedAt: now, updatedBy: String(adminUid || "").slice(0, 128) };
  if (clean.displayName !== undefined) patch.displayName = clean.displayName;
  if (clean.enabled !== undefined) patch.enabled = clean.enabled;
  if (clean.studentEnabled !== undefined || clean.teacherEnabled !== undefined) {
    patch.roles = {
      student: {
        enabled:
          clean.studentEnabled !== undefined ? clean.studentEnabled : before.roles.student.enabled,
      },
      teacher: {
        enabled:
          clean.teacherEnabled !== undefined ? clean.teacherEnabled : before.roles.teacher.enabled,
      },
    };
  }
  if (clean.capabilities !== undefined) patch.capabilities = clean.capabilities;
  if (clean.contextLength !== undefined) patch.contextLength = clean.contextLength;
  if (clean.pricing !== undefined) patch.pricing = clean.pricing;
  // Flat usage flags merge into the usage block (preserve the other flag).
  if (clean.usage !== undefined || clean.schoolwiseEnabled !== undefined || clean.individualEnabled !== undefined) {
    const merged = clean.usage || {};
    patch.usage = {
      schoolwiseEnabled:
        clean.schoolwiseEnabled !== undefined ? clean.schoolwiseEnabled : merged.schoolwiseEnabled !== undefined ? merged.schoolwiseEnabled : before.usage.schoolwiseEnabled,
      individualEnabled:
        clean.individualEnabled !== undefined ? clean.individualEnabled : merged.individualEnabled !== undefined ? merged.individualEnabled : before.usage.individualEnabled,
    };
  }
  await d.store.runTransaction(async (tx) => {
    tx.set(ref, patch, { merge: true });
  });
  const after = await getApprovedModel(id, { store: d.store });
  const enabledChanged = before.enabled !== after.enabled;
  await d.audits.logAudit(
    {
      adminUid,
      action: enabledChanged ? (after.enabled ? "model.enabled" : "model.disabled") : "model.updated",
      target: { modelKey: id },
      result: "success",
      before: {
        displayName: before.displayName,
        enabled: before.enabled,
        studentEnabled: before.roles.student.enabled,
        teacherEnabled: before.roles.teacher.enabled,
        schoolwiseEnabled: before.usage.schoolwiseEnabled,
        individualEnabled: before.usage.individualEnabled,
      },
      after: {
        displayName: after.displayName,
        enabled: after.enabled,
        studentEnabled: after.roles.student.enabled,
        teacherEnabled: after.roles.teacher.enabled,
        schoolwiseEnabled: after.usage.schoolwiseEnabled,
        individualEnabled: after.usage.individualEnabled,
      },
    },
    d.store
  );
  return after;
}

// ---------- Compatibility certification (explicit admin persist only) ----------
// Sets ONLY capabilities.agentTerminal/agentVerify, merged over the stored
// capabilities (modalities/toolCalling/pricing/enabled untouched). Values:
//   agentTerminal: "verified" | "unsupported" | cleared(absent)
//   agentVerify:   "verified" | "unsupported" | "unknown" | cleared(absent)
// Anything else -> INVALID_REQUEST. At least one mark must be provided.
// This is the ONLY path that may mark a model verified without a probe run;
// the probe route itself never persists. Audit action "model.certified".
function cleanCertMark(value, allowUnknown) {
  if (value === undefined || value === null) return "cleared";
  const v = String(value).trim().toLowerCase();
  if (v === "" || v === "clear" || v === "cleared" || v === "absent") return "cleared";
  if (v === "verified" || v === "unsupported") return v;
  if (allowUnknown && v === "unknown") return "unknown";
  const err = new Error("invalid certification mark");
  err.code = "INVALID_REQUEST";
  throw err;
}

async function setModelCertification(modelKey, marks, adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(modelKey);
  if (!id) {
    const err = new Error("invalid modelKey");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const src = (marks && typeof marks === "object") ? marks : {};
  const terminal = cleanCertMark(src.agentTerminal, false);
  const verify = cleanCertMark(src.agentVerify, true);
  if (terminal === "cleared" && verify === "cleared" && src.agentTerminal === undefined && src.agentVerify === undefined) {
    const err = new Error("no certification mark provided");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const before = await getApprovedModel(id, { store: d.store });
  const nextCaps = { ...(before.capabilities || {}) };
  if (terminal === "cleared") delete nextCaps.agentTerminal;
  else nextCaps.agentTerminal = terminal;
  if (verify === "cleared") delete nextCaps.agentVerify;
  else nextCaps.agentVerify = verify;
  const capabilities = cleanCapabilities(nextCaps);
  const now = new Date();
  await d.store.runTransaction(async (tx) => {
    tx.set(
      d.store.collection(MODEL_COLLECTION).doc(id),
      { capabilities, updatedAt: now, updatedBy: String(adminUid || "").slice(0, 128) },
      { merge: true }
    );
  });
  await d.audits.logAudit(
    {
      adminUid,
      action: "model.certified",
      target: { modelKey: id },
      result: "success",
      before: { agentTerminal: before.capabilities.agentTerminal || null, agentVerify: before.capabilities.agentVerify || null },
      after: { agentTerminal: capabilities.agentTerminal || null, agentVerify: capabilities.agentVerify || null },
    },
    d.store
  );
  return getApprovedModel(id, { store: d.store });
}

// Backfill queue: every approved record classified by certification state.
// Vision comes from registry inputModalities metadata (never probed).
// Counts are computed live on each call (no cache) for the admin report.
async function listUncertifiedModels(deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const snap = await d.store.collection(MODEL_COLLECTION).limit(200).get();
  const queue = [];
  const counts = {
    approved: 0,
    enabled: 0,
    toolCalling: 0,
    terminalVerified: 0,
    terminalUnsupported: 0,
    terminalUnknown: 0,
    verifyVerified: 0,
    verifyUnsupported: 0,
    verifyUnknown: 0,
    visionCapable: 0,
  };
  for (const doc of snap.docs || []) {
    const data = doc.data() || {};
    counts.approved += 1;
    const enabled = data.enabled === true;
    if (enabled) counts.enabled += 1;
    const caps = (data.capabilities && typeof data.capabilities === "object") ? data.capabilities : {};
    const toolCalling = caps.toolCalling === true;
    if (enabled && toolCalling) counts.toolCalling += 1;
    const terminal = caps.agentTerminal === "verified" ? "verified"
      : caps.agentTerminal === "unsupported" ? "unsupported" : "unknown";
    const verify = caps.agentVerify === "verified" ? "verified"
      : caps.agentVerify === "unsupported" ? "unsupported" : "unknown";
    const vision = Array.isArray(caps.inputModalities) && caps.inputModalities.includes("image");
    counts.terminalVerified += terminal === "verified" ? 1 : 0;
    counts.terminalUnsupported += terminal === "unsupported" ? 1 : 0;
    counts.terminalUnknown += terminal === "unknown" ? 1 : 0;
    counts.verifyVerified += verify === "verified" ? 1 : 0;
    counts.verifyUnsupported += verify === "unsupported" ? 1 : 0;
    counts.verifyUnknown += verify === "unknown" ? 1 : 0;
    if (vision) counts.visionCapable += 1;
    queue.push({
      modelKey: doc.id,
      displayName: (data && data.displayName) || doc.id,
      enabled,
      toolCalling,
      terminal,
      verify,
      vision,
      pricing: data.pricing && typeof data.pricing === "object"
        ? { input: data.pricing.input ?? null, output: data.pricing.output ?? null }
        : { input: null, output: null },
    });
  }
  return { counts, queue };
}

// ---------- Removal (warn-but-allow) ----------
// Hard-deletes the approved doc + upstream mapping in one transaction.
// School / individual assignments are intentionally left untouched: they
// resolve to stale keys (already handled as warnings, fail-closed).
// Throws INVALID_REQUEST when the key is malformed or unknown (consistent
// with getApprovedModel, maps to 400 via existing redact codes).
async function removeApprovedModel(modelKey, adminUid, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(modelKey);
  if (!id) {
    const err = new Error("invalid modelKey");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  const before = await getApprovedModel(id, { store: d.store });
  const hash = upstreamHash(before.upstreamModelId || "");
  const modelRef = d.store.collection(MODEL_COLLECTION).doc(id);
  const mapRef = d.store.collection(UPSTREAM_COLLECTION).doc(hash);
  try {
    await d.store.runTransaction(async (tx) => {
      const snap = await tx.get(modelRef);
      if (!snap.exists) {
        const err = new Error("unknown model");
        err.code = "INVALID_REQUEST";
        throw err;
      }
      tx.delete(modelRef);
      tx.delete(mapRef);
    });
  } catch (err) {
    if (err && err.code === "INVALID_REQUEST") throw err;
    const e = new Error("model store unavailable");
    e.code = "INTERNAL";
    throw e;
  }
  await d.audits.logAudit(
    {
      adminUid,
      action: "model.removed",
      target: { modelKey: id },
      result: "success",
      before: {
        displayName: before.displayName,
        upstreamModelId: before.upstreamModelId,
      },
    },
    d.store
  );
  return { ok: true, modelKey: id };
}

// ---------- Usage impact (read-only, for delete confirm) ----------
// Counts school policies + individual custom policies referencing the key.
// Bounded: schools scanned up to 500, users via array-contains up to 101.
// Returns truncated flags so UI can say "20+ shown" instead of exact totals.
async function getModelUsageCounts(modelKey, deps) {
  const d = { ...defaultDeps(), ...(deps || {}) };
  const id = cleanId(modelKey);
  if (!id) {
    const err = new Error("invalid modelKey");
    err.code = "INVALID_REQUEST";
    throw err;
  }
  // Validate the model exists so typos fail fast (same code as remove).
  await getApprovedModel(id, { store: d.store });

  let schoolIds = [];
  let schoolsTruncated = false;
  try {
    const snap = await d.store.collection("schoolModelPolicies").limit(500).get();
    const matched = [];
    for (const doc of snap.docs || []) {
      const data = doc.data() || {};
      const roles = data.roles || {};
      const sKeys = (roles.student && Array.isArray(roles.student.modelKeys) && roles.student.modelKeys) || [];
      const tKeys = (roles.teacher && Array.isArray(roles.teacher.modelKeys) && roles.teacher.modelKeys) || [];
      if (sKeys.includes(id) || tKeys.includes(id)) matched.push(doc.id);
    }
    schoolsTruncated = (snap.docs || []).length >= 500;
    schoolIds = matched.slice(0, 20);
    var schoolCount = matched.length;
  } catch (_) {
    const err = new Error("model store unavailable");
    err.code = "INTERNAL";
    throw err;
  }

  let userCount = 0;
  let usersTruncated = false;
  try {
    const q = d.store.collection("userModelPolicies").where("modelKeys", "array-contains", id).limit(101);
    const usnap = await q.get();
    const docs = (usnap && usnap.docs) || [];
    usersTruncated = docs.length >= 101;
    userCount = Math.min(docs.length, 100);
    if (usersTruncated) userCount = 100;
  } catch (_) {
    // array-contains may be unsupported in fakes: fall back to 0, not fatal.
    userCount = 0;
    usersTruncated = false;
  }

  return {
    modelKey: id,
    schools: { count: schoolCount, schoolIds, truncated: schoolsTruncated },
    users: { count: userCount, truncated: usersTruncated },
  };
}

module.exports = {
  MAX_ENSURE_ITEMS,
  listApprovedModelsAdmin,
  getApprovedModel,
  listEligibleManagedModels,
  listIndividualCreditModels,
  approveModel,
  updateApprovedModel,
  ensureCatalogueModels,
  resolveExistingUpstreamKeys,
  applyAssignmentCertification,
  removeApprovedModel,
  getModelUsageCounts,
  upstreamHash,
  setModelCertification,
  listUncertifiedModels,
};
