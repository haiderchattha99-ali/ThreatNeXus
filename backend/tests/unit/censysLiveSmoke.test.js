import { describe, it, expect } from "vitest";

// Phase 8B — the manual Censys live-smoke script is opt-in only. This suite
// never sets LIVE_CENSYS_SMOKE=1 in a way that reaches the network: the one
// "opted in" case below injects its own fetchImpl, exactly like every other
// provider test in this repository, so no live Censys call is ever made in CI.

const {
  SmokeConfigError,
  assertOptedIn,
  runCensysLiveSmoke,
  SMOKE_INDICATOR,
  OPT_IN_ENV,
} = require("../../src/scripts/censysLiveSmoke");

describe("censysLiveSmoke", () => {
  it("refuses to run without the explicit opt-in env var", () => {
    expect(() => assertOptedIn({})).toThrow(SmokeConfigError);
    expect(() => assertOptedIn({ [OPT_IN_ENV]: "true" })).toThrow(SmokeConfigError);
  });

  it("rejects before constructing a provider or touching fetch when not opted in", async () => {
    let fetchCalled = false;
    await expect(
      runCensysLiveSmoke({
        env: {},
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error("must not be called");
        },
      })
    ).rejects.toThrow(SmokeConfigError);
    expect(fetchCalled).toBe(false);
  });

  it("returns only safe normalized fields, never the credentials or a raw payload", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        result: {
          resource: {
            ip: SMOKE_INDICATOR,
            services: [{ port: 53, protocol: "DNS", transport_protocol: "UDP" }],
            autonomous_system: { asn: 13335, description: "CLOUDFLARENET" },
          },
        },
      }),
    });

    const summary = await runCensysLiveSmoke({
      env: { [OPT_IN_ENV]: "1", CENSYS_PAT: "SECRET-PAT-MUST-NOT-APPEAR" },
      fetchImpl,
    });

    expect(summary).toEqual({
      indicator: SMOKE_INDICATOR,
      status: "SUCCESS",
      credentialsUsed: true,
      serviceCount: 1,
      autonomousSystemName: "CLOUDFLARENET",
      queriedAt: summary.queriedAt,
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET-PAT-MUST-NOT-APPEAR");
  });
});
