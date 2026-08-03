"use strict";

// The AI mapping-suggestion provider contract, and the DEFAULT provider.
//
// ===========================================================================
// The contract, and why it is this small
// ===========================================================================
// A provider is:
//
//   {
//     name: string,                    // stable, lowercase, no credential
//     model: string|null,              // public model identity, no credential
//     isEnabled: boolean,
//     suggestMappings({snapshot, asOf, signal}) -> Promise<ProviderResult>
//   }
//
//   ProviderResult = { status: "DISABLED"|"COMPLETED"|"FAILED",
//                      suggestions: Array<candidate>,
//                      model?: string|null }
//
// ONE method. It takes a bounded, already-minimized snapshot and it returns
// DATA. It receives no Prisma client, no transaction, no repository, no HTTP
// request or response, no user, no capability, no audit logger and no file
// handle.
//
// That omission IS the safety control. A provider in this system cannot alter a
// RiskScore or a contribution, cannot pick a risk band, cannot approve its own
// output, cannot create an ownership mapping, cannot attach a CVE, cannot
// close, reopen or resolve a case, cannot create, approve, export or deliver a
// notification, cannot record an organization response, cannot send email,
// cannot run enrichment and cannot scan anything — not because a rule forbids
// it, but because it is handed nothing it could do any of those things with.
// tests/unit/aiSafetyBoundaries.test.js asserts the surface stays this small.
//
// `suggestMappings` must NEVER throw for an expected outcome (disabled,
// unreachable, malformed upstream). It returns a FAILED result instead. Only a
// genuine programmer error (a missing `asOf`) throws — the same convention as
// the Phase 2 IOC enrichment provider contract.
//
// ===========================================================================
// DisabledAiMappingProvider is the shipped default
// ===========================================================================
// AI_ENABLED defaults to false, AI_PROVIDER defaults to a name that resolves
// here, and this provider makes no network call of any kind. It has no fetch,
// no timer, no worker, no key and no base URL. The application starts, and
// every Phase 0-5 workflow completes, with this provider in place — which is
// what "AI is optional" has to mean to be worth saying.

const { PROVIDER_RESULT_STATUSES } = require("./aiSuggestionRules");

const DISABLED_PROVIDER_NAME = "disabled";

function assertValidAsOf(asOf) {
  // A programmer error, not an expected outcome: a provider must never read the
  // wall clock itself (every result must be reproducible from its inputs), so a
  // missing asOf means the caller is broken.
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("aiMappingProvider: asOf must be a valid Date");
  }
  return asOf;
}

/**
 * Structural check that an object satisfies the provider contract. Used by the
 * registry so a malformed provider fails at resolution rather than halfway
 * through a run.
 */
function isAiMappingProvider(candidate) {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.isEnabled === "boolean" &&
    typeof candidate.suggestMappings === "function"
  );
}

/**
 * The default provider. Always available, never configurable, never networked.
 */
function createDisabledAiMappingProvider() {
  return Object.freeze({
    name: DISABLED_PROVIDER_NAME,
    model: null,
    isEnabled: false,

    // eslint-disable-next-line no-unused-vars
    async suggestMappings({ snapshot, asOf, signal } = {}) {
      assertValidAsOf(asOf);
      // The snapshot is deliberately not read, not logged, not hashed here and
      // not retained. Nothing leaves this function.
      return Object.freeze({
        status: PROVIDER_RESULT_STATUSES.DISABLED,
        suggestions: Object.freeze([]),
        model: null,
      });
    },
  });
}

module.exports = {
  DISABLED_PROVIDER_NAME,
  assertValidAsOf,
  isAiMappingProvider,
  createDisabledAiMappingProvider,
};
