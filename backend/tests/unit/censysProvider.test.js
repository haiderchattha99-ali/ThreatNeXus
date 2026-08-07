import { describe, it, expect } from "vitest";

// Phase 8B — the real Censys exposure/attack-surface provider.
//
// EVERY test injects its own fetchImpl. Nothing here touches the network,
// and no test requires or consumes real credentials. A provider must be
// constructible and importable with no credentials at all.

const { createCensysProvider, PROVIDER_NAME } = require("../../src/services/exposure/censysProvider");
const { ENRICHMENT_STATUS, PROVIDER_ERROR_CODES } = require("../../src/services/exposure/censysTypes");

const ASOF = new Date("2026-08-07T00:00:00Z");
const IP = "1.1.1.1";
const SECRET_ID = "SECRET-CENSYS-ID";
const SECRET_SECRET = "SECRET-CENSYS-SECRET-VALUE";

function fakeFetch({ status = 200, body = {}, headers = {}, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      json: async () => body,
    };
  };
}

function throwingFetch(error) {
  return async () => {
    throw error;
  };
}

const HOST_SUCCESS_BODY = {
  code: 200,
  status: "OK",
  result: {
    ip: IP,
    services: [
      { port: 443, transport_protocol: "TCP", service_name: "HTTP" },
      { port: 53, transport_protocol: "UDP", service_name: "DNS" },
    ],
    autonomous_system: { asn: 13335, name: "CLOUDFLARENET" },
    certificates: ["a", "b"],
  },
};

describe("CensysProvider", () => {
  it("is constructible and importable with no credentials at all", () => {
    expect(() => createCensysProvider()).not.toThrow();
    const provider = createCensysProvider({});
    expect(provider.name).toBe(PROVIDER_NAME);
    expect(provider.describe().enabled).toBe(false);
  });

  it("returns SKIPPED_DISABLED without any fetch call when no credentials are configured", async () => {
    let called = false;
    const provider = createCensysProvider({ fetchImpl: async () => { called = true; } });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED);
    expect(called).toBe(false);
  });

  it("treats only one of apiId/apiSecret present as still not configured", async () => {
    let called = false;
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      // apiSecret intentionally omitted
      fetchImpl: async () => { called = true; },
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(called).toBe(false);
  });

  it("returns UNSUPPORTED_INDICATOR for a non-IPv4 indicator without any fetch call", async () => {
    let called = false;
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; },
    });
    const result = await provider.lookup({ indicator: "not-an-ip", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR);
    expect(called).toBe(false);
  });

  it("sends Basic Auth built from apiId/apiSecret and normalizes a successful response", async () => {
    const calls = [];
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: fakeFetch({ body: HOST_SUCCESS_BODY, calls }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });

    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.services).toEqual([
      { port: 443, protocol: "TCP", serviceName: "HTTP" },
      { port: 53, protocol: "UDP", serviceName: "DNS" },
    ]);
    expect(result.data.autonomousSystemNumber).toBe(13335);
    expect(result.data.autonomousSystemName).toBe("CLOUDFLARENET");
    expect(result.data.certificateCount).toBe(2);

    expect(calls).toHaveLength(1);
    const expectedAuth = `Basic ${Buffer.from(`${SECRET_ID}:${SECRET_SECRET}`).toString("base64")}`;
    expect(calls[0].init.headers.Authorization).toBe(expectedAuth);
    expect(calls[0].url).toContain(`/hosts/${IP}`);
  });

  it("never leaks the credentials into a result, an error, or describe()", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: fakeFetch({ body: HOST_SUCCESS_BODY }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    const serialized = JSON.stringify({ result, describe: provider.describe() });
    expect(serialized).not.toContain(SECRET_ID);
    expect(serialized).not.toContain(SECRET_SECRET);
  });

  it("maps a 404 to NOT_FOUND", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: fakeFetch({ status: 404, body: {} }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
  });

  it("maps 401/403 to INVALID_KEY (auth failure) without an errorInfo message carrying upstream text", async () => {
    for (const status of [401, 403]) {
      // eslint-disable-next-line no-await-in-loop
      const provider = createCensysProvider({
        apiId: SECRET_ID,
        apiSecret: SECRET_SECRET,
        fetchImpl: fakeFetch({ status, body: { error: "some upstream text that must never surface" } }),
      });
      // eslint-disable-next-line no-await-in-loop
      const result = await provider.lookup({ indicator: IP, asOf: ASOF });
      expect(result.status).toBe(ENRICHMENT_STATUS.INVALID_KEY);
      expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY);
      expect(result.errorInfo.message).not.toMatch(/upstream text/);
    }
  });

  it("maps 429 to RATE_LIMITED and parses Retry-After", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: fakeFetch({ status: 429, headers: { "retry-after": "90" } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(result.retryAfterSeconds).toBe(90);
  });

  it("maps 5xx to FAILED / PROVIDER_UNAVAILABLE", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: fakeFetch({ status: 503 }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("maps a malformed JSON body to FAILED / PROVIDER_MALFORMED_RESPONSE", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => { throw new Error("bad json"); },
      }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("maps a response with no result object to FAILED / PROVIDER_MALFORMED_RESPONSE", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: fakeFetch({ body: { code: 200, status: "OK" } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("maps a genuine timeout to TIMEOUT, distinct from caller cancellation", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      timeoutMs: 1000,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.TIMEOUT);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT);
  });

  it("maps an unreachable transport failure to FAILED / PROVIDER_UNREACHABLE without leaking the raw error", async () => {
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: throwingFetch(new Error("ECONNREFUSED 10.0.0.1:443 SECRET-INTERNAL-DETAIL")),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE);
    expect(JSON.stringify(result)).not.toMatch(/SECRET-INTERNAL-DETAIL/);
  });

  it("caps normalized services at MAX_SERVICES rather than rejecting a large host", async () => {
    const manyServices = Array.from({ length: 80 }, (_, i) => ({
      port: 1000 + i,
      transport_protocol: "TCP",
      service_name: "X",
    }));
    const provider = createCensysProvider({
      apiId: SECRET_ID,
      apiSecret: SECRET_SECRET,
      fetchImpl: fakeFetch({ body: { code: 200, status: "OK", result: { services: manyServices } } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.services.length).toBe(50);
  });
});
