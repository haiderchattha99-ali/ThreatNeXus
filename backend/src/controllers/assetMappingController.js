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

const ASSET_MAPPING_ENTITY_TYPE = "AssetMapping";
const PRISMA_FOREIGN_KEY_VIOLATION = "P2003";

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

    return res.status(201).json({ success: true, data: serializeAssetMapping(mapping) });
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

    return res.status(200).json({ success: true, data: serializeAssetMapping(after) });
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

    return res.status(200).json({ success: true, data: serializeAssetMapping(after) });
  } catch (error) {
    if (error instanceof AssetMappingNotFoundError) {
      return res.status(404).json({ success: false, message: "Asset mapping not found." });
    }
    return serverError(res, "Failed to disable asset mapping", error);
  }
};
