import { describe, it, expect } from "vitest";

// Phase 8D — the real GreyNoise internet-noise/reputation provider, against
// GreyNoise's Community API (`key` header auth, GET {baseUrl}/{ip}).
//
// EVERY test injects its own fetchImpl. Nothing here touches the network,
// and no test requires or consumes real credentials. A provider must be
// constructible and importable with no credentials at all.

const { createGreyNoiseProvider, PROVIDER_NAME } = require("../../src/services/reputation/greyNoiseProvider");
const { ENRICHMENT_STATUS, PROVIDER_ERROR_CODES } = require("../../src/services/reputation/greyNoiseTypes");

const ASOF = new Date("2026-08-07T00:00:00Z");
const IP = "1.1.1.1";
const SECRET_KEY = "SECRET-GREYNOISE-API-KEY-VALUE";

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

const NOISE_SUCCESS_BODY = {
  ip: IP,
  noise: true,
  riot: false,
  classification: "malicious",
  name: "Mirai",
  link: "https://viz.greynoise.io/ip/1.1.1.1",
  last_seen: "2026-08-06",
  message: "Success",
};

const RIOT_SUCCESS_BODY = {
  ip: "8.8.8.8",
  noise: false,
  riot: true,
  classification: "benign",
  name: "Google Public DNS",
  link: "https://viz.greynoise.io/riot/8.8.8.8",
  last_seen: "2026-08-06",
  message: "Success",
};

const NOT_OBSERVED_BODY = {
  ip: "203.0.113.9",
  noise: false,
  riot: false,
  message: "IP not observed scanning the internet or contained in RIOT dataset.",
};

describe("GreyNoiseProvider", () => {
  it("is constructible and importable with no credentials at all", () => {
    expect(() => createGreyNoiseProvider()).not.toThrow();
    const provider = createGreyNoiseProvider({});
    expect(provider.name).toBe(PROVIDER_NAME);
    expect(provider.describe().enabled).toBe(false);
  });

  it("returns SKIPPED_DISABLED without any fetch call when no key is configured", async () => {
    let called = false;
    const provider = createGreyNoiseProvider({ fetchImpl: async () => { called = true; } });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SKIPPED_DISABLED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.ENRICHMENT_DISABLED);
    expect(called).toBe(false);
  });

  it("returns UNSUPPORTED_INDICATOR for a non-IPv4 indicator without any fetch call", async () => {
    let called = false;
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }; },
    });
    const result = await provider.lookup({ indicator: "not-an-ip", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR);
    expect(called).toBe(false);
  });

  it("sends key auth and normalizes a successful noisy/malicious response", async () => {
    const calls = [];
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: NOISE_SUCCESS_BODY, calls }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });

    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.noise).toBe(true);
    expect(result.data.riot).toBe(false);
    expect(result.data.classification).toBe("malicious");
    expect(result.data.actorName).toBe("Mirai");
    expect(result.data.link).toBe("https://viz.greynoise.io/ip/1.1.1.1");
    expect(result.data.lastSeen).toBe("2026-08-06");

    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers.key).toBe(SECRET_KEY);
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    expect(calls[0].url).toContain(`/${IP}`);
  });

  it("normalizes a RIOT/benign response, including a real GreyNoise name value", async () => {
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: RIOT_SUCCESS_BODY }),
    });
    const result = await provider.lookup({ indicator: "8.8.8.8", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.riot).toBe(true);
    expect(result.data.classification).toBe("benign");
    expect(result.data.actorName).toBe("Google Public DNS");
  });

  it("normalizes a not-observed response WITHOUT fabricating a classification", async () => {
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: NOT_OBSERVED_BODY }),
    });
    const result = await provider.lookup({ indicator: "203.0.113.9", asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    // GreyNoise sent no classification field at all here — must stay null,
    // never guessed at "unknown" or "benign".
    expect(result.data.classification).toBeNull();
    expect(result.data.noise).toBe(false);
    expect(result.data.riot).toBe(false);
    expect(result.data.message).toMatch(/not observed/i);
  });

  it("rejects a classification value outside GreyNoise's own closed set, never passing it through", async () => {
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: { ...NOISE_SUCCESS_BODY, classification: "definitely-evil" } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expect(result.data.classification).toBeNull();
  });

  it("maps 401 and 403 to INVALID_KEY", async () => {
    for (const status of [401, 403]) {
      // eslint-disable-next-line no-await-in-loop
      const provider = createGreyNoiseProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status }) });
      // eslint-disable-next-line no-await-in-loop
      const result = await provider.lookup({ indicator: IP, asOf: ASOF });
      expect(result.status).toBe(ENRICHMENT_STATUS.INVALID_KEY);
      expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_INVALID_KEY);
    }
  });

  it("maps 404 to NOT_FOUND", async () => {
    const provider = createGreyNoiseProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 404 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.NOT_FOUND);
  });

  it("maps 429 to RATE_LIMITED and reads retry-after", async () => {
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ status: 429, headers: { "retry-after": "30" } }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.RATE_LIMITED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED);
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("maps a 5xx to FAILED/PROVIDER_UNAVAILABLE", async () => {
    const provider = createGreyNoiseProvider({ apiKey: SECRET_KEY, fetchImpl: fakeFetch({ status: 503 }) });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE);
  });

  it("maps a malformed (non-JSON) 200 body to FAILED/PROVIDER_MALFORMED_RESPONSE", async () => {
    const provider = createGreyNoiseProvider({
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
    const provider = createGreyNoiseProvider({
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
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: throwingFetch(new TypeError("fetch failed")),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expect(result.errorInfo.code).toBe(PROVIDER_ERROR_CODES.PROVIDER_UNREACHABLE);
  });

  it("maps an aborted (timed-out) request to TIMEOUT", async () => {
    const provider = createGreyNoiseProvider({
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
    const provider = createGreyNoiseProvider({
      apiKey: SECRET_KEY,
      fetchImpl: fakeFetch({ body: NOISE_SUCCESS_BODY }),
    });
    const result = await provider.lookup({ indicator: IP, asOf: ASOF });
    const serialized = JSON.stringify({ result, describe: provider.describe() });
    expect(serialized).not.toContain(SECRET_KEY);
  });

  it("describe() reports enabled/config shape but never the key", () => {
    const provider = createGreyNoiseProvider({ apiKey: SECRET_KEY });
    const described = provider.describe();
    expect(described.enabled).toBe(true);
    expect(described.provider).toBe("greynoise");
    expect(JSON.stringify(described)).not.toContain(SECRET_KEY);
  });
});
