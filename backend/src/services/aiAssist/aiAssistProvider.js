"use strict";

// The Finding AI-assist provider contract, and the DEFAULT provider.
// Mirrors services/ai/aiMappingProvider.js exactly, for a different domain:
// a narrative draft (summary/explanation text) instead of a structured
// mapping candidate.
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
//     generateSuggestion({snapshot, suggestionType, asOf, signal})
//       -> Promise<ProviderResult>
//   }
//
//   ProviderResult = { status: "DISABLED"|"COMPLETED"|"FAILED",
//                      text?: string,
//                      evidenceReferences?: string[],
//                      model?: string|null }
//
// ONE method. It takes a bounded, already-minimized snapshot and it returns
// DATA. It receives no Prisma client, no transaction, no repository, no HTTP
// request or response, no user, no capability, no audit logger and no file
// handle. That omission IS the safety control — the same reasoning
// services/ai/aiMappingProvider.js documents for mapping suggestions, and
// tests/unit/aiAssistSafetyBoundaries.test.js proves it for this contract.
//
// `generateSuggestion` must NEVER throw for an expected outcome (disabled,
// unreachable, malformed upstream). It returns a FAILED result instead.

const { PROVIDER_RESULT_STATUSES } = require("./aiAssistRules");

const DISABLED_PROVIDER_NAME = "disabled";

function assertValidAsOf(asOf) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new TypeError("aiAssistProvider: asOf must be a valid Date");
  }
  return asOf;
}

/**
 * Structural check that an object satisfies the provider contract.
 */
function isAiAssistProvider(candidate) {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.isEnabled === "boolean" &&
    typeof candidate.generateSuggestion === "function"
  );
}

/**
 * The default provider. Always available, never configurable, never
 * networked. AI_ENABLED defaults to false and this provider makes no network
 * call of any kind — every workflow completes with it in place.
 */
function createDisabledAiAssistProvider() {
  return Object.freeze({
    name: DISABLED_PROVIDER_NAME,
    model: null,
    isEnabled: false,

    // eslint-disable-next-line no-unused-vars
    async generateSuggestion({ snapshot, suggestionType, asOf, signal } = {}) {
      assertValidAsOf(asOf);
      // The snapshot is deliberately not read, not logged, not hashed here and
      // not retained. Nothing leaves this function.
      return Object.freeze({ status: PROVIDER_RESULT_STATUSES.DISABLED, model: null });
    },
  });
}

module.exports = {
  DISABLED_PROVIDER_NAME,
  assertValidAsOf,
  isAiAssistProvider,
  createDisabledAiAssistProvider,
};
