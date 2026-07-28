import { describe, it, expect, vi } from "vitest";

// P2-T2c — the real AbuseIPDBProvider. Every test here is fully offline: a
// fake `fetchImpl` is injected into every provider under test, so nothing in
// this file (or any automated run of the suite) ever reaches the real
// AbuseIPDB API. See abuseIpdbProviderSecurity.test.js for the dedicated
// secret-non-leakage suite.

const { createAbuseIpdbProvider, PROVIDER_NAME } = require("../../src/services/enrichment/abuseIpdbProvider");
const { AbuseIpdbConfigError } = require("../../src/services/enrichment/abuseIpdbConfig");
const {
  ENRICHMENT_STATUS,
  PROVIDER_ERROR_CODES,
} = require("../../src/services/enrichment/iocEnrichmentTypes");
const {
  resolveIocEnrichmentProvider,
  UnknownIocEnrichmentProviderError,
} = require("../../src/services/enrichment/providerRegistry");

const ASOF = new Date("2026-06-01T00:00:00Z");
const IP = "203.0.113.10";
const FAKE_KEY = "test-only-abuseipdb-key-0123456789";

function makeJsonResponse(status, body, headers = {}) {
  return {
    status,
    json: async () => body,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, name.toLowerCase()) ? headers[name.toLowerCase()] : null) },
  };
}

function makeMalformedJsonResponse(status) {
  return {
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token in JSON");
    },
    headers: { get: () => null },
  };
}

function makeAbortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function makeHangingFetch() {
  return (url, options) =>
    new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(makeAbortError());
        return;
      }
      signal.addEventListener("abort", () => reject(makeAbortError()), { once: true });
    });
}

const SUCCESS_BODY = {
  data: {
    ipAddress: IP,
    isPublic: true,
    ipVersion: 4,
    isWhitelisted: false,
    abuseConfidenceScore: 42,
    countryCode: "US",
    usageType: "Data Center/Web Hosting/Transit",
    isp: "Example ISP",
    domain: "example.com",
    hostnames: ["host.example.com"],
    countryName: "United States",
    totalReports: 7,
    numDistinctUsers: 3,
    lastReportedAt: "2026-05-30T12:00:00+00:00",
  },
};

describe("Configuration", () => {
  it("can be constructed without an API key", () => {
    expect(() => createAbuseIpdbProvider()).not.toThrow();
    expect(() => createAbuseIpdbProvider({})).not.toThrow();
  });

  it("has the exact lowercase provider name", () => {
    const provider = createAbuseIpdbProvider();
    expect(provider.name).toBe("abuseipdb");
    expect(PROVIDER_NAME).toBe("abuseipdb");
  });

  it("missing key returns SKIPPED_DISABLED and makes zero requests", async () => {
    const fetchImpl = vi.fn();
    const provider = createAbuseIpdbProvider({ fetchImpl });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });

    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an explicitly disabled provider returns SKIPPED_DISABLED even with a key present", async () => {
    const fetchImpl = vi.fn();
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, enabled: false, fetchImpl });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });

    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an out-of-bounds timeoutMs", () => {
    expect(() => createAbuseIpdbProvider({ timeoutMs: 500 })).toThrow(AbuseIpdbConfigError);
    expect(() => createAbuseIpdbProvider({ timeoutMs: 999999 })).toThrow(AbuseIpdbConfigError);
  });

  it("rejects an out-of-bounds maxAgeInDays", () => {
    expect(() => createAbuseIpdbProvider({ maxAgeInDays: 0 })).toThrow(AbuseIpdbConfigError);
    expect(() => createAbuseIpdbProvider({ maxAgeInDays: 366 })).toThrow(AbuseIpdbConfigError);
  });

  it("rejects a non-HTTPS, non-local baseUrl", () => {
    expect(() => createAbuseIpdbProvider({ baseUrl: "http://api.abuseipdb.com/api/v2" })).toThrow(
      AbuseIpdbConfigError
    );
  });

  it("accepts an explicit local test baseUrl", () => {
    expect(() => createAbuseIpdbProvider({ baseUrl: "http://localhost:4010/api/v2" })).not.toThrow();
  });

  it("registry resolves 'abuseipdb' only with exact case", () => {
    expect(() => resolveIocEnrichmentProvider("abuseipdb")).not.toThrow();
    expect(resolveIocEnrichmentProvider("abuseipdb").name).toBe("abuseipdb");
    expect(() => resolveIocEnrichmentProvider("AbuseIPDB")).toThrow(UnknownIocEnrichmentProviderError);
    expect(() => resolveIocEnrichmentProvider("ABUSEIPDB")).toThrow(UnknownIocEnrichmentProviderError);
  });

  it("resolving the registry never requires a real key and makes no request", () => {
    const provider = resolveIocEnrichmentProvider("abuseipdb");
    expect(provider.name).toBe("abuseipdb");
  });
});

describe("Request behavior", () => {
  it("requests the /check endpoint with canonical IPv4, only ipAddress and maxAgeInDays, Key header, and Accept header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse(200, SUCCESS_BODY));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl, maxAgeInDays: 45 });

    await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = fetchImpl.mock.calls[0];
    const url = new URL(calledUrl);
    expect(url.pathname.endsWith("/check")).toBe(true);
    expect(url.searchParams.get("ipAddress")).toBe(IP);
    expect(url.searchParams.get("maxAgeInDays")).toBe("45");
    expect(Array.from(url.searchParams.keys()).sort()).toEqual(["ipAddress", "maxAgeInDays"]);
    expect(options.method).toBe("GET");
    expect(options.headers.Key).toBe(FAKE_KEY);
    expect(options.headers.Accept).toBe("application/json");
  });

  it("uses the caller-supplied maxAgeInDays over the configured default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse(200, SUCCESS_BODY));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl, maxAgeInDays: 90 });

    await provider.lookup({
      indicatorType: "IPV4",
      indicator: IP,
      asOf: ASOF,
      queryParams: { maxAgeInDays: 14 },
    });

    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.get("maxAgeInDays")).toBe("14");
  });

  it("uses the explicit asOf as queriedAt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse(200, SUCCESS_BODY));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });

    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expect(result.queriedAt.getTime()).toBe(ASOF.getTime());
  });

  it("does not mutate caller-supplied queryParams", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse(200, SUCCESS_BODY));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });
    const queryParams = Object.freeze({ maxAgeInDays: 30 });

    await expect(
      provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF, queryParams })
    ).resolves.toBeTruthy();
  });

  it("makes zero requests for an unsupported indicator", async () => {
    const fetchImpl = vi.fn();
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: "not-an-ip", asOf: ASOF });

    expect(result.status).toBe(ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws (and makes zero requests) for an invalid queryParams.maxAgeInDays", async () => {
    const fetchImpl = vi.fn();
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });

    await expect(
      provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF, queryParams: { maxAgeInDays: 0 } })
    ).rejects.toThrow(TypeError);
    await expect(
      provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF, queryParams: { maxAgeInDays: 400 } })
    ).rejects.toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws TypeError for contract violations (missing asOf) — a programmer error, not an expected outcome", async () => {
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl: vi.fn() });
    await expect(provider.lookup({ indicatorType: "IPV4", indicator: IP })).rejects.toThrow(TypeError);
  });
});

describe("Successful normalization", () => {
  async function lookupWithBody(body, overrides = {}) {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse(200, body));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl, ...overrides });
    return provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
  }

  it("normalizes a full valid payload into exactly the allow-listed fields", async () => {
    const result = await lookupWithBody(SUCCESS_BODY);
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data).toEqual({
      abuseConfidenceScore: 42,
      totalReports: 7,
      countryCode: "US",
      isp: "Example ISP",
      domain: "example.com",
      usageType: "Data Center/Web Hosting/Transit",
      isWhitelisted: false,
      lastReportedAt: new Date("2026-05-30T12:00:00+00:00"),
    });
  });

  it("treats abuseConfidenceScore 0 as a valid SUCCESS", async () => {
    const result = await lookupWithBody({ data: { ...SUCCESS_BODY.data, abuseConfidenceScore: 0 } });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.abuseConfidenceScore).toBe(0);
  });

  it("treats totalReports 0 as valid", async () => {
    const result = await lookupWithBody({ data: { ...SUCCESS_BODY.data, totalReports: 0 } });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.totalReports).toBe(0);
  });

  it("leaves nullable optional fields null when absent", async () => {
    const result = await lookupWithBody({
      data: { abuseConfidenceScore: 5, totalReports: 1 },
    });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.countryCode).toBeNull();
    expect(result.data.isp).toBeNull();
    expect(result.data.domain).toBeNull();
    expect(result.data.usageType).toBeNull();
    expect(result.data.isWhitelisted).toBeNull();
    expect(result.data.lastReportedAt).toBeNull();
  });

  it("ignores unknown response properties", async () => {
    const result = await lookupWithBody({
      data: { ...SUCCESS_BODY.data, hostnames: ["a.example.com"], numDistinctUsers: 9, extra: "x" },
    });
    expect(Object.prototype.hasOwnProperty.call(result.data, "hostnames")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.data, "numDistinctUsers")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.data, "extra")).toBe(false);
  });

  it("bounds an oversized text field", async () => {
    const longIsp = "x".repeat(500);
    const result = await lookupWithBody({ data: { ...SUCCESS_BODY.data, isp: longIsp } });
    expect(result.data.isp.length).toBe(256);
  });

  it("parses a valid lastReportedAt", async () => {
    const result = await lookupWithBody(SUCCESS_BODY);
    expect(result.data.lastReportedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(result.data.lastReportedAt.getTime())).toBe(false);
  });

  it("maps a malformed abuseConfidenceScore safely to PROVIDER_MALFORMED_RESPONSE, never throwing", async () => {
    const result = await lookupWithBody({ data: { ...SUCCESS_BODY.data, abuseConfidenceScore: "high" } });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("maps an out-of-range abuseConfidenceScore safely", async () => {
    const result = await lookupWithBody({ data: { ...SUCCESS_BODY.data, abuseConfidenceScore: 150 } });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("maps a negative totalReports safely", async () => {
    const result = await lookupWithBody({ data: { ...SUCCESS_BODY.data, totalReports: -1 } });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("maps an invalid countryCode and lastReportedAt to null rather than throwing", async () => {
    const result = await lookupWithBody({
      data: { ...SUCCESS_BODY.data, countryCode: "usa", lastReportedAt: "not-a-date" },
    });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.countryCode).toBeNull();
    expect(result.data.lastReportedAt).toBeNull();
  });
});

describe("HTTP outcome mapping", () => {
  async function lookupWithResponse(response) {
    const fetchImpl = vi.fn().mockResolvedValue(response);
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    return { result, fetchImpl };
  }

  it("400 -> FAILED / PROVIDER_REJECTED", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(400, { errors: [] }));
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_REJECTED);
    expect(result.httpStatus).toBe(400);
  });

  it("401 -> INVALID_KEY / PROVIDER_INVALID_KEY", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(401, {}));
    expect(result.status).toBe(ENRICHMENT_STATUS.INVALID_KEY);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY);
  });

  it("403 -> INVALID_KEY / PROVIDER_INVALID_KEY", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(403, {}));
    expect(result.status).toBe(ENRICHMENT_STATUS.INVALID_KEY);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY);
  });

  it("404 -> NOT_FOUND, no errorInfo", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(404, {}));
    expect(result.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
    expect(result.errorInfo).toBeNull();
  });

  it("429 with a valid Retry-After -> RATE_LIMITED with parsed retryAfterSeconds", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(429, {}, { "retry-after": "120" }));
    expect(result.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(result.retryAfterSeconds).toBe(120);
  });

  it("429 with a malformed Retry-After -> retryAfterSeconds is null, not an exception", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(429, {}, { "retry-after": "soon" }));
    expect(result.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(result.retryAfterSeconds).toBeNull();
  });

  it("429 with no Retry-After -> retryAfterSeconds is null", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(429, {}));
    expect(result.retryAfterSeconds).toBeNull();
  });

  it("500 -> FAILED / PROVIDER_UNAVAILABLE", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(500, {}));
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("503 -> FAILED / PROVIDER_UNAVAILABLE", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(503, {}));
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("malformed JSON body -> FAILED / PROVIDER_MALFORMED_RESPONSE", async () => {
    const { result } = await lookupWithResponse(makeMalformedJsonResponse(200));
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("valid JSON with a malformed shape (no data object) -> FAILED / PROVIDER_MALFORMED_RESPONSE", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(200, { data: "not-an-object" }));
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_MALFORMED_RESPONSE);
  });

  it("2xx with data: null -> NOT_FOUND, not malformed", async () => {
    const { result } = await lookupWithResponse(makeJsonResponse(200, { data: null }));
    expect(result.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
  });

  it("every mapped status makes exactly one request", async () => {
    const { fetchImpl } = await lookupWithResponse(makeJsonResponse(500, {}));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Network behavior", () => {
  it("an internal timeout maps to TIMEOUT / PROVIDER_TIMEOUT", async () => {
    const provider = createAbuseIpdbProvider({
      apiKey: FAKE_KEY,
      fetchImpl: makeHangingFetch(),
      timeoutMs: 1000,
    });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.TIMEOUT);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT);
  }, 10000);

  it("caller cancellation propagates AbortError and is never misclassified as TIMEOUT", async () => {
    const provider = createAbuseIpdbProvider({
      apiKey: FAKE_KEY,
      fetchImpl: makeHangingFetch(),
      timeoutMs: 5000,
    });
    const controller = new AbortController();
    const promise = provider.lookup({
      indicatorType: "IPV4",
      indicator: IP,
      asOf: ASOF,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a DNS/connect/socket-style fetch failure maps to FAILED / PROVIDER_UNREACHABLE", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });
    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE);
  });

  it("cleans up the internal timeout handle after a successful response", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse(200, SUCCESS_BODY));
      const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 5000 });
      await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up the internal timeout handle after a network failure", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 5000 });
      await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries — exactly one fetch call for a failing lookup", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });
    await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
