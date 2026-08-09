"use strict";

// Phase 8E — opt-in manual smoke test for the live Shodan provider.
//
// Reuses ShodanProvider (services/exposure/shodanProvider.js) exactly as the
// real enrichment path does — this script adds no new HTTP code, just a
// manual entry point. It performs exactly ONE lookup against 8.8.8.8
// (Google Public DNS — permanent public infrastructure, never a
// victim/customer asset), so it never consumes meaningful Shodan quota.
//
// Never run in CI: gated behind an explicit opt-in env var nothing in this
// repository's automated tests, evaluators, or CI workflow ever sets.
// SHODAN_API_KEY (if present) is read only to decide whether to pass it to
// the provider — its value is never printed, logged, or included in output.
// The request URL (which embeds the key as a query parameter, per Shodan's
// own auth scheme) is never printed either.

const { createShodanProvider } = require("../services/exposure/shodanProvider");

const OPT_IN_ENV = "LIVE_SHODAN_SMOKE";
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
      `Refusing to make a live Shodan request. Set ${OPT_IN_ENV}=${OPT_IN_VALUE} to run this manually, e.g.:\n` +
        `  ${OPT_IN_ENV}=${OPT_IN_VALUE} npm run smoke:shodan`
    );
  }
}

async function runShodanLiveSmoke({ env = process.env, fetchImpl } = {}) {
  assertOptedIn(env);

  const provider = createShodanProvider({
    apiKey: env.SHODAN_API_KEY || null,
    fetchImpl,
  });
  const result = await provider.lookup({ indicator: SMOKE_INDICATOR, asOf: new Date() });

  // Safe, normalized output only — never the raw Shodan response body, never
  // the request URL (which carries the API key), never any header, never
  // whether credentials were present beyond this boolean.
  return {
    indicator: result.indicator,
    status: result.status,
    credentialsUsed: provider.describe().enabled,
    serviceCount: result.data ? result.data.services.length : null,
    organization: result.data ? result.data.organization : null,
    vulnerabilityCount: result.data ? result.data.vulnerabilities.length : null,
    queriedAt: result.queriedAt,
  };
}

module.exports = { SmokeConfigError, assertOptedIn, runShodanLiveSmoke, SMOKE_INDICATOR, OPT_IN_ENV };

if (require.main === module) {
  runShodanLiveSmoke()
    .then((summary) => {
      console.log("Shodan live smoke result (safe fields only):");
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(`Shodan live smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}
