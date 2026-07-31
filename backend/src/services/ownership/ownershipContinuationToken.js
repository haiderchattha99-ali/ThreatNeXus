"use strict";

// ===========================================================================
// Server-issued continuation tokens for bounded ownership re-resolution.
//
// WHY NOT JUST ACCEPT `afterId`?
// ------------------------------
// Bounded re-resolution processes one batch and reports that more candidates
// remain. Continuing needs a cursor. But the cursor IS a Finding id, and the
// packet's input rules are explicit: a caller may not supply an internal
// cursor value, and may not supply a continuation token the server did not
// issue. Accepting a raw `afterId` from the request body would hand an ADMIN
// (or anything that reached an ADMIN token) a way to point re-resolution at an
// arbitrary row range and to probe which Finding ids exist by watching the
// candidate counts change.
//
// So the cursor never crosses the API boundary in the clear. The server mints
// an opaque token over {mappingId, afterId}, HMAC-signed with the application
// secret, and only ever accepts one back that:
//   * verifies under that HMAC (so it was issued by this server), and
//   * names the SAME mapping id as the URL being called (so a token minted for
//     one mapping cannot be replayed against another).
//
// This is a tamper-evidence boundary, not a confidentiality one: the payload
// is readable, it simply cannot be forged or moved between mappings. That is
// exactly the property the rule asks for.
//
// No expiry is attached. A stale cursor is harmless here — re-resolution is
// idempotent (an unchanged outcome writes nothing), Finding ids are monotonic
// and Findings are never hard-deleted, so resuming from an old cursor can only
// re-examine already-correct rows, never skip new ones.
// ===========================================================================

const crypto = require("node:crypto");

class ContinuationTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContinuationTokenError";
  }
}

function secret() {
  // Required lazily: config/env validates the whole application configuration
  // at require time, and this module is pulled in by unit tests that have no
  // reason to need it.
  // eslint-disable-next-line global-require
  return require("../../config/env").JWT_SECRET;
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

/**
 * Mints an opaque continuation token for (mappingId, afterId).
 * Returns null when there is nothing to continue.
 */
function issueContinuationToken(mappingId, afterId) {
  if (!Number.isInteger(mappingId) || !Number.isInteger(afterId) || afterId <= 0) return null;
  const payloadB64 = Buffer.from(JSON.stringify({ m: mappingId, a: afterId })).toString(
    "base64url"
  );
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verifies a token and returns its afterId, or throws ContinuationTokenError.
 *
 * @param {unknown} token         the value supplied by the caller
 * @param {number}  expectedMappingId the mapping id from the request URL
 */
function readContinuationToken(token, expectedMappingId) {
  if (typeof token !== "string" || token === "") {
    throw new ContinuationTokenError("continuationToken must be a non-empty string");
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new ContinuationTokenError("continuationToken is malformed");
  }
  const [payloadB64, providedSignature] = parts;

  const expectedSignature = sign(payloadB64);
  const providedBuf = Buffer.from(providedSignature);
  const expectedBuf = Buffer.from(expectedSignature);
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new ContinuationTokenError("continuationToken signature is invalid");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch (error) {
    throw new ContinuationTokenError("continuationToken payload is unreadable");
  }

  if (!payload || !Number.isInteger(payload.m) || !Number.isInteger(payload.a)) {
    throw new ContinuationTokenError("continuationToken payload is invalid");
  }
  // A token minted for one mapping must never drive another mapping's batch.
  if (payload.m !== expectedMappingId) {
    throw new ContinuationTokenError("continuationToken was issued for a different mapping");
  }
  return payload.a;
}

module.exports = {
  ContinuationTokenError,
  issueContinuationToken,
  readContinuationToken,
};
