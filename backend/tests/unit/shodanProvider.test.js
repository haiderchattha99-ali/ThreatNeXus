import { describe, it, expect } from "vitest";

// Phase 8E — the real Shodan exposed-service/banner/port provider, against
// Shodan's REST API (`key` query-param auth, GET
// {baseUrl}/shodan/host/{ip}?key={apiKey}).
//
// EVERY test injects its own fetchImpl. Nothing here touches the network,
// and no test requires or consumes real credentials. A provider must be
// constructible and importable with no credentials at all.

const { createShodanProvider, PROVIDER_NAME } = require("../../src/services/exposure/shodanProvider");
const { ENRICHMENT_STATUS, PROVIDER_ERROR_CODES } = require("../../src/services/exposure/shodanTypes");

const ASOF = new Date("2026-08-07T00:00:00Z");
const IP = "203.0.113.40";
const SECRET_KEY = "SECRET-SHODAN-API-KEY-VALUE";

// TNX-P10C5 — production now reads the body through readBoundedResponseText
// (a real streaming reader), not response.json(), so the fake response must
// expose `.text()`/`.body.getReader()` the same way Node's native fetch
// Response does. `.body` yields the whole JSON-encoded text as one chunk,
// matching a normal small provider response.
function fakeFetch({ status = 200, body = {}, headers = {}, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      text: async () => text,
      body: makeSingleChunkBody(text),
    };
  };
}

function makeSingleChunkBody(text) {
  const bytes = new TextEncoder().encode(text);
  let done = false;
  return {
    getReader: () => ({
      async read() {
        if (done) return { done: true, value: undefined };
        done = true;
        return { done: false, value: bytes };
      },
      async cancel() {},
    }),
    cancel: async () => {},
  };
}

function throwingFetch(error) {
  return async () => {
    throw error;
  };
}

const HOST_SUCCESS_BODY = {
  ip_str: IP,
  hostnames: ["example-host.test"],
  org: "Example Org",
  isp: "Example ISP",
  country_name: "United States",
  country_code: "US",
  city: "Ashburn",
  ports: [22, 443],
  data: [
    { port: 22, transport: "tcp", product: "OpenSSH", version: "8.9" },
    { port: 443, transport: "tcp", product: "nginx", version: "1.24.0" },
  ],
  vulns: ["CVE-2023-12345"],
  last_update: "2026-08-06T10:00:00.000000",
};

const NO_SERVICE_BODY = {
  ip_str: "203.0.113.9",
  hostnames: [],
  data: [],
};

describe("ShodanProvider", () => {
  it("is constructible and importable with no credentials at all", () => {
    expect(() => createShodanProvider()).not.toThrow();
    const provider = createShodanProvider({});
    expect(provider.name).toBe(PROVIDER_NAME);
    expect(provider.describe().enabled).toBe(false);
  });

  it("returns SKIPPED_DISABLED without any fetch call when no key is configured", async () => {
    let called = false;
    const provider = createShodanProvider({ fetchImpl: async () => { called = true; } });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED);
    expect(called).toBe(false);
  });

  it("returns UNSUPPORTED_INDICATOR for a non-IPv4 indicator without any fetch call", async () => {
    let called = false;
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }; },
    });
    const result = await provider.lookup({ indicator: "not-an-ip", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR);
    expect(called).toBe(false);
  });

  it("sends key as a query parameter and normalizes a successful host response", async () => {
    const calls = [];
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: HOST_SUCCESS_BODY, calls }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });

    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.hostnames).toEqual(["example-host.test"]);
    expect(result.data.organization).toBe("Example Org");
    expect(result.data.isp).toBe("Example ISP");
    expect(result.data.country).toBe("United States");
    expect(result.data.countryCode).toBe("US");
    expect(result.data.city).toBe("Ashburn");
    expect(result.data.services).toHaveLength(2);
    expect(result.data.services[0]).toEqual({ port: 22, protocol: "TCP", product: "OpenSSH", version: "8.9" });
    expect(result.data.vulnerabilities).toEqual(["CVE-2023-12345"]);
    expect(result.data.lastUpdate).toBe("2026-08-06T10:00:00.000000");
    expect(result.data.link).toBe(`https://www.shodan.io/host/${IP}`);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`key=${SECRET_KEY}`);
    expect(calls[0].url).toContain(`/shodan/host/${IP}`);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].init.headers.key).toBeUndefined();
  });

  it("normalizes a host with no observed services WITHOUT fabricating data", async () => {
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: NO_SERVICE_BODY }),
    });
    const result = await provider.lookup({ indicator: "203.0.113.9", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.services).toEqual([]);
    expect(result.data.hostnames).toEqual([]);
    expect(result.data.organization).toBeNull();
    expect(result.data.vulnerabilities).toEqual([]);
  });

  it("drops a malformed CVE identifier rather than passing it through", async () => {
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: { ...HOST_SUCCESS_BODY, vulns: ["CVE-2023-12345", "not-a-cve", "definitely-evil"] } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.vulnerabilities).toEqual(["CVE-2023-12345"]);
  });

  it("maps 401 and 403 to INVALID_KEY", async () => {
    for (const status of [401, 403]) {
      // eslint-disable-next-line no-await-in-loop
      const provider = createShodanProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status }) });
      // eslint-disable-next-line no-await-in-loop
      const result = await provider.lookup({ indicator: IP, asOf: ASOF });
      expect(result.status).toBe(ENRICHMENT_STATUS.INVALID_KEY);
      expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY);
    }
  });

  it("maps 404 to NOT_FOUND", async () => {
    const provider = createShodanProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 404 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
  });

  it("maps 429 to RATE_LIMITED and reads retry-after", async () => {
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ status: 429, headers: { "retry-after": "45" } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(result.retryAfterSeconds).toBe(45);
  });

  it("maps a 5xx to FAILED/PROVIDER_UNAVAILABLE", async () => {
    const provider = createShodanProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 503 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("maps a malformed (non-JSON) 200 body to FAILED/PROVIDER_MALFORMED_RESPONSE", async () => {
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => "not valid json {",
      }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("maps an oversized 200 body to FAILED/PROVIDER_RESPONSE_TOO_LARGE without parsing it", async () => {
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (name) => (name === "content-length" ? "99999999" : null) },
        body: { cancel: async () => {} },
        text: async () => {
          throw new Error("text() should not be reached — Content-Length already refused the body");
        },
      }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_RESPONSE_TOO_LARGE);
  });

  it("maps a network-level throw to FAILED/PROVIDER_UNREACHABLE", async () => {
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: throwingFetch(new TypeError("fetch failed")),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE);
  });

  it("maps an aborted (timed-out) request to TIMEOUT", async () => {
    const provider = createShodanProvider({
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
    const provider = createShodanProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: HOST_SUCCESS_BODY }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    const serialized = JSON.stringify({ result, describe: provider.describe() });
    expect(serialized).not.toContain(SECRET_KEY);
  });

  it("describe() reports enabled/config shape but never the key", () => {
    const provider = createShodanProvider({ apiKey: SECRET_KEY });
    const described = provider.describe();
    expect(described.enabled).toBe(true);
    expect(described.provider).toBe("shodan");
    expect(JSON.stringify(described)).not.toContain(SECRET_KEY);
  });
});
