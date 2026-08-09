import { describe, it, expect } from "vitest";

// Phase 8F — the real Netlas cross-source attack-surface/DNS/certificate
// provider, against Netlas's Host Info endpoint (Bearer auth, GET
// {baseUrl}/api/host/{ip}/).
//
// EVERY test injects its own fetchImpl. Nothing here touches the network,
// and no test requires or consumes real credentials. A provider must be
// constructible and importable with no credentials at all.

const { createNetlasProvider, PROVIDER_NAME } = require("../../src/services/exposure/netlasProvider");
const { ENRICHMENT_STATUS, PROVIDER_ERROR_CODES } = require("../../src/services/exposure/netlasTypes");

const ASOF = new Date("2026-08-09T00:00:00Z");
const IP = "203.0.113.50";
const SECRET_KEY = "SECRET-NETLAS-API-KEY-VALUE";

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
  ip: IP,
  ptr: ["example-host.test"],
  domains: ["example.com", "www.example.com"],
  organization: "Example Org",
  geo: { country: "United States" },
  ports: [
    { port: 22, prot4: "tcp", prot7: "ssh" },
    { port: 443, prot4: "tcp", prot7: "https" },
  ],
  software: [{ product: "OpenSSH", version: "8.9" }],
  certificate: {
    subject: { common_name: "example.com" },
    issuer_dn: "CN=R3,O=Let's Encrypt,C=US",
    names: ["example.com", "www.example.com"],
  },
  whois: { net: { organization: "Example Org" }, asn: { number: 64500, name: "EXAMPLE-ASN" } },
  lseen: "2026-08-08T10:00:00Z",
  fseen: "2025-01-01T00:00:00Z",
};

const NO_SERVICE_BODY = {
  ip: "203.0.113.9",
  ptr: [],
  ports: [],
};

describe("NetlasProvider", () => {
  it("is constructible and importable with no credentials at all", () => {
    expect(() => createNetlasProvider()).not.toThrow();
    const provider = createNetlasProvider({});
    expect(provider.name).toBe(PROVIDER_NAME);
    expect(provider.describe().enabled).toBe(false);
  });

  it("returns SKIPPED_DISABLED without any fetch call when no key is configured", async () => {
    let called = false;
    const provider = createNetlasProvider({ fetchImpl: async () => { called = true; } });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED);
    expect(called).toBe(false);
  });

  it("returns UNSUPPORTED_INDICATOR for a non-IPv4 indicator without any fetch call", async () => {
    let called = false;
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; },
    });
    const result = await provider.lookup({ indicator: "example.com", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR);
    expect(called).toBe(false);
  });

  it("sends the key as a Bearer Authorization header and normalizes a successful host response", async () => {
    const calls = [];
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: HOST_SUCCESS_BODY, calls }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });

    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.hostnames).toEqual(["example-host.test"]);
    expect(result.data.dnsNames).toEqual(["example.com", "www.example.com"]);
    expect(result.data.organization).toBe("Example Org");
    expect(result.data.asn).toBe(64500);
    expect(result.data.asnOrg).toBe("EXAMPLE-ASN");
    expect(result.data.country).toBe("United States");
    expect(result.data.services).toHaveLength(2);
    expect(result.data.services[0]).toEqual({ port: 22, protocol: "TCP", service: "ssh" });
    expect(result.data.products).toEqual([{ product: "OpenSSH", version: "8.9" }]);
    expect(result.data.certificateSubject).toBe("example.com");
    expect(result.data.certificateIssuer).toBe("CN=R3,O=Let's Encrypt,C=US");
    expect(result.data.certificateSan).toEqual(["example.com", "www.example.com"]);
    expect(result.data.lastSeen).toBe("2026-08-08T10:00:00Z");
    expect(result.data.firstSeen).toBe("2025-01-01T00:00:00Z");
    expect(result.data.link).toBe(`https://app.netlas.io/host/${IP}/`);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/api/host/${IP}/`);
    expect(calls[0].url).not.toContain(SECRET_KEY);
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it("normalizes a host with no observed services WITHOUT fabricating data", async () => {
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: NO_SERVICE_BODY }),
    });
    const result = await provider.lookup({ indicator: "203.0.113.9", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.services).toEqual([]);
    expect(result.data.products).toEqual([]);
    expect(result.data.hostnames).toEqual([]);
    expect(result.data.dnsNames).toEqual([]);
    expect(result.data.organization).toBeNull();
    expect(result.data.asn).toBeNull();
    expect(result.data.certificateSubject).toBeNull();
  });

  it("maps 401 and 403 to INVALID_KEY", async () => {
    for (const status of [401, 403]) {
      // eslint-disable-next-line no-await-in-loop
      const provider = createNetlasProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status }) });
      // eslint-disable-next-line no-await-in-loop
      const result = await provider.lookup({ indicator: IP, asOf: ASOF });
      expect(result.status).toBe(ENRICHMENT_STATUS.INVALID_KEY);
      expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY);
    }
  });

  it("maps 404 to NOT_FOUND", async () => {
    const provider = createNetlasProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 404 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
  });

  it("maps 429 to RATE_LIMITED and reads retry-after", async () => {
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ status: 429, headers: { "retry-after": "30" } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("maps 402 (Netlas's own quota-exhaustion response) to RATE_LIMITED", async () => {
    const provider = createNetlasProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 402 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
  });

  it("maps 400 to FAILED/PROVIDER_REJECTED", async () => {
    const provider = createNetlasProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 400 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_REJECTED);
  });

  it("maps a 5xx to FAILED/PROVIDER_UNAVAILABLE", async () => {
    const provider = createNetlasProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 503 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("maps a 504 timeout-shaped 5xx to FAILED/PROVIDER_UNAVAILABLE", async () => {
    const provider = createNetlasProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 504 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("maps a malformed (non-JSON) 200 body to FAILED/PROVIDER_MALFORMED_RESPONSE", async () => {
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => { throw new SyntaxError("Unexpected token"); },
      }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("maps a network-level throw to FAILED/PROVIDER_UNREACHABLE", async () => {
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      fetchImpl: throwingFetch(new TypeError("fetch failed")),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE);
  });

  it("maps an aborted (timed-out) request to TIMEOUT", async () => {
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      timeoutMs: 1000,
      fetchImpl: async (url, init) =>
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
  }, 3000);

  it("never leaks the API key into a result, an error, or describe()", async () => {
    const provider = createNetlasProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: HOST_SUCCESS_BODY }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    const serialized = JSON.stringify({ result, describe: provider.describe() });
    expect(serialized).not.toContain(SECRET_KEY);
  });

  it("describe() reports enabled/config shape but never the key", () => {
    const provider = createNetlasProvider({ apiKey: SECRET_KEY });
    const described = provider.describe();
    expect(described.enabled).toBe(true);
    expect(described.provider).toBe("netlas");
    expect(JSON.stringify(described)).not.toContain(SECRET_KEY);
  });
});
