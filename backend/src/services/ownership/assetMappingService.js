"use strict";

// AssetMapping registry service (P2-T1) — create/update/disable/list. This is
// the ONLY place that decides whether an AssetMapping payload is coherent
// (exactly one identifier field populated for its mappingType, a valid
// validity window). The database cannot express "exactly one of three
// nullable field groups, matching a fourth column" as a portable Postgres
// CHECK through Prisma without raw SQL, so this boundary is where that rule
// actually lives — see the AssetMappingType comment in schema.prisma.
//
// No hard delete: AssetMapping rows are disabled, never removed, so that
// FindingOwnership.matchedMappingId keeps meaning even after the mapping
// that produced it is later turned off.

const { AssetMappingType, AssetMappingSource, OwnershipConfidence } = require("@prisma/client");

const { isValidIpv4, ipv4ToInt, cidrToRange, canonicalizeCidr, intToIpv4 } = require("./ipv4Cidr");

const MAX_PROVENANCE_NOTE_LENGTH = 1000;
const MAX_ASN = 4294967295;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

class AssetMappingValidationError extends Error {
  constructor(fields) {
    super(`AssetMapping validation failed: ${fields.join(", ")}`);
    this.name = "AssetMappingValidationError";
    this.fields = fields;
  }
}

class AssetMappingNotFoundError extends Error {
  constructor(id) {
    super(`AssetMapping ${id} not found`);
    this.name = "AssetMappingNotFoundError";
  }
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNullableDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date; // undefined signals "invalid"
}

function normalizeProvenanceNote(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined; // invalid marker
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_PROVENANCE_NOTE_LENGTH) return undefined; // invalid marker
  return trimmed;
}

// Bounded to a short, safe preview — this is the only form provenanceNote may
// ever reach an AuditLog payload in (see the audit() calls below).
function boundedProvenancePreview(value) {
  if (typeof value !== "string" || value === "") return null;
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

// Builds the exactIp/cidr/prefixLength/ipStart/ipEnd/asn column set for a
// mappingType from the caller's payload — irrelevant fields are always
// derived as null, never carried over from whatever the client happened to
// also send. Returns { values, errors }.
function deriveIdentifierFields(mappingType, body) {
  const errors = [];
  const values = {
    exactIp: null,
    cidr: null,
    prefixLength: null,
    ipStart: null,
    ipEnd: null,
    asn: null,
  };

  if (mappingType === AssetMappingType.EXACT_IP) {
    if (body.cidr !== undefined || body.asn !== undefined) {
      errors.push("cidr/asn must not be supplied for an EXACT_IP mapping");
    }
    if (typeof body.exactIp !== "string" || !isValidIpv4(body.exactIp)) {
      errors.push("exactIp must be a strict IPv4 address");
    } else {
      const ipInt = ipv4ToInt(body.exactIp);
      values.exactIp = body.exactIp;
      values.ipStart = ipInt;
      values.ipEnd = ipInt;
    }
    return { values, errors };
  }

  if (mappingType === AssetMappingType.CIDR) {
    if (body.exactIp !== undefined || body.asn !== undefined) {
      errors.push("exactIp/asn must not be supplied for a CIDR mapping");
    }
    if (typeof body.cidr !== "string") {
      errors.push("cidr must be a string in a.b.c.d/n form");
    } else {
      try {
        const range = cidrToRange(body.cidr);
        values.cidr = canonicalizeCidr(body.cidr);
        values.prefixLength = range.prefixLength;
        values.ipStart = range.ipStart;
        values.ipEnd = range.ipEnd;
      } catch (error) {
        errors.push("cidr must be a strict, valid a.b.c.d/n value");
      }
    }
    return { values, errors };
  }

  if (mappingType === AssetMappingType.ASN) {
    if (body.exactIp !== undefined || body.cidr !== undefined) {
      errors.push("exactIp/cidr must not be supplied for an ASN mapping");
    }
    const asn = typeof body.asn === "string" ? Number(body.asn.trim()) : body.asn;
    if (!Number.isInteger(asn) || asn <= 0 || asn > MAX_ASN) {
      errors.push("asn must be a positive integer ASN");
    } else {
      values.asn = asn;
    }
    return { values, errors };
  }

  errors.push("mappingType must be one of EXACT_IP, CIDR, ASN");
  return { values, errors };
}

// Validates the caller-controlled, type-independent fields common to create.
function validateCommonCreateFields(body) {
  const errors = [];
  const values = {};

  if (!Number.isInteger(body.organizationId) || body.organizationId <= 0) {
    errors.push("organizationId must be a positive integer");
  } else {
    values.organizationId = body.organizationId;
  }

  if (!Object.values(OwnershipConfidence).includes(body.confidence)) {
    errors.push("confidence must be one of " + Object.values(OwnershipConfidence).join(", "));
  } else {
    values.confidence = body.confidence;
  }

  if (!Object.values(AssetMappingSource).includes(body.source)) {
    errors.push("source must be one of " + Object.values(AssetMappingSource).join(", "));
  } else {
    values.source = body.source;
  }

  const provenanceNote = normalizeProvenanceNote(body.provenanceNote);
  if (provenanceNote === undefined) {
    errors.push(`provenanceNote must be a string of at most ${MAX_PROVENANCE_NOTE_LENGTH} characters`);
  } else {
    values.provenanceNote = provenanceNote;
  }

  values.mappingConfirmed = body.mappingConfirmed === true;

  const validFrom = toNullableDate(body.validFrom);
  const validUntil = toNullableDate(body.validUntil);
  if (validFrom === undefined) {
    errors.push("validFrom must be a valid date or null");
  } else {
    values.validFrom = validFrom;
  }
  if (validUntil === undefined) {
    errors.push("validUntil must be a valid date or null");
  } else {
    values.validUntil = validUntil;
  }
  if (validFrom && validUntil && validUntil < validFrom) {
    errors.push("validUntil must not precede validFrom");
  }

  return { values, errors };
}

async function createAssetMapping(body, { client, actorUserId } = {}) {
  if (!isPlainObject(body)) {
    throw new AssetMappingValidationError(["body"]);
  }

  const common = validateCommonCreateFields(body);
  const identifiers = deriveIdentifierFields(body.mappingType, body);
  const errors = [...common.errors, ...identifiers.errors];
  if (errors.length > 0) {
    throw new AssetMappingValidationError(errors);
  }

  const prisma = resolveClient(client);
  const mapping = await prisma.assetMapping.create({
    data: {
      organizationId: common.values.organizationId,
      mappingType: body.mappingType,
      ...identifiers.values,
      confidence: common.values.confidence,
      source: common.values.source,
      provenanceNote: common.values.provenanceNote,
      mappingConfirmed: common.values.mappingConfirmed,
      validFrom: common.values.validFrom,
      validUntil: common.values.validUntil,
      createdByUserId: Number.isInteger(actorUserId) ? actorUserId : null,
      updatedByUserId: Number.isInteger(actorUserId) ? actorUserId : null,
    },
  });

  return mapping;
}

// Fields a PATCH may change. mappingType and the identifier fields
// (exactIp/cidr/prefixLength/asn) are deliberately excluded — retargeting a
// mapping's address is a new claim, not an edit of the old one; disable the
// old mapping and create a new one instead.
const UPDATABLE_FIELDS = [
  "organizationId",
  "confidence",
  "source",
  "provenanceNote",
  "mappingConfirmed",
  "validFrom",
  "validUntil",
];

async function updateAssetMapping(id, body, { client, actorUserId } = {}) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new AssetMappingValidationError(["id"]);
  }
  if (!isPlainObject(body)) {
    throw new AssetMappingValidationError(["body"]);
  }

  const prisma = resolveClient(client);
  const existing = await prisma.assetMapping.findUnique({ where: { id } });
  if (!existing) {
    throw new AssetMappingNotFoundError(id);
  }

  const submitted = {};
  UPDATABLE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined) {
      submitted[field] = body[field];
    }
  });

  if (Object.keys(submitted).length === 0) {
    throw new AssetMappingValidationError(["no updatable fields supplied"]);
  }

  const errors = [];
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(submitted, "organizationId")) {
    if (!Number.isInteger(submitted.organizationId) || submitted.organizationId <= 0) {
      errors.push("organizationId must be a positive integer");
    } else {
      updates.organizationId = submitted.organizationId;
    }
  }

  if (Object.prototype.hasOwnProperty.call(submitted, "confidence")) {
    if (!Object.values(OwnershipConfidence).includes(submitted.confidence)) {
      errors.push("confidence must be one of " + Object.values(OwnershipConfidence).join(", "));
    } else {
      updates.confidence = submitted.confidence;
    }
  }

  if (Object.prototype.hasOwnProperty.call(submitted, "source")) {
    if (!Object.values(AssetMappingSource).includes(submitted.source)) {
      errors.push("source must be one of " + Object.values(AssetMappingSource).join(", "));
    } else {
      updates.source = submitted.source;
    }
  }

  if (Object.prototype.hasOwnProperty.call(submitted, "provenanceNote")) {
    const provenanceNote = normalizeProvenanceNote(submitted.provenanceNote);
    if (provenanceNote === undefined) {
      errors.push(`provenanceNote must be a string of at most ${MAX_PROVENANCE_NOTE_LENGTH} characters`);
    } else {
      updates.provenanceNote = provenanceNote;
    }
  }

  if (Object.prototype.hasOwnProperty.call(submitted, "mappingConfirmed")) {
    updates.mappingConfirmed = submitted.mappingConfirmed === true;
  }

  let nextValidFrom = existing.validFrom;
  let nextValidUntil = existing.validUntil;

  if (Object.prototype.hasOwnProperty.call(submitted, "validFrom")) {
    const validFrom = toNullableDate(submitted.validFrom);
    if (validFrom === undefined) {
      errors.push("validFrom must be a valid date or null");
    } else {
      updates.validFrom = validFrom;
      nextValidFrom = validFrom;
    }
  }
  if (Object.prototype.hasOwnProperty.call(submitted, "validUntil")) {
    const validUntil = toNullableDate(submitted.validUntil);
    if (validUntil === undefined) {
      errors.push("validUntil must be a valid date or null");
    } else {
      updates.validUntil = validUntil;
      nextValidUntil = validUntil;
    }
  }
  if (nextValidFrom && nextValidUntil && nextValidUntil < nextValidFrom) {
    errors.push("validUntil must not precede validFrom");
  }

  if (errors.length > 0) {
    throw new AssetMappingValidationError(errors);
  }

  updates.updatedByUserId = Number.isInteger(actorUserId) ? actorUserId : null;

  const updated = await prisma.assetMapping.update({ where: { id }, data: updates });
  return { before: existing, after: updated };
}

async function disableAssetMapping(id, { client, actorUserId } = {}) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new AssetMappingValidationError(["id"]);
  }

  const prisma = resolveClient(client);
  const existing = await prisma.assetMapping.findUnique({ where: { id } });
  if (!existing) {
    throw new AssetMappingNotFoundError(id);
  }

  if (existing.enabled === false) {
    return { before: existing, after: existing, alreadyDisabled: true };
  }

  const updated = await prisma.assetMapping.update({
    where: { id },
    data: { enabled: false, updatedByUserId: Number.isInteger(actorUserId) ? actorUserId : null },
  });

  return { before: existing, after: updated, alreadyDisabled: false };
}

function resolvePagination(query = {}) {
  const rawPage = Number.parseInt(query.page, 10);
  const rawPageSize = Number.parseInt(query.pageSize, 10);
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize =
    Number.isInteger(rawPageSize) && rawPageSize > 0
      ? Math.min(rawPageSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  return { page, pageSize };
}

// Filters: organizationId, mappingType, enabled — all optional, all
// exact-match. No free-text search (nothing here is meant to be grep-able
// evidence). Ordered by id ascending so pagination is stable across pages.
async function listAssetMappings(query = {}, { client } = {}) {
  const prisma = resolveClient(client);
  const { page, pageSize } = resolvePagination(query);

  const where = {};
  if (query.organizationId !== undefined) {
    const organizationId = Number.parseInt(query.organizationId, 10);
    if (Number.isInteger(organizationId) && organizationId > 0) {
      where.organizationId = organizationId;
    }
  }
  if (
    typeof query.mappingType === "string" &&
    Object.values(AssetMappingType).includes(query.mappingType)
  ) {
    where.mappingType = query.mappingType;
  }
  if (query.enabled === "true") where.enabled = true;
  if (query.enabled === "false") where.enabled = false;

  const [items, total] = await Promise.all([
    prisma.assetMapping.findMany({
      where,
      orderBy: { id: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.assetMapping.count({ where }),
  ]);

  return { items, total, page, pageSize };
}

// Serializes an AssetMapping row for an API response: BigInt ipStart/ipEnd
// are NEVER returned raw (JSON.stringify throws on a bare BigInt anyway, but
// this is the single choke point that guarantees it even if that changes) —
// they are re-expressed as canonical dotted-quad/CIDR display strings that
// duplicate exactIp/cidr, so a caller never needs the raw integer range.
function serializeAssetMapping(mapping) {
  if (!mapping) return null;
  return {
    id: mapping.id,
    organizationId: mapping.organizationId,
    mappingType: mapping.mappingType,
    exactIp: mapping.exactIp,
    cidr: mapping.cidr,
    prefixLength: mapping.prefixLength,
    asn: mapping.asn,
    confidence: mapping.confidence,
    source: mapping.source,
    provenanceNote: mapping.provenanceNote,
    mappingConfirmed: mapping.mappingConfirmed,
    enabled: mapping.enabled,
    validFrom: mapping.validFrom,
    validUntil: mapping.validUntil,
    createdByUserId: mapping.createdByUserId,
    updatedByUserId: mapping.updatedByUserId,
    createdAt: mapping.createdAt,
    updatedAt: mapping.updatedAt,
  };
}

// Safe, bounded audit summary — never the raw provenanceNote, never
// ipStart/ipEnd BigInts.
function assetMappingAuditSummary(mapping) {
  if (!mapping) return null;
  return {
    id: mapping.id,
    organizationId: mapping.organizationId,
    mappingType: mapping.mappingType,
    exactIp: mapping.exactIp,
    cidr: mapping.cidr,
    prefixLength: mapping.prefixLength,
    asn: mapping.asn,
    confidence: mapping.confidence,
    source: mapping.source,
    provenanceNote: boundedProvenancePreview(mapping.provenanceNote),
    mappingConfirmed: mapping.mappingConfirmed,
    enabled: mapping.enabled,
  };
}

module.exports = {
  AssetMappingValidationError,
  AssetMappingNotFoundError,
  MAX_PROVENANCE_NOTE_LENGTH,
  MAX_ASN,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  deriveIdentifierFields,
  createAssetMapping,
  updateAssetMapping,
  disableAssetMapping,
  listAssetMappings,
  resolvePagination,
  serializeAssetMapping,
  assetMappingAuditSummary,
};
