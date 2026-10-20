// functions-subi/src/routes/adminModelPolicies.js
// Superadmin school + individual MODEL ASSIGNMENT (Model Redesign).
// Mounted ONLY on subiAdminApi behind requireAuth + requireSuperAdmin.
// Firestore policy only — no secret, network, or provider access.
// School existence / user identity validated read-only via
// learnsmartDirectoryService; writes go to subiDb via modelPolicyService.
//
// ACCESS (who) is owned by accessService; LIMITS (how many) by
// monthlyLimitService. This router owns only WHICH models.

const express = require("express");
const policies = require("../services/modelPolicyService");
const catalogService = require("../services/modelCatalogService");
const {
  getManagedUserByUid,
  getSchool,
} = require("../services/learnsmartDirectoryService");
const { errorBody, statusFor, safeCode, logEvent } = require("../utils/redact");

function sendError(res, code, adminUid) {
  const c = safeCode(code);
  logEvent("model_policy.error", { adminUid, code: c, status: statusFor(c) });
  return res.status(statusFor(c)).json(errorBody(c));
}

function cleanSchoolId(value) {
  return String(value || "").trim().slice(0, 128);
}

function cleanUid(value) {
  return String(value || "").trim().slice(0, 128);
}

function router() {
  const r = express.Router();

  // ---------- School model assignment ----------

  // Read-only: never creates policy on GET. Missing doc -> empty lists.
  r.get("/admin/schools/:schoolId/models", async (req, res) => {
    try {
      const schoolId = cleanSchoolId(req.params.schoolId);
      const school = await getSchool(schoolId);
      if (!school || school.accountType !== "school") return sendError(res, "INVALID_REQUEST", req.subi && req.subi.uid);
      const policy = await policies.getSchoolModelPolicy(schoolId);
      const [student, teacher] = await Promise.all([
        policies.resolveApprovedSafe(policy.studentModelKeys),
        policies.resolveApprovedSafe(policy.teacherModelKeys),
      ]);
      return res.json({
        schoolId: policy.schoolId,
        studentModelKeys: policy.studentModelKeys,
        teacherModelKeys: policy.teacherModelKeys,
        studentStaleModelKeys: student.staleModelKeys,
        teacherStaleModelKeys: teacher.staleModelKeys,
        updatedAt: policy.updatedAt,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", req.subi && req.subi.uid);
    }
  });

  r.post("/admin/schools/:schoolId/models", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const schoolId = cleanSchoolId(req.params.schoolId);
    const body = req.body;
    if (
      !schoolId ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Array.isArray(body.studentModelKeys) ||
      !Array.isArray(body.teacherModelKeys)
    ) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    // Catalogue-assignment simplification: optional per-role catalogue
    // selections ({upstreamModelId, optional marks}). Keys-only clients keep
    // working unchanged; catalogue is fetched only when selections arrive.
    for (const field of ["studentCatalogue", "teacherCatalogue"]) {
      if (body[field] !== undefined) {
        if (!Array.isArray(body[field]) || body[field].length > 100) {
          return sendError(res, "INVALID_REQUEST", adminUid);
        }
        for (const item of body[field]) {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return sendError(res, "INVALID_REQUEST", adminUid);
          }
        }
      }
    }
    // Optimistic-concurrency token against stale-tab overwrites (optional;
    // omitted preserves legacy behavior). Any string/number/date passes
    // through; the service validates comparability.
    if (
      body.expectedUpdatedAt !== undefined &&
      body.expectedUpdatedAt !== null &&
      typeof body.expectedUpdatedAt !== "string" &&
      typeof body.expectedUpdatedAt !== "number" &&
      typeof body.expectedUpdatedAt !== "object"
    ) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      const school = await getSchool(schoolId);
      if (!school || school.accountType !== "school") return sendError(res, "INVALID_REQUEST", adminUid);
    } catch (_) {
      return sendError(res, "INTERNAL", adminUid);
    }
    try {
      let catalog = null;
      // Fetch the live catalogue ONLY when there are catalogue selections to
      // ensure. Keys-only saves (and empty arrays) must not require Secret
      // Manager / OpenRouter: the admin runtime SA holds secretVersionAdder
      // (add only), not secretAccessor, so a fetch here would fail with
      // SECRET_UNAVAILABLE and block even stale-cleanup saves.
      const needsCatalog =
        (Array.isArray(body.studentCatalogue) && body.studentCatalogue.length > 0) ||
        (Array.isArray(body.teacherCatalogue) && body.teacherCatalogue.length > 0);
      if (needsCatalog) {
        // Fresh catalogue for the mutation existence check (never the
        // 5-minute display cache): a stale cache here rejects newly added
        // upstream models that Superadmin already displays as selectable.
        const fetched = await catalogService.fetchCatalog({ refresh: true });
        catalog = fetched.models;
      }
      const out = await policies.setSchoolModelPolicy({
        schoolId,
        studentModelKeys: body.studentModelKeys,
        teacherModelKeys: body.teacherModelKeys,
        studentCatalogue: body.studentCatalogue,
        teacherCatalogue: body.teacherCatalogue,
        adminUid,
        ...(body.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}),
      }, catalog ? { catalog } : undefined);
      logEvent("school_models.updated", { adminUid, status: 200 });
      return res.json({ ok: true, ...out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  // ---------- Individual model assignment ----------

  r.get("/admin/users/:uid/models", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const uid = cleanUid(req.params.uid);
    if (!uid) return sendError(res, "INVALID_REQUEST", adminUid);
    try {
      // Trusted target: re-resolved from directory; nothing from frontend.
      const user = await getManagedUserByUid(uid);
      if (!user || user.accountType !== "individual") return sendError(res, "INVALID_REQUEST", adminUid);
      const [userPolicy, schoolPolicy] = await Promise.all([
        policies.getUserModelPolicy(user.uid),
        policies.getSchoolModelPolicy(user.schoolId),
      ]);
      // Raw doc straight through: missing/empty mode inherits, malformed
      // stored mode fails closed inside evaluateModelPolicy.
      const evaluated = policies.evaluateModelPolicy({
        userPolicy: { modelMode: userPolicy.modelMode, modelKeys: userPolicy.modelKeys },
        schoolPolicy: {
          roles: {
            student: { modelKeys: schoolPolicy.studentModelKeys },
            teacher: { modelKeys: schoolPolicy.teacherModelKeys },
          },
        },
        role: user.role,
        accountType: user.accountType,
      });
      const inheritedKeys =
        user.role === "student" ? schoolPolicy.studentModelKeys : schoolPolicy.teacherModelKeys;
      const { staleModelKeys } = await policies.resolveApprovedSafe(
        userPolicy.modelMode === "custom" ? userPolicy.modelKeys : []
      );
      let schoolName;
      try {
        const s = await getSchool(user.schoolId);
        if (s) schoolName = s.name;
      } catch (_) {
        // display-only enrichment; ignore failures
      }
      return res.json({
        uid: user.uid,
        displayName: user.displayName,
        role: user.role,
        schoolId: user.schoolId,
        ...(schoolName ? { schoolName } : {}),
        modelMode: userPolicy.modelMode,
        customModelKeys: userPolicy.modelKeys,
        inheritedModelKeys: inheritedKeys,
        effectiveModelKeys: evaluated.modelKeys,
        effectiveMode: evaluated.mode,
        staleModelKeys,
        updatedAt: userPolicy.updatedAt,
      });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  r.post("/admin/users/:uid/models", async (req, res) => {
    const adminUid = req.subi && req.subi.uid;
    const uid = cleanUid(req.params.uid);
    const body = req.body;
    if (!uid || !body || typeof body !== "object" || Array.isArray(body)) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    const mode = String(body.modelMode || "").trim().toLowerCase();
    if (mode !== "inherit" && mode !== "custom") {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    if (mode === "custom" && !Array.isArray(body.modelKeys)) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    if (body.catalogueSelections !== undefined) {
      if (
        mode !== "custom" ||
        !Array.isArray(body.catalogueSelections) ||
        body.catalogueSelections.length > 100
      ) {
        return sendError(res, "INVALID_REQUEST", adminUid);
      }
      for (const item of body.catalogueSelections) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return sendError(res, "INVALID_REQUEST", adminUid);
        }
      }
    }
    if (
      body.expectedUpdatedAt !== undefined &&
      body.expectedUpdatedAt !== null &&
      typeof body.expectedUpdatedAt !== "string" &&
      typeof body.expectedUpdatedAt !== "number" &&
      typeof body.expectedUpdatedAt !== "object"
    ) {
      return sendError(res, "INVALID_REQUEST", adminUid);
    }
    try {
      // Trusted target: re-resolved from directory; body identity ignored.
      const user = await getManagedUserByUid(uid);
      if (!user || user.accountType !== "individual") return sendError(res, "INVALID_REQUEST", adminUid);
      let catalog = null;
      // Same keys-only bypass as the school route: empty/omitted selections
      // must not require the catalogue fetch (admin runtime cannot read the
      // managed key — see above).
      if (Array.isArray(body.catalogueSelections) && body.catalogueSelections.length > 0) {
        // Fresh catalogue for the mutation existence check (see school route).
        const fetched = await catalogService.fetchCatalog({ refresh: true });
        catalog = fetched.models;
      }
      const out = await policies.setUserModelPolicy({
        uid: user.uid,
        modelMode: mode,
        modelKeys: mode === "custom" ? body.modelKeys : [],
        catalogueSelections: body.catalogueSelections,
        adminUid,
        trustedUser: { schoolId: user.schoolId, role: user.role, accountType: user.accountType },
        ...(body.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: body.expectedUpdatedAt } : {}),
      }, catalog ? { catalog } : undefined);
      logEvent(mode === "custom" ? "user_models.custom" : "user_models.inherit", {
        adminUid,
        status: 200,
      });
      return res.json({ ok: true, ...out });
    } catch (err) {
      return sendError(res, (err && err.code) || "INTERNAL", adminUid);
    }
  });

  return r;
}

module.exports = { adminModelPoliciesRouter: router };
