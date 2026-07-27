"use strict";

// Deterministic, offline IocEnrichmentProvider (P2-T2a). Every automated test
// in this repository runs against this provider — never AbuseIPDB, never
// live quota, no network access anywhere in this file. `asOf` (supplied by
// the caller on every lookup) is the only source of `queriedAt`; this module
// never reads the wall clock and never uses randomness, so the same input +
// fixture configuration always produces the same output.

const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
  createEnrichmentResult,
} = require("./iocEnrichmentTypes");
const { isSupportedIocIndicator, assertValidLookupRequest } = require("./iocEnrichmentProvider");

const PROVIDER_NAME = "mock";

// One fixture scenario per required MockProvider case from the P2-T2a spec.
// UNSUPPORTED_INDICATOR and SKIPPED_DISABLED are deliberately not fixture
// scenarios: they are structural behaviors of lookup() itself (see below),
// not something a single indicator's fixture opts into.
const MOCK_SCENARIOS = Object.freeze({
  SUCCESS_LOW_CONFIDENCE: "SUCCESS_LOW_CONFIDENCE",
  SUCCESS_MEDIUM_CONFIDENCE: "SUCCESS_MEDIUM_CONFIDENCE",
  SUCCESS_HIGH_CONFIDENCE: "SUCCESS_HIGH_CONFIDENCE",
  SUCCESS_ZERO_CONFIDENCE: "SUCCESS_ZERO_CONFIDENCE",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  INVALID_KEY: "INVALID_KEY",
  TIMEOUT: "TIMEOUT",
  FAILED_UNAVAILABLE: "FAILED_UNAVAILABLE",
  FAILED_UNREACHABLE: "FAILED_UNREACHABLE",
  FAILED_MALFORMED_RESPONSE: "FAILED_MALFORMED_RESPONSE",
});

// Deterministic default `data` per SUCCESS scenario — fixture.data may
// override individual fields, never the whole shape.
const DEFAULT_SUCCESS_DATA = Object.freeze({
  [MOCK_SCENARIOS.SUCCESS_LOW_CONFIDENCE]: Object.freeze({ abuseConfidenceScore: 10, totalReports: 2 }),
  [MOCK_SCENARIOS.SUCCESS_MEDIUM_CONFIDENCE]: Object.freeze({
    abuseConfidenceScore: 55,
    totalReports: 20,
  }),
  [MOCK_SCENARIOS.SUCCESS_HIGH_CONFIDENCE]: Object.freeze({
    abuseConfidenceScore: 95,
    totalReports: 150,
  }),
  [MOCK_SCENARIOS.SUCCESS_ZERO_CONFIDENCE]: Object.freeze({ abuseConfidenceScore: 0, totalReports: 0 }),
});

// Deterministic shape for every non-success/non-not-found scenario: which
// ENRICHMENT_STATUS it maps to, which closed provider error code, a default
// httpStatus, and a default retryAfterSeconds (fixture-overridable).
const FAILURE_SCENARIO_SHAPE = Object.freeze({
  [MOCK_SCENARIOS.RATE_LIMITED]: Object.freeze({
    status: ENRICHMENT_STATUS.RATE_LIMITED,
    code: PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED,
    httpStatus: 429,
    defaultRetryAfterSeconds: 3600,
  }),
  [MOCK_SCENARIOS.INVALID_KEY]: Object.freeze({
    status: ENRICHMENT_STATUS.INVALID_KEY,
    code: PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY,
    httpStatus: 401,
    defaultRetryAfterSeconds: null,
  }),
  [MOCK_SCENARIOS.TIMEOUT]: Object.freeze({
    status: ENRICHMENT_STATUS.TIMEOUT,
    code: PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT,
    httpStatus: null,
    defaultRetryAfterSeconds: null,
  }),
  [MOCK_SCENARIOS.FAILED_UNAVAILABLE]: Object.freeze({
    status: ENRICHMENT_STATUS.FAILED,
    code: PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
    httpStatus: 503,
    defaultRetryAfterSeconds: null,
  }),
  [MOCK_SCENARIOS.FAILED_UNREACHABLE]: Object.freeze({
    status: ENRICHMENT_STATUS.FAILED,
    code: PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE,
    httpStatus: null,
    defaultRetryAfterSeconds: null,
  }),
  [MOCK_SCENARIOS.FAILED_MALFORMED_RESPONSE]: Object.freeze({
    status: ENRICHMENT_STATUS.FAILED,
    code: PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE,
    httpStatus: 200,
    defaultRetryAfterSeconds: null,
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Deep-copies the caller's fixture config via structuredClone (breaking every
// reference back to the caller's own objects, including any Error instance a
// security test might stash under a fixture) and freezes the result, so
// mutating the original object after construction — or reaching into
// whatever this function returns — can never change what the provider
// returns on a later lookup().
function cloneFrozenFixtures(fixtures) {
  if (fixtures === undefined || fixtures === null) return Object.freeze({});
  if (!isPlainObject(fixtures)) {
    throw new TypeError(
      "createMockIocEnrichmentProvider: fixtures must be a plain object keyed by indicator"
    );
  }
  return Object.freeze(structuredClone(fixtures));
}

/**
 * Creates a deterministic, offline IocEnrichmentProvider.
 *
 * @param {{
 *   fixtures?: Object<string, {scenario: string, data?: object,
 *     retryAfterSeconds?: number, httpStatus?: number, expiresAt?: Date}>,
 *   enabled?: boolean,
 *   unknownIndicatorScenario?: string
 * }} [config]
 */
function createMockIocEnrichmentProvider(config = {}) {
  if (!isPlainObject(config)) {
    throw new TypeError("createMockIocEnrichmentProvider: config must be an object");
  }

  const fixtures = cloneFrozenFixtures(config.fixtures);
  const enabled = config.enabled === undefined ? true : Boolean(config.enabled);
  const unknownIndicatorScenario = config.unknownIndicatorScenario || MOCK_SCENARIOS.NOT_FOUND;

  let callCount = 0;

  function supports({ indicatorType, indicator } = {}) {
    return isSupportedIocIndicator({ indicatorType, indicator });
  }

  function buildResultForFixture(indicatorType, indicator, fixture, asOf, queryParams) {
    const scenario = fixture ? fixture.scenario : unknownIndicatorScenario;

    if (Object.prototype.hasOwnProperty.call(DEFAULT_SUCCESS_DATA, scenario)) {
      const defaults = DEFAULT_SUCCESS_DATA[scenario];
      const overrides = fixture && isPlainObject(fixture.data) ? fixture.data : {};
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: ENRICHMENT_STATUS.SUCCESS,
        queriedAt: asOf,
        expiresAt: fixture && fixture.expiresAt ? fixture.expiresAt : null,
        queryParams,
        httpStatus: fixture && fixture.httpStatus !== undefined ? fixture.httpStatus : 200,
        data: {
          countryCode: null,
          isp: null,
          domain: null,
          usageType: null,
          isWhitelisted: false,
          lastReportedAt: null,
          ...defaults,
          ...overrides,
        },
      });
    }

    if (scenario === MOCK_SCENARIOS.NOT_FOUND) {
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: ENRICHMENT_STATUS.NOT_FOUND,
        queriedAt: asOf,
        queryParams,
        httpStatus: fixture && fixture.httpStatus !== undefined ? fixture.httpStatus : 404,
      });
    }

    const failureShape = FAILURE_SCENARIO_SHAPE[scenario];
    if (failureShape) {
      const retryAfterSeconds =
        fixture && fixture.retryAfterSeconds !== undefined
          ? fixture.retryAfterSeconds
          : failureShape.defaultRetryAfterSeconds;
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: failureShape.status,
        queriedAt: asOf,
        queryParams,
        httpStatus: fixture && fixture.httpStatus !== undefined ? fixture.httpStatus : failureShape.httpStatus,
        errorInfo: { code: failureShape.code },
        retryAfterSeconds,
      });
    }

    throw new TypeError(`createMockIocEnrichmentProvider: unknown fixture scenario "${scenario}"`);
  }

  async function lookup({ indicatorType, indicator, asOf, queryParams = null } = {}) {
    assertValidLookupRequest({ indicatorType, indicator, asOf });
    callCount += 1;

    // A disabled provider short-circuits before any support/fixture check —
    // it does no work of any kind while disabled, mirroring how a real
    // provider would skip even validating the indicator locally.
    if (!enabled) {
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: ENRICHMENT_STATUS.SKIPPED_DISABLED,
        queriedAt: asOf,
        queryParams,
        errorInfo: { code: PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED },
      });
    }

    if (!supports({ indicatorType, indicator })) {
      return createEnrichmentResult({
        provider: PROVIDER_NAME,
        indicatorType,
        indicator,
        status: ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR,
        queriedAt: asOf,
        queryParams,
        errorInfo: { code: PROVIDER_ERROR_CODES.UNSUPPORTED_INDICATOR },
      });
    }

    const fixture = Object.prototype.hasOwnProperty.call(fixtures, indicator) ? fixtures[indicator] : null;
    return buildResultForFixture(indicatorType, indicator, fixture, asOf, queryParams);
  }

  function getCallCount() {
    return callCount;
  }

  return Object.freeze({
    name: PROVIDER_NAME,
    supports,
    lookup,
    getCallCount,
  });
}

module.exports = {
  MOCK_SCENARIOS,
  createMockIocEnrichmentProvider,
};
