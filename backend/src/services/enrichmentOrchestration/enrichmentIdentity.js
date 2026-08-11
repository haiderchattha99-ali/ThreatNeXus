"use strict";

// Phase 10A-1 — every deterministic identity the orchestration layer depends
// on. Pure: no Prisma, no network, no wall clock, no randomness. The same
// inputs always produce the same digests, in this process and the next one.
//
// ---------------------------------------------------------------------------
// Three DIFFERENT identities, deliberately not collapsed into one
// ---------------------------------------------------------------------------
//   requestScopeHash   what was ASKED   (finding + trigger + force + targets)
//   idempotencyKey     which ASK        (scope + who/when asked it)
//   queryIdentityHash  what WORK        (provider + subject + query params)
//
// Collapsing request identity into work identity is exactly the defect the
// v2.1 correction addendum exists to fix: an active AbuseIPDB run suppressed a
// later Censys request, because "we are already working on this Finding" was
// mistaken for "we are already doing this piece of work". They are separate
// mechanisms here and can never be conflated by accident:
//
//   * idempotencyKey  is UNIQUE on FindingEnrichmentRun — it deduplicates the
//     same ask, so a double-submitted request creates one run.
//   * activeLookupKey is UNIQUE on ProviderLookupJob and carries
//     queryIdentityHash only while the job is non-terminal — it deduplicates
//     outbound work, so ten Findings on one IP share one job.
//
// Multiple differently-scoped runs therefore coexist, and several runs may
// point at one active lookup job. Both statements have to stay true.
//
// ---------------------------------------------------------------------------
// The hash contract is explicit, not "whatever JSON.stringify does"
// ---------------------------------------------------------------------------
// Same rule enrichmentCacheKey.js already established: the canonical form is a
// JSON array of sorted [key, value] pairs, so `{a, b}` and `{b, a}` hash
// identically by construction rather than by luck.

const crypto = require("node:crypto");

const { sanitizeQueryParams } = require("../enrichment/iocEnrichmentTypes");
const {
  EnrichmentSubjectError,
  canonicalizeSubjectValue,
  isKnownProvider,
  sortTargets,
} = require("./enrichmentSubject");

const HASH_ALGORITHM = "sha256";

// "|" cannot occur in a lowercase provider identifier, an enum value, a
// dotted-quad IPv4, a canonical CVE id or a hex digest, so concatenation is
// unambiguous and needs no escaping.
const FIELD_SEPARATOR = "|";

// --- Idempotency-Key request header bounds (Codex amendment 4) -------------
// The header is caller-supplied, so it is validated BEFORE it is hashed and
// its raw value never leaves this module: it is not persisted, not logged, not
// audited and not returned. Only the SHA-256-derived component reaches the
// database.
const MAX_IDEMPOTENCY_KEY_BYTES = 128;

// Rejects C0 controls (including CR, LF and TAB), DEL, and C1 controls. A
// control character in a header value is either a transport bug or an
// injection attempt; neither should be silently folded into a database key.
// Written as an explicit code-point scan rather than a regex literal so the
// control bytes themselves never appear in this source file.
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

class EnrichmentIdentityError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "EnrichmentIdentityError";
  }
}

function sha256Hex(value) {
  return crypto.createHash(HASH_ALGORITHM).update(value, "utf8").digest("hex");
}

/**
 * Canonical, key-order-independent serialization of allow-listed query
 * parameters. Exported so a test can assert on the exact hash INPUT (e.g. that
 * a supplied credential is absent from it), not only on the digest.
 *
 * Reuses P2-T2a's `sanitizeQueryParams` allow-list rather than defining a
 * second one, so the rule that keeps an accidental credential out of a
 * provider result is the same rule that keeps it out of a work identity.
 *
 * @param {object|null} queryParams
 * @returns {string} e.g. `[["maxAgeInDays",30]]`
 */
function serializeQueryParams(queryParams) {
  const sanitized = sanitizeQueryParams(queryParams);
  const pairs = Object.keys(sanitized)
    .sort()
    .map((key) => [key, sanitized[key]]);
  return JSON.stringify(pairs);
}

/**
 * The identity of one piece of OUTBOUND WORK.
 *
 * sha256(provider | subjectType | canonical subjectValue | queryParamsHash).
 *
 * subjectType is INSIDE the hash, so an IPv4 and a CVE can never collide even
 * if a future subject type had an overlapping textual form.
 *
 * @param {{provider: string, subjectType: string, subjectValue: string,
 *   queryParams?: object|null}} input
 * @returns {string} 64-char hex digest
 */
function computeQueryIdentityHash(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EnrichmentIdentityError("enrichmentIdentity: input must be an object");
  }
  const { provider, subjectType, subjectValue, queryParams = null } = input;

  if (!isKnownProvider(provider)) {
    throw new EnrichmentIdentityError(
      "enrichmentIdentity: provider must be a known lowercase provider identifier"
    );
  }
  // Canonicalize before hashing — never after. Throws EnrichmentSubjectError
  // for an invalid value, which callers treat as a validation failure.
  const canonicalValue = canonicalizeSubjectValue(subjectType, subjectValue);
  const queryParamsHash = sha256Hex(serializeQueryParams(queryParams));

  return sha256Hex(
    [provider, subjectType, canonicalValue, queryParamsHash].join(FIELD_SEPARATOR)
  );
}

/**
 * The identity of WHAT WAS ASKED.
 *
 * sha256 over findingId, trigger, force and the sorted unique
 * (provider, subjectType, subjectValue) triples. Two asks with the same scope
 * are the same ask; an ask that adds one provider is a different ask.
 *
 * `force` is inside the hash, so a forced ask never collapses into a
 * non-forced one — that would let a caller's explicit "ignore freshness"
 * silently resolve to a cached decision.
 *
 * @param {{findingId: number, trigger: string, force: boolean,
 *   targets: Array<{provider: string, subjectType: string,
 *   subjectValue: string}>}} input targets are canonicalized and deduplicated
 *   here, so caller ordering and repetition cannot change the digest.
 * @returns {string} 64-char hex digest
 */
function computeRequestScopeHash(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EnrichmentIdentityError("enrichmentIdentity: input must be an object");
  }
  const { findingId, trigger, force, targets } = input;

  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new EnrichmentIdentityError("enrichmentIdentity: findingId must be a positive integer");
  }
  if (typeof trigger !== "string" || trigger.trim() === "") {
    throw new EnrichmentIdentityError("enrichmentIdentity: trigger must be a non-empty string");
  }
  if (typeof force !== "boolean") {
    throw new EnrichmentIdentityError("enrichmentIdentity: force must be a boolean");
  }
  if (!Array.isArray(targets)) {
    throw new EnrichmentIdentityError("enrichmentIdentity: targets must be an array");
  }

  const canonicalTargets = targets.map((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new EnrichmentIdentityError("enrichmentIdentity: each target must be an object");
    }
    if (!isKnownProvider(target.provider)) {
      throw new EnrichmentIdentityError(
        "enrichmentIdentity: each target provider must be a known provider identifier"
      );
    }
    return {
      provider: target.provider,
      subjectType: target.subjectType,
      subjectValue: canonicalizeSubjectValue(target.subjectType, target.subjectValue),
    };
  });

  // Deduplicate AFTER canonicalization: " 8.8.8.8 " and "8.8.8.8" are one
  // target, and deduplicating before would have kept both.
  const seen = new Set();
  const unique = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const target of canonicalTargets) {
    const dedupKey = [target.provider, target.subjectType, target.subjectValue].join(
      FIELD_SEPARATOR
    );
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      unique.push(target);
    }
  }

  const serializedTargets = JSON.stringify(
    sortTargets(unique).map((target) => [target.provider, target.subjectType, target.subjectValue])
  );

  return sha256Hex(
    [String(findingId), trigger, String(force), serializedTargets].join(FIELD_SEPARATOR)
  );
}

/**
 * Validates a caller-supplied Idempotency-Key header and returns ONLY its
 * SHA-256 digest (Codex amendment 4).
 *
 * The raw value is never returned, persisted, logged, audited or echoed. The
 * error messages below never interpolate it either — a rejected key must not
 * reappear in a 400 body or a log line.
 *
 * @param {unknown} rawValue the header value, or undefined/null when absent
 * @returns {string|null} 64-char hex digest, or null when no header was sent
 * @throws {EnrichmentIdentityError} empty, oversized, non-string, or
 *   containing a control character
 */
function hashIdempotencyKeyHeader(rawValue) {
  if (rawValue === undefined || rawValue === null) return null;

  if (typeof rawValue !== "string") {
    throw new EnrichmentIdentityError("Idempotency-Key must be a string");
  }
  // Supplied-but-empty is a caller error, not "absent". Silently treating ""
  // as absent would make a broken client look idempotent when it is not.
  if (rawValue.trim() === "") {
    throw new EnrichmentIdentityError("Idempotency-Key must not be empty when supplied");
  }
  if (Buffer.byteLength(rawValue, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES) {
    throw new EnrichmentIdentityError(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes`
    );
  }
  if (hasControlCharacter(rawValue)) {
    throw new EnrichmentIdentityError("Idempotency-Key must not contain control characters");
  }

  return sha256Hex(rawValue);
}

/**
 * The unique key that deduplicates one ASK.
 *
 * INGESTION: `ing:<rawReportId>:<requestScopeHash>` — a report is processed
 *   once, so the report id plus the scope is the whole identity. Re-uploading
 *   the identical file re-derives the identical key and creates no second run.
 *
 * MANUAL: `man:<requestScopeHash>:<hashed Idempotency-Key | time bucket>` —
 *   with a caller-supplied key, that key decides. Without one, a coarse time
 *   bucket collapses a double-clicked button into one run while still letting
 *   a deliberate re-request a minute later be a genuinely new ask.
 *
 * @param {{trigger: string, requestScopeHash: string, rawReportId?: number|null,
 *   idempotencyKeyHash?: string|null, bucketedAt?: string|null}} input
 * @returns {string}
 */
function buildIdempotencyKey(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EnrichmentIdentityError("enrichmentIdentity: input must be an object");
  }
  const { trigger, requestScopeHash, rawReportId, idempotencyKeyHash, bucketedAt } = input;

  if (typeof requestScopeHash !== "string" || requestScopeHash === "") {
    throw new EnrichmentIdentityError("enrichmentIdentity: requestScopeHash is required");
  }

  if (trigger === "INGESTION") {
    if (!Number.isInteger(rawReportId) || rawReportId <= 0) {
      throw new EnrichmentIdentityError(
        "enrichmentIdentity: an INGESTION run requires a positive rawReportId"
      );
    }
    return `ing:${rawReportId}:${requestScopeHash}`;
  }

  if (trigger === "MANUAL") {
    const discriminator = idempotencyKeyHash || bucketedAt;
    if (typeof discriminator !== "string" || discriminator === "") {
      throw new EnrichmentIdentityError(
        "enrichmentIdentity: a MANUAL run requires an idempotencyKeyHash or a bucketedAt"
      );
    }
    return `man:${requestScopeHash}:${discriminator}`;
  }

  throw new EnrichmentIdentityError(`enrichmentIdentity: unsupported trigger "${String(trigger)}"`);
}

// The manual no-header fallback bucket. 60 seconds: long enough to absorb a
// double-click or a client retry, short enough that a deliberate re-request is
// not silently swallowed. Callers pass their own explicit `now`; this module
// never reads the wall clock.
const MANUAL_BUCKET_SECONDS = 60;

/**
 * Floors an explicit timestamp to the manual idempotency bucket.
 *
 * @param {Date} now the caller's single explicit evaluation time
 * @returns {string} ISO-8601 instant at the bucket floor
 */
function manualTimeBucket(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new EnrichmentIdentityError("enrichmentIdentity: now must be an explicit, valid Date");
  }
  const bucketMs = MANUAL_BUCKET_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / bucketMs) * bucketMs).toISOString();
}

module.exports = {
  EnrichmentIdentityError,
  EnrichmentSubjectError,
  HASH_ALGORITHM,
  FIELD_SEPARATOR,
  MAX_IDEMPOTENCY_KEY_BYTES,
  MANUAL_BUCKET_SECONDS,
  serializeQueryParams,
  computeQueryIdentityHash,
  computeRequestScopeHash,
  hashIdempotencyKeyHeader,
  buildIdempotencyKey,
  manualTimeBucket,
};
