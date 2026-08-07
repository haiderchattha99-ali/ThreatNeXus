import { describe, it, expect } from "vitest";

// Phase 8 — the manual NVD live-smoke script is opt-in only. This suite never
// sets LIVE_NVD_SMOKE=1 in a way that reaches the network: the one "opted in"
// case below injects its own fetchImpl, exactly like every other provider
// test in this repository, so no live NVD call is ever made in CI.

const {
  SmokeConfigError,
  assertOptedIn,
  runNvdLiveSmoke,
  SMOKE_CVE_ID,
  OPT_IN_ENV,
} = require("../../src/scripts/nvdLiveSmoke");

describe("nvdLiveSmoke", () => {
  it("refuses to run without the explicit opt-in env var", () => {
    expect(() => assertOptedIn({})).toThrow(SmokeConfigError);
    expect(() => assertOptedIn({ [OPT_IN_ENV]: "true" })).toThrow(SmokeConfigError);
  });

  it("rejects before constructing a provider or touching fetch when not opted in", async () => {
    let fetchCalled = false;
    await expect(
      runNvdLiveSmoke({
        env: {},
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error("must not be called");
        },
      })
    ).rejects.toThrow(SmokeConfigError);
    expect(fetchCalled).toBe(false);
  });

  it("returns only safe normalized fields, never the key or a raw payload", async () => {
    const body = {
      totalResults: 1,
      vulnerabilities: [
        {
          cve: {
            id: SMOKE_CVE_ID,
            vulnStatus: "Analyzed",
            descriptions: [{ lang: "en", value: "Apache Log4j2 JNDI features..." }],
            metrics: {
              cvssMetricV31: [
                { type: "Primary", cvssData: { version: "3.1", baseScore: 10.0, baseSeverity: "CRITICAL" } },
              ],
            },
          },
        },
      ],
    };
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    });

    const summary = await runNvdLiveSmoke({
      env: { [OPT_IN_ENV]: "1", NVD_API_KEY: "SECRET-VALUE-MUST-NOT-APPEAR" },
      fetchImpl,
    });

    expect(summary).toEqual({
      cveId: SMOKE_CVE_ID,
      status: "SUCCESS",
      keyUsed: true,
      cvssSeverity: "CRITICAL",
      cvssBaseScoreTenths: 100,
      queriedAt: summary.queriedAt,
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET-VALUE-MUST-NOT-APPEAR");
  });
});
