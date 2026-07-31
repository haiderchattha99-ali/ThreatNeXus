"use strict";

// AssetMapping registry HTTP surface (P2-T1). Thin by design: all validation
// and persistence lives in assetMappingService.js; this layer parses the
// request, maps service errors to HTTP status codes, and writes the
// "ownership.mapping.*" audit events (assetMappingService itself is a pure
// CRUD/validation layer with no audit side effects, matching how
// organizationController owns audits for Organization).

const prisma = require("../config/prisma");
const { AUDIT_OUTCOMES, buildAuditContext, safeLogAuditEvent } = require("../services/auditService");
const { parseResourceId } = require("../lib/validation");
const {
  AssetMappingValidationError,
  AssetMappingNotFoundError,
  createAssetMapping,
  updateAssetMapping,
  disableAssetMapping,
  listAssetMappings,
  serializeAssetMapping,
  assetMappingAuditSummary,
} = require("../services/ownership/assetMappingService");

const {
  reResolveForMapping,
  reResolutionAuditSummary,
  normalizeBatchSize,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
} = require("../services/ownership/ownershipReResolutionService");
const {
  ContinuationTokenError,
  issueContinuationToken,
  readContinuationToken,
} = require("../services/ownership/ownershipContinuationToken");

const ASSET_MAPPING_ENTITY_TYPE = "AssetMapping";
const PRISMA_FOREIGN_KEY_VIOLATION = "P2003";

// Fields a PATCH may change that actually alter what resolveOwnership would
// decide. `confidence`, `source`, `provenanceNote` and `mappingConfirmed` are
// deliberately NOT here: the resolver derives its own confidence from the
// matched tier/prefix length and never reads those columns, so changing them
// cannot change an ownership outcome and must not trigger a re-resolution
// sweep. organizationId changes who owns; validFrom/validUntil change whether
// the mapping is active at all (see ownershipResolver.isActiveMapping).
const PRECEDENCE_RELEVANT_FIELDS = Object.freeze(["organizationId", "validFrom", "validUntil"]);

function sameValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function isPrecedenceRelevantChange(before, after) {
  return PRECEDENCE_RELEVANT_FIELDS.some((field) => !sameValue(before[field], after[field]));
}

/**
 * Runs ONE bounded re-resolution batch after a mapping mutation has already
 * committed, and shapes the safe client-facing view of it.
 *
 * Deliberately outside the mutation: no Finding query, no resolution loop, no
 * risk scoring and no audit write ever runs inside the mapping write. The
 * mapping stays committed regardless of what happens here — reResolveForMapping
 * never throws.
 *
 * `truncated` is surfaced with a server-issued continuation token so the
 * response can never silently imply full re-resolution when only one batch ran.
 */
async function runBoundedReResolution(req, mapping, batchSize) {
  const summary = await reResolveForMapping(mapping, {
    client: prisma,
    // Captured once, here, for the whole batch — the service never reads the clock.
    asOf: new Date(),
    batchSize,
    auditContext: buildAuditContext(req),
  });

  return {
    ...reResolutionAuditSummary(summary),
    continuationToken: summary.truncated
      ? issueContinuationToken(mapping.id, summary.nextAfterId)
      : null,
  };
}

const audit = async (req, event) => {
  try {
    await safeLogAuditEvent({ ...buildAuditContext(req), ...event });
  } catch (err) {
    console.error("AssetMapping audit failed", { name: err && err.name });
  }
};

const serverError = (res, label, err) => {
  console.error(label, { name: err && err.name });
  return res.status(500).json({ success: false, message: "Server Error" });
};

const actorUserId = (req) => (req.user && Number.isInteger(req.user.id) ? req.user.id : null);

exports.listMappings = async (req, res) => {
  try {
    const result = await listAssetMappings(req.query || {}, { client: prisma });
    return res.status(200).json({
      success: true,
      data: result.items.map(serializeAssetMapping),
      pagination: { page: result.page, pageSize: result.pageSize, total: result.total },
    });
  } catch (error) {
    return serverError(res, "Failed to list asset mappings", error);
  }
};

exports.createMapping = async (req, res) => {
  try {
    const mapping = await createAssetMapping(req.body, {
      client: prisma,
      actorUserId: actorUserId(req),
    });

    await audit(req, {
      action: "ownership.mapping.created",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: ASSET_MAPPING_ENTITY_TYPE,
      entityId: mapping.id,
      after: assetMappingAuditSummary(mapping),
      reason: "AssetMapping created",
    });

    // A brand-new mapping can change ownership for anything in its range.
    const reResolution = await runBoundedReResolution(req, mapping);

    return res
      .status(201)
      .json({ success: true, data: serializeAssetMapping(mapping), reResolution });
  } catch (error) {
    if (error instanceof AssetMappingValidationError) {
      await audit(req, {
        action: "ownership.mapping.created",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ASSET_MAPPING_ENTITY_TYPE,
        reason: `AssetMapping creation rejected: invalid fields (${error.fields.join(", ")})`,
      });
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: error.fields,
      });
    }
    if (error && error.code === PRISMA_FOREIGN_KEY_VIOLATION) {
      await audit(req, {
        action: "ownership.mapping.created",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ASSET_MAPPING_ENTITY_TYPE,
        reason: "AssetMapping creation rejected: organization not found",
      });
      return res.status(400).json({
        success: false,
        message: "organizationId does not reference an existing organization.",
      });
    }
    return serverError(res, "Failed to create asset mapping", error);
  }
};

exports.updateMapping = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid asset mapping id." });
  }

  try {
    const { before, after } = await updateAssetMapping(id, req.body, {
      client: prisma,
      actorUserId: actorUserId(req),
    });

    await audit(req, {
      action: "ownership.mapping.updated",
      outcome: AUDIT_OUTCOMES.SUCCESS,
      entityType: ASSET_MAPPING_ENTITY_TYPE,
      entityId: id,
      before: assetMappingAuditSummary(before),
      after: assetMappingAuditSummary(after),
      reason: "AssetMapping updated",
    });

    // Only a precedence-relevant edit can change an ownership outcome; a
    // provenance-note edit must not trigger a sweep.
    const reResolution = isPrecedenceRelevantChange(before, after)
      ? await runBoundedReResolution(req, after)
      : null;

    return res.status(200).json({ success: true, data: serializeAssetMapping(after), reResolution });
  } catch (error) {
    if (error instanceof AssetMappingNotFoundError) {
      return res.status(404).json({ success: false, message: "Asset mapping not found." });
    }
    if (error instanceof AssetMappingValidationError) {
      await audit(req, {
        action: "ownership.mapping.updated",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ASSET_MAPPING_ENTITY_TYPE,
        entityId: id,
        reason: `AssetMapping update rejected: invalid fields (${error.fields.join(", ")})`,
      });
      return res.status(400).json({
        success: false,
        message: "Missing or invalid fields.",
        fields: error.fields,
      });
    }
    if (error && error.code === PRISMA_FOREIGN_KEY_VIOLATION) {
      await audit(req, {
        action: "ownership.mapping.updated",
        outcome: AUDIT_OUTCOMES.FAILURE,
        entityType: ASSET_MAPPING_ENTITY_TYPE,
        entityId: id,
        reason: "AssetMapping update rejected: organization not found",
      });
      return res.status(400).json({
        success: false,
        message: "organizationId does not reference an existing organization.",
      });
    }
    return serverError(res, "Failed to update asset mapping", error);
  }
};

// The ONLY fields this endpoint accepts. Anything else — actorUserId, asOf,
// afterId/cursor, batch worker id, riskScore, confidence, status, resolver
// result, matchedMappingId — is rejected outright rather than ignored, so a
// caller can never steer resolution, backdate a batch, impersonate an actor or
// inject a cursor. Rejecting (not ignoring) is deliberate: silently dropping a
// field a caller believed was applied is its own failure mode.
const RE_RESOLVE_ALLOWED_FIELDS = Object.freeze(["batchSize", "continuationToken"]);

/**
 * ADMIN-only bounded continuation of ownership re-resolution for one mapping.
 *
 * Exists because a mutation response may report `truncated: true`. Rather than
 * silently leaving ownership half-re-resolved, or spawning a background worker
 * to finish the job, the remaining work is an explicit, bounded, audited
 * ADMIN action. No daemon, no cron, no self-rescheduling.
 */
exports.reResolveMapping = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid asset mapping id." });
  }

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const unexpected = Object.keys(body).filter(
    (key) => !RE_RESOLVE_ALLOWED_FIELDS.includes(key)
  );
  if (unexpected.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Unexpected fields.",
      fields: unexpected,
    });
  }

  if (
    Object.prototype.hasOwnProperty.call(body, "batchSize") &&
    (!Number.isInteger(body.batchSize) ||
      body.batchSize < MIN_BATCH_SIZE ||
      body.batchSize > MAX_BATCH_SIZE)
  ) {
    return res.status(400).json({
      success: false,
      message: `batchSize must be an integer between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}.`,
      fields: ["batchSize"],
    });
  }

  let afterId = 0;
  if (Object.prototype.hasOwnProperty.call(body, "continuationToken")) {
    try {
      afterId = readContinuationToken(body.continuationToken, id);
    } catch (error) {
      if (error instanceof ContinuationTokenError) {
        return res.status(400).json({
          success: false,
          message: "Invalid continuation token.",
          fields: ["continuationToken"],
        });
      }
      return serverError(res, "Failed to read continuation token", error);
    }
  }

  try {
    const mapping = await prisma.assetMapping.findUnique({ where: { id } });
    if (!mapping) {
      return res.status(404).json({ success: false, message: "Asset mapping not found." });
    }

    const summary = await reResolveForMapping(mapping, {
      client: prisma,
      asOf: new Date(),
      batchSize: normalizeBatchSize(body.batchSize),
      afterId,
      auditContext: buildAuditContext(req),
    });

    return res.status(200).json({
      success: true,
      data: {
        ...reResolutionAuditSummary(summary),
        continuationToken: summary.truncated
          ? issueContinuationToken(mapping.id, summary.nextAfterId)
          : null,
      },
    });
  } catch (error) {
    return serverError(res, "Failed to re-resolve ownership for asset mapping", error);
  }
};

exports.disableMapping = async (req, res) => {
  const id = parseResourceId(req.params.id);
  if (id === null) {
    return res.status(400).json({ success: false, message: "Invalid asset mapping id." });
  }

  try {
    const { before, after, alreadyDisabled } = await disableAssetMapping(id, {
      client: prisma,
      actorUserId: actorUserId(req),
    });

    if (!alreadyDisabled) {
      await audit(req, {
        action: "ownership.mapping.disabled",
        outcome: AUDIT_OUTCOMES.SUCCESS,
        entityType: ASSET_MAPPING_ENTITY_TYPE,
        entityId: id,
        before: assetMappingAuditSummary(before),
        after: assetMappingAuditSummary(after),
        reason: "AssetMapping disabled",
      });
    }

    // Disabling releases whatever this mapping currently attributes. Skipped
    // when it was already disabled — nothing changed, so nothing can re-decide.
    const reResolution = alreadyDisabled ? null : await runBoundedReResolution(req, after);

    return res.status(200).json({ success: true, data: serializeAssetMapping(after), reResolution });
  } catch (error) {
    if (error instanceof AssetMappingNotFoundError) {
      return res.status(404).json({ success: false, message: "Asset mapping not found." });
    }
    return serverError(res, "Failed to disable asset mapping", error);
  }
};
