"use strict";

// Deterministic, offline mock AI mapping provider — FOR TESTS AND EVALUATION
// ONLY.
//
// Zero network access. No fetch, no socket, no timer, no environment read, no
// key. Its output is a pure function of the fixture it was constructed with, so
// the same fixture always produces the same suggestions and an evaluator can
// hand-author expectations against it.
//
// ===========================================================================
// This provider is NOT reachable from production
// ===========================================================================
// aiProviderRegistry only returns it when the caller passes an explicit
// `allowMockProvider: true`, and aiRuntime (the production composition root)
// never passes it. There is no configuration value, no environment variable and
// no fallback path that can select this provider in a running application —
// which is the whole point of "no silent fallback from production to mock".
//
// ===========================================================================
// It deliberately emits BAD output too
// ===========================================================================
// A mock that only ever returns clean, valid suggestions would prove nothing
// about the gates: every test would pass whether or not validation existed. So
// the fixtures below include an ATT&CK mapping justified purely by exposure, a
// mapping citing a Finding from a different case, an unknown-field candidate,
// and a malformed reference id. Those are the cases the validation layer is
// supposed to discard, and the suites assert that it does.

const { PROVIDER_RESULT_STATUSES } = require("./aiSuggestionRules");
const { assertValidAsOf } = require("./aiMappingProvider");

const MOCK_PROVIDER_NAME = "mock";
const MOCK_PROVIDER_MODEL = "mock-deterministic-v1";

// Named scenarios. `suggestions` are RAW candidate shapes — exactly what a real
// provider would hand back, before any validation.
const MOCK_SCENARIOS = Object.freeze({
  // Two clean, defensible candidates: one CSF control gap, one CIS remediation
  // alignment. Neither claims compliance and neither is an ATT&CK technique.
  VALID_CONTROL_MAPPINGS: "VALID_CONTROL_MAPPINGS",
  // A single clean ATT&CK candidate whose rationale describes observed
  // behaviour. Used to prove the gate accepts a legitimate technique mapping.
  VALID_ATTACK_MAPPING: "VALID_ATTACK_MAPPING",
  // One good candidate mixed with four bad ones. Used to prove the accepted /
  // rejected split is real.
  MIXED_VALID_AND_INVALID: "MIXED_VALID_AND_INVALID",
  // Every candidate fails validation.
  ALL_INVALID: "ALL_INVALID",
  // The provider ran and proposed nothing.
  EMPTY: "EMPTY",
  // The provider itself failed.
  FAILED: "FAILED",
  // Structurally unusable output (not an array).
  MALFORMED_RESULT: "MALFORMED_RESULT",
  // More candidates than MAX_SUGGESTIONS_PER_RUN.
  OVER_CAP: "OVER_CAP",
});

const CLEAN_CSF_CANDIDATE = Object.freeze({
  framework: "NIST_CSF",
  frameworkVersion: "2.0",
  referenceId: "PR.AA-05",
  referenceTitle: "Access permissions and authorizations are defined and managed",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale:
    "Administrative remote access to the affected asset is reachable without a network boundary " +
    "control, which suggests access permissions are not constrained to authorised networks.",
  confidence: 62,
});

const CLEAN_CIS_CANDIDATE = Object.freeze({
  framework: "CIS_CONTROLS",
  frameworkVersion: "v8",
  referenceId: "4.6",
  referenceTitle: "Securely Manage Enterprise Assets and Software",
  mappingScope: "CASE",
  evidenceBasis: "REMEDIATION_ALIGNMENT",
  rationale:
    "The recommended remediation is to place remote management behind a VPN or jump host, which " +
    "aligns with securely managing enterprise assets and software.",
  confidence: 55,
});

const CLEAN_ATTACK_CANDIDATE = Object.freeze({
  framework: "MITRE_ATTACK",
  frameworkVersion: "v17.1",
  referenceId: "T1110.001",
  referenceTitle: "Brute Force: Password Guessing",
  mappingScope: "CASE",
  evidenceBasis: "OBSERVED_BEHAVIOR",
  rationale:
    "The constituent supplied security event logs showing several thousand failed interactive " +
    "logon attempts against a single administrator account from one external source within an " +
    "hour, followed by an authentication success that the account owner did not perform.",
  confidence: 71,
});

// --- Deliberately invalid candidates ---------------------------------------

// The exact mistake the ATT&CK gate exists to stop: a technique asserted from
// exposure and enrichment signals alone.
const EXPOSURE_ONLY_ATTACK_CANDIDATE = Object.freeze({
  framework: "MITRE_ATTACK",
  frameworkVersion: "v17.1",
  referenceId: "T1021.001",
  referenceTitle: "Remote Services: Remote Desktop Protocol",
  mappingScope: "CASE",
  evidenceBasis: "OBSERVED_BEHAVIOR",
  rationale:
    "Port 3389 is exposed to the internet, CVE-2019-0708 applies, the KEV catalogue lists it, " +
    "the EPSS score is elevated and the AbuseIPDB reputation score is high for this sector.",
  confidence: 93,
});

// An ATT&CK mapping on a non-behavioural basis — refused structurally.
const WRONG_BASIS_ATTACK_CANDIDATE = Object.freeze({
  framework: "MITRE_ATTACK",
  frameworkVersion: "v17.1",
  referenceId: "T1133",
  referenceTitle: "External Remote Services",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale:
    "External remote services are reachable from the public internet without multifactor " +
    "authentication in front of them.",
  confidence: 80,
});

// A reference id that does not match its family's shape.
const MALFORMED_REFERENCE_CANDIDATE = Object.freeze({
  framework: "NIST_CSF",
  frameworkVersion: "2.0",
  referenceId: "TOTALLY-MADE-UP",
  referenceTitle: "Invented subcategory",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale: "This reference does not follow the CSF 2.0 subcategory identifier shape at all.",
  confidence: 99,
});

// Carries a field the contract does not define. Rejected, never dropped.
const UNKNOWN_FIELD_CANDIDATE = Object.freeze({
  framework: "CIS_CONTROLS",
  frameworkVersion: "v8",
  referenceId: "12.2",
  referenceTitle: "Establish and Maintain a Secure Network Architecture",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale: "Network architecture does not segment administrative access from general traffic.",
  confidence: 40,
  // Not in ALLOWED_CANDIDATE_KEYS.
  autoApprove: true,
});

// Cites a Finding id the case does not have linked. The single most dangerous
// malformed output a model can produce.
const FOREIGN_EVIDENCE_CANDIDATE = Object.freeze({
  framework: "CIS_CONTROLS",
  frameworkVersion: "v8",
  referenceId: "13.1",
  referenceTitle: "Centralize Security Event Alerting",
  mappingScope: "FINDING",
  evidenceBasis: "CONTROL_GAP",
  rationale: "Security event alerting is not centralised for the affected estate.",
  evidenceFindingId: 999999999,
  confidence: 30,
});

const SCENARIO_CANDIDATES = Object.freeze({
  VALID_CONTROL_MAPPINGS: [CLEAN_CSF_CANDIDATE, CLEAN_CIS_CANDIDATE],
  VALID_ATTACK_MAPPING: [CLEAN_ATTACK_CANDIDATE],
  MIXED_VALID_AND_INVALID: [
    CLEAN_CSF_CANDIDATE,
    EXPOSURE_ONLY_ATTACK_CANDIDATE,
    WRONG_BASIS_ATTACK_CANDIDATE,
    MALFORMED_REFERENCE_CANDIDATE,
    UNKNOWN_FIELD_CANDIDATE,
  ],
  ALL_INVALID: [
    EXPOSURE_ONLY_ATTACK_CANDIDATE,
    MALFORMED_REFERENCE_CANDIDATE,
    UNKNOWN_FIELD_CANDIDATE,
    FOREIGN_EVIDENCE_CANDIDATE,
  ],
  EMPTY: [],
  OVER_CAP: [
    CLEAN_CSF_CANDIDATE,
    CLEAN_CIS_CANDIDATE,
    { ...CLEAN_CIS_CANDIDATE, referenceId: "5.2", referenceTitle: "Use Unique Passwords" },
    { ...CLEAN_CIS_CANDIDATE, referenceId: "6.3", referenceTitle: "Require MFA for Externally-Exposed Applications" },
    { ...CLEAN_CIS_CANDIDATE, referenceId: "12.2", referenceTitle: "Secure Network Architecture" },
    { ...CLEAN_CIS_CANDIDATE, referenceId: "13.1", referenceTitle: "Centralize Security Event Alerting" },
    { ...CLEAN_CIS_CANDIDATE, referenceId: "8.2", referenceTitle: "Collect Audit Logs" },
  ],
});

/**
 * Builds the deterministic mock provider.
 *
 * @param {object} [config]
 * @param {string} [config.scenario]  a MOCK_SCENARIOS value (default
 *   VALID_CONTROL_MAPPINGS)
 * @param {Array}  [config.suggestions] explicit raw candidates, overriding the
 *   scenario entirely — for a test that needs one exact shape
 */
function createMockAiMappingProvider(config = {}) {
  // Deep-copied and frozen at construction so mutating the caller's original
  // object afterwards cannot change later results — the same guarantee the
  // Phase 2 MockProvider makes.
  const frozenConfig = Object.freeze(structuredClone(config || {}));
  const scenario = frozenConfig.scenario || MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS;

  let callCount = 0;

  return Object.freeze({
    name: MOCK_PROVIDER_NAME,
    model: MOCK_PROVIDER_MODEL,
    isEnabled: true,

    getCallCount() {
      return callCount;
    },

    // eslint-disable-next-line no-unused-vars
    async suggestMappings({ snapshot, asOf, signal } = {}) {
      assertValidAsOf(asOf);
      callCount += 1;

      if (scenario === MOCK_SCENARIOS.FAILED) {
        return Object.freeze({
          status: PROVIDER_RESULT_STATUSES.FAILED,
          suggestions: Object.freeze([]),
          model: MOCK_PROVIDER_MODEL,
        });
      }

      if (scenario === MOCK_SCENARIOS.MALFORMED_RESULT) {
        // Deliberately NOT an array — the caller must treat this as malformed
        // rather than iterating whatever it is.
        return { status: PROVIDER_RESULT_STATUSES.COMPLETED, suggestions: "not-an-array" };
      }

      const candidates = Array.isArray(frozenConfig.suggestions)
        ? frozenConfig.suggestions
        : SCENARIO_CANDIDATES[scenario] || [];

      return Object.freeze({
        status: PROVIDER_RESULT_STATUSES.COMPLETED,
        // Structurally cloned so a consumer mutating a returned candidate can
        // never alter what the next call produces.
        suggestions: structuredClone(candidates),
        model: MOCK_PROVIDER_MODEL,
      });
    },
  });
}

module.exports = {
  MOCK_PROVIDER_NAME,
  MOCK_PROVIDER_MODEL,
  MOCK_SCENARIOS,
  SCENARIO_CANDIDATES,
  CLEAN_CSF_CANDIDATE,
  CLEAN_CIS_CANDIDATE,
  CLEAN_ATTACK_CANDIDATE,
  EXPOSURE_ONLY_ATTACK_CANDIDATE,
  WRONG_BASIS_ATTACK_CANDIDATE,
  MALFORMED_REFERENCE_CANDIDATE,
  UNKNOWN_FIELD_CANDIDATE,
  FOREIGN_EVIDENCE_CANDIDATE,
  createMockAiMappingProvider,
};
