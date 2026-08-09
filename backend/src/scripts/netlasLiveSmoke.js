"use strict";

// Phase 8F — opt-in manual smoke test for the live Netlas provider.
//
// Reuses NetlasProvider (services/exposure/netlasProvider.js) exactly as the
// real enrichment path does — this script adds no new HTTP code, just a
// manual entry point. It performs exactly ONE lookup against 8.8.8.8
// (Google Public DNS — permanent public infrastructure, never a
// victim/customer asset), so it never consumes meaningful Netlas quota.
//
// Never run in CI: gated behind an explicit opt-in env var nothing in this
// repository's automated tests, evaluators, or CI workflow ever sets.
// NETLAS_API_KEY (if present) is read only to decide whether to pass it to
// the provider — its value is never printed, logged, or included in output.
// The Authorization header (which carries the key, per Netlas's own Bearer
// auth scheme) is never printed either.

const { createNetlasProvider } = require("../services/exposure/netlasProvider");

const OPT_IN_ENV = "LIVE_NETLAS_SMOKE";
const OPT_IN_VALUE = "1";
const SMOKE_INDICATOR = "8.8.8.8"; // Google Public DNS — permanent public infrastructure.

class SmokeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeConfigError";
  }
}

function assertOptedIn(env) {
  if (env[OPT_IN_ENV] !== OPT_IN_VALUE) {
    throw new SmokeConfigError(
      `Refusing to make a live Netlas request. Set ${OPT_IN_ENV}=${OPT_IN_VALUE} to run this manually, e.g.:\n` +
        `  ${OPT_IN_ENV}=${OPT_IN_VALUE} npm run smoke:netlas`
    );
  }
}

async function runNetlasLiveSmoke({ env = process.env, fetchImpl } = {}) {
  assertOptedIn(env);

  const provider = createNetlasProvider({
    apiKey: env.NETLAS_API_KEY || null,
    fetchImpl,
  });
  const result = await provider.lookup({ indicator: SMOKE_INDICATOR, asOf: new Date() });

  // Safe, normalized output only — never the raw Netlas response body,
  // never the Authorization header (which carries the API key), never any
  // other header, never whether credentials were present beyond this
  // boolean.
  return {
    indicator: result.indicator,
    status: result.status,
    credentialsUsed: provider.describe().enabled,
    serviceCount: result.data ? result.data.services.length : null,
    organization: result.data ? result.data.organization : null,
    certificateSubject: result.data ? result.data.certificateSubject : null,
    queriedAt: result.queriedAt,
  };
}

module.exports = { SmokeConfigError, assertOptedIn, runNetlasLiveSmoke, SMOKE_INDICATOR, OPT_IN_ENV };

if (require.main === module) {
  runNetlasLiveSmoke()
    .then((summary) => {
      console.log("Netlas live smoke result (safe fields only):");
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(`Netlas live smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}
