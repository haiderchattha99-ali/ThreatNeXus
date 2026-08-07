"use strict";

// Phase 8 — opt-in manual smoke test for the live NVD provider.
//
// Reuses NvdCveProvider (services/vulnerability/providers/nvdCveProvider.js)
// exactly as the real enrichment path does — this script adds no new HTTP
// code, just a manual entry point. It performs exactly ONE lookup against a
// well-known, published CVE, so it never consumes meaningful NVD quota.
//
// Never run in CI: gated behind an explicit opt-in env var nothing in this
// repository's automated tests, evaluators, or CI workflow ever sets.
// NVD_API_KEY (if present) is read only to decide whether to pass it to the
// provider — its value is never printed, logged, or included in output.

const { NvdCveProvider } = require("../services/vulnerability/providers/nvdCveProvider");

const OPT_IN_ENV = "LIVE_NVD_SMOKE";
const OPT_IN_VALUE = "1";
const SMOKE_CVE_ID = "CVE-2021-44228"; // Log4Shell — permanently published, stable metadata.

class SmokeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeConfigError";
  }
}

function assertOptedIn(env) {
  if (env[OPT_IN_ENV] !== OPT_IN_VALUE) {
    throw new SmokeConfigError(
      `Refusing to make a live NVD request. Set ${OPT_IN_ENV}=${OPT_IN_VALUE} to run this manually, e.g.:\n` +
        `  ${OPT_IN_ENV}=${OPT_IN_VALUE} npm run smoke:nvd`
    );
  }
}

async function runNvdLiveSmoke({ env = process.env, fetchImpl } = {}) {
  assertOptedIn(env);

  const provider = new NvdCveProvider({ apiKey: env.NVD_API_KEY || null, fetchImpl });
  const result = await provider.lookup({ cveId: SMOKE_CVE_ID, asOf: new Date() });

  // Safe, normalized output only — never the raw NVD response body, never any
  // header, never whether a key was present beyond this boolean.
  return {
    cveId: result.cveId,
    status: result.status,
    keyUsed: provider.hasApiKey,
    cvssSeverity: result.data ? result.data.cvssSeverity : null,
    cvssBaseScoreTenths: result.data ? result.data.cvssBaseScoreTenths : null,
    queriedAt: result.queriedAt,
  };
}

module.exports = { SmokeConfigError, assertOptedIn, runNvdLiveSmoke, SMOKE_CVE_ID, OPT_IN_ENV };

if (require.main === module) {
  runNvdLiveSmoke()
    .then((summary) => {
      console.log("NVD live smoke result (safe fields only):");
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(`NVD live smoke failed: ${error.message}`);
      process.exitCode = 1;
    });
}
