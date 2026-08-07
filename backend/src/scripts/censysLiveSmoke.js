"use strict";

// Phase 8B — opt-in manual smoke test for the live Censys provider.
//
// Reuses CensysProvider (services/exposure/censysProvider.js) exactly as the
// real enrichment path does — this script adds no new HTTP code, just a
// manual entry point. It performs exactly ONE lookup against 1.1.1.1
// (Cloudflare's public DNS resolver — permanent public infrastructure, never
// a victim/customer asset), so it never consumes meaningful Censys quota.
//
// Never run in CI: gated behind an explicit opt-in env var nothing in this
// repository's automated tests, evaluators, or CI workflow ever sets.
// CENSYS_PAT/CENSYS_ORG_ID (if present) are read only to decide whether to
// pass them to the provider — their values are never printed, logged, or
// included in output.

const { createCensysProvider } = require("../services/exposure/censysProvider");

const OPT_IN_ENV = "LIVE_CENSYS_SMOKE";
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
      `Refusing to make a live Censys request. Set ${OPT_IN_ENV}=${OPT_IN_VALUE} to run this manually, e.g.:\n` +
        `  ${OPT_IN_ENV}=${OPT_IN_VALUE} npm run smoke:censys`
    );
  }
}

async function runCensysLiveSmoke({ env = process.env, fetchImpl } = {}) {
  assertOptedIn(env);

  const provider = createCensysProvider({
    pat: env.CENSYS_PAT || null,
    orgId: env.CENSYS_ORG_ID || null,
    fetchImpl,
  });
  const result = await provider.lookup({ indicator: SMOKE_INDICATOR, asOf: new Date() });

  // Safe, normalized output only — never the raw Censys response body, never
  // any header, never whether credentials were present beyond this boolean.
  return {
    indicator: result.indicator,
    status: result.status,
    credentialsUsed: provider.describe().enabled,
    serviceCount: result.data ? result.data.services.length : null,
    autonomousSystemName: result.data ? result.data.autonomousSystemName : null,
    queriedAt: result.queriedAt,
  };
}

module.exports = { SmokeConfigError, assertOptedIn, runCensysLiveSmoke, SMOKE_INDICATOR, OPT_IN_ENV };

if (require.main === module) {
  runCensysLiveSmoke()
    .then((summary) => {
      console.log("Censys live smoke result (safe fields only):");
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(`Censys live smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}
