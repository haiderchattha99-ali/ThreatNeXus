"use strict";

// Production composition root for IOC enrichment (P2-T2e-1).
//
// Every module in this directory takes its dependencies as explicit
// parameters — a provider registry, a TTL policy, a retry policy, a Prisma
// client. That is deliberate and it is why they are testable, but it leaves
// one honest gap: SOMETHING has to read the validated environment once and
// assemble the real thing. This module is that something, and nothing else.
//
// What it is NOT:
//   - a dependency-injection framework. There is no container, no lifecycle,
//     no registration API. It is one function that returns a frozen object.
//   - a worker. Building a runtime starts nothing: no timer, no daemon, no
//     loop, no batch. Execution is enrichmentExecutionService.js's job, and
//     only when someone calls it.
//   - a network client. Importing this file makes no request. The AbuseIPDB
//     provider's factory does not contact anything at construction time; a
//     missing API key only affects lookup() (SKIPPED_DISABLED), never
//     construction or import.
//
// ---------------------------------------------------------------------------
// The mock-fallback rule
// ---------------------------------------------------------------------------
// `resolveIocEnrichmentProvider` is exact and case-sensitive, and this module
// does not soften that. A job whose stored provider name is not registered
// resolves to nothing and the runner reports UNKNOWN_PROVIDER — it is never
// quietly served by MockProvider, because a mock verdict indistinguishable
// from a real one is precisely how fabricated reputation evidence enters a
// system.
//
// MockProvider remains registered (tests and local development need it), but
// in production it can only be reached by a job that explicitly stored
// `provider: "mock"`. `allowMockProvider: false` removes even that.

const {
  resolveIocEnrichmentProvider,
  listRegisteredIocEnrichmentProviderNames,
} = require("./providerRegistry");
const { resolveEnrichmentTtl } = require("./enrichmentTtlPolicy");
const { resolveEnrichmentRetry } = require("./enrichmentRetryPolicy");
const {
  DEFAULT_MAX_ATTEMPTS,
  MAX_PENDING_BATCH_SIZE,
  DEFAULT_PENDING_BATCH_SIZE,
} = require("./iocEnrichmentCacheRules");

const ABUSEIPDB_PROVIDER_NAME = "abuseipdb";
const MOCK_PROVIDER_NAME = "mock";

// Default lease for one processing attempt. Long enough that a slow provider
// call plus its completion write finishes comfortably inside it, short enough
// that a crashed worker's job is recoverable within minutes.
const DEFAULT_LEASE_DURATION_SECONDS = 120;

class EnrichmentRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentRuntimeError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// The environment is read lazily, not at import time: requiring config/env.js
// validates DATABASE_URL/JWT_SECRET/CORS_ORIGIN and throws if they are
// missing. A unit test that only wants the retry policy binding should not
// have to satisfy the whole application's configuration to import this file.
function loadEnv() {
  // eslint-disable-next-line global-require
  return require("../../config/env");
}

/**
 * Builds the per-provider configuration passed to a provider factory.
 * `fetchImpl` is threaded through so tests can inject a fake transport
 * without this module ever knowing about test doubles.
 */
function buildProviderConfig(providerName, env, { fetchImpl } = {}) {
  if (providerName === ABUSEIPDB_PROVIDER_NAME) {
    return {
      apiKey: env.ABUSEIPDB_API_KEY,
      baseUrl: env.ABUSEIPDB_BASE_URL,
      timeoutMs: env.ABUSEIPDB_TIMEOUT_MS,
      maxAgeInDays: env.ABUSEIPDB_MAX_AGE_DAYS,
      ...(fetchImpl ? { fetchImpl } : {}),
    };
  }
  return fetchImpl ? { fetchImpl } : {};
}

/**
 * Builds the production enrichment runtime.
 *
 * @param {{env?: object, fetchImpl?: Function, allowMockProvider?: boolean,
 *   providerRegistry?: {resolve: Function}, ttlPolicy?: Function,
 *   retryPolicy?: Function, leaseDurationSeconds?: number,
 *   defaultBatchSize?: number, defaultMaxAttempts?: number}} [overrides]
 *   Every field is an explicit seam for tests; production passes none of
 *   them. `providerRegistry`/`ttlPolicy`/`retryPolicy` replace the real ones
 *   wholesale, which is how a test injects a deterministic fake without
 *   monkey-patching a module.
 * @returns {{providerRegistry: object, ttlPolicy: Function,
 *   retryPolicy: Function, leaseDurationSeconds: number,
 *   defaultBatchSize: number, defaultMaxAttempts: number,
 *   describe: Function}} frozen
 */
function buildEnrichmentRuntime(overrides = {}) {
  if (!isPlainObject(overrides)) {
    throw new EnrichmentRuntimeError("buildEnrichmentRuntime: overrides must be an object");
  }
  const {
    env = loadEnv(),
    fetchImpl = null,
    allowMockProvider = true,
    providerRegistry: providerRegistryOverride = null,
    ttlPolicy = resolveEnrichmentTtl,
    retryPolicy = resolveEnrichmentRetry,
    leaseDurationSeconds = DEFAULT_LEASE_DURATION_SECONDS,
    defaultBatchSize = DEFAULT_PENDING_BATCH_SIZE,
    defaultMaxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = overrides;

  if (typeof ttlPolicy !== "function") {
    throw new EnrichmentRuntimeError("buildEnrichmentRuntime: ttlPolicy must be a function");
  }
  if (typeof retryPolicy !== "function") {
    throw new EnrichmentRuntimeError("buildEnrichmentRuntime: retryPolicy must be a function");
  }
  if (!Number.isInteger(defaultBatchSize) || defaultBatchSize < 1 || defaultBatchSize > MAX_PENDING_BATCH_SIZE) {
    throw new EnrichmentRuntimeError(
      `buildEnrichmentRuntime: defaultBatchSize must be an integer between 1 and ${MAX_PENDING_BATCH_SIZE}`
    );
  }
  if (providerRegistryOverride !== null && typeof providerRegistryOverride.resolve !== "function") {
    throw new EnrichmentRuntimeError(
      "buildEnrichmentRuntime: providerRegistry override must expose resolve(name)"
    );
  }

  const providerRegistry =
    providerRegistryOverride ||
    Object.freeze({
      /**
       * Exact, case-sensitive resolution against the real registry, with the
       * job's stored name as the only input. Throws for an unknown name (and
       * for a disallowed mock) — the runner catches that and reports
       * UNKNOWN_PROVIDER rather than substituting any other provider.
       */
      resolve(name) {
        if (!allowMockProvider && name === MOCK_PROVIDER_NAME) {
          throw new EnrichmentRuntimeError(
            "enrichmentRuntime: MockProvider is disabled in this runtime"
          );
        }
        return resolveIocEnrichmentProvider(name, buildProviderConfig(name, env, { fetchImpl }));
      },
    });

  return Object.freeze({
    providerRegistry,
    ttlPolicy,
    retryPolicy,
    leaseDurationSeconds,
    defaultBatchSize,
    defaultMaxAttempts,

    /**
     * Non-sensitive runtime summary, safe to log or return in an operational
     * response. Deliberately reports only WHETHER a key is configured, never
     * the key, a prefix of it, or its length. There is no code path in this
     * module that copies ABUSEIPDB_API_KEY into a returned value.
     */
    describe() {
      return Object.freeze({
        registeredProviders: listRegisteredIocEnrichmentProviderNames(),
        mockProviderAllowed: allowMockProvider === true,
        abuseIpdbConfigured: typeof env.ABUSEIPDB_API_KEY === "string" && env.ABUSEIPDB_API_KEY.trim() !== "",
        abuseIpdbBaseUrl: env.ABUSEIPDB_BASE_URL,
        abuseIpdbTimeoutMs: env.ABUSEIPDB_TIMEOUT_MS,
        abuseIpdbMaxAgeDays: env.ABUSEIPDB_MAX_AGE_DAYS,
        leaseDurationSeconds,
        defaultBatchSize,
        defaultMaxAttempts,
      });
    },
  });
}

module.exports = {
  EnrichmentRuntimeError,
  ABUSEIPDB_PROVIDER_NAME,
  MOCK_PROVIDER_NAME,
  DEFAULT_LEASE_DURATION_SECONDS,
  buildEnrichmentRuntime,
};
