"use strict";

// Phase 8D — opt-in manual smoke test for the live GreyNoise provider.
//
// Reuses GreyNoiseProvider (services/reputation/greyNoiseProvider.js)
// exactly as the real enrichment path does — this script adds no new HTTP
// code, just a manual entry point. It performs exactly ONE lookup against
// 1.1.1.1 (Cloudflare's public DNS resolver — permanent public
// infrastructure, never a victim/customer asset), so it never consumes
// meaningful GreyNoise quota.
//
// Never run in CI: gated behind an explicit opt-in env var nothing in this
// repository's automated tests, evaluators, or CI workflow ever sets.
// GREYNOISE_API_KEY (if present) is read only to decide whether to pass it
// to the provider — its value is never printed, logged, or included in
// output.

const { createGreyNoiseProvider } = require("../services/reputation/greyNoiseProvider");

const OPT_IN_ENV = "LIVE_GREYNOISE_SMOKE";
const OPT_IN_VALUE = "1";
const SMOKE_INDICATOR = "1.1.1.1"; // Cloudflare public DNS — permanent public infrastructure.

class SmokeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeConfigError";
  }
}

function assertOptedIn(env) {
  if (env[OPT_IN_ENV] !== OPT_IN_VALUE) {
    throw new SmokeConfigError(
      `Refusing to make a live GreyNoise request. Set ${OPT_IN_ENV}=${OPT_IN_VALUE} to run this manually, e.g.:\n` +
        `  ${OPT_IN_ENV}=${OPT_IN_VALUE} npm run smoke:greynoise`
    );
  }
}

async function runGreyNoiseLiveSmoke({ env = process.env, fetchImpl } = {}) {
  assertOptedIn(env);

  const provider = createGreyNoiseProvider({
    apiKey: env.GREYNOISE_API_KEY || null,
    fetchImpl,
  });
  const result = await provider.lookup({ indicator: SMOKE_INDICATOR, asOf: new Date() });

  // Safe, normalized output only — never the raw GreyNoise response body,
  // never any header, never whether credentials were present beyond this
  // boolean.
  return {
    indicator: result.indicator,
    status: result.status,
    credentialsUsed: provider.describe().enabled,
    noise: result.data ? result.data.noise : null,
    riot: result.data ? result.data.riot : null,
    classification: result.data ? result.data.classification : null,
    queriedAt: result.queriedAt,
  };
}

module.exports = { SmokeConfigError, assertOptedIn, runGreyNoiseLiveSmoke, SMOKE_INDICATOR, OPT_IN_ENV };

if (require.main === module) {
  runGreyNoiseLiveSmoke()
    .then((summary) => {
      console.log("GreyNoise live smoke result (safe fields only):");
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(`GreyNoise live smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}
