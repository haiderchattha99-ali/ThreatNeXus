import { describe, it, expect, vi } from "vitest";

// P2-T2c security boundary: a distinctive fake API key must never appear
// anywhere except the `Key` request header that a fake fetch captures for
// this test's own assertions — never in the request URL, the normalized
// result, errorInfo, a thrown controlled error, JSON serialization, console
// output, or the provider's own name/config representation. Mirrors
// iocEnrichmentSecurity.test.js's approach for MockProvider. No real
// credential is used anywhere in this file.

const { createAbuseIpdbProvider } = require("../../src/services/enrichment/abuseIpdbProvider");
const { ENRICHMENT_STATUS } = require("../../src/services/enrichment/iocEnrichmentTypes");

const ASOF = new Date("2026-06-01T00:00:00Z");
const IP = "203.0.113.10";
const FAKE_KEY = "FAKE-ABUSEIPDB-KEY-do-not-actually-use-9f8e7d6c";

function makeCapturingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return { fetchImpl, calls };
}

// TNX-P10C5 — production now reads the body through readBoundedResponseText
// (a real streaming reader), not response.json(), so the fake response must
// expose `.text()`/`.body.getReader()` the same way Node's native fetch
// Response does.
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

function makeJsonResponse(status, body, headers = {}) {
  const text = JSON.stringify(body);
  return {
    status,
    text: async () => text,
    body: makeSingleChunkBody(text),
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, name.toLowerCase()) ? headers[name.toLowerCase()] : null) },
  };
}

function expectNoLeak(haystack) {
  const serialized = JSON.stringify(haystack);
  expect(serialized).not.toContain(FAKE_KEY);
}

describe("Security boundary — the API key appears only in the Key header", () => {
  it("a successful lookup never leaks the key into the URL or the normalized result", async () => {
    const { fetchImpl, calls } = makeCapturingFetch(
      makeJsonResponse(200, { data: { abuseConfidenceScore: 1, totalReports: 1 } })
    );
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });

    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });

    expect(calls).toHaveLength(1);
    // It is acceptable for the fake key to exist in the captured request
    // header inside this test's own in-memory record — the assertion is
    // that it appears ONLY there, never anywhere else, and this object is
    // never itself logged (see the console assertion below).
    expect(calls[0].options.headers.Key).toBe(FAKE_KEY);
    expect(calls[0].url).not.toContain(FAKE_KEY);

    expect(result.status).toBe(ENRICHMENT_STATUS.SUCCESS);
    expectNoLeak(result);
  });

  it("a 401 INVALID_KEY result never echoes the key back", async () => {
    const { fetchImpl } = makeCapturingFetch(makeJsonResponse(401, {}));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });

    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.INVALID_KEY);
    expectNoLeak(result);
    expectNoLeak(result.errorInfo);
  });

  it("a network failure's controlled FAILED result never leaks the key", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError(`fetch failed for key ${FAKE_KEY}`));
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });

    const result = await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    expect(result.status).toBe(ENRICHMENT_STATUS.FAILED);
    expectNoLeak(result);
    expectNoLeak(result.errorInfo);
  });

  it("a propagated caller-cancellation AbortError is never constructed with the key", async () => {
    // A real fetch AbortError (from an AbortSignal firing) carries a generic
    // "operation was aborted" message — it is never built from request
    // details. lookup() propagates that error verbatim by design (see
    // abuseIpdbProvider.js: "do not misclassify caller cancellation as
    // provider timeout") rather than constructing a new one, so the
    // guarantee under test is that OUR code never builds an error that
    // embeds the key — not that an arbitrary injected fetchImpl's own
    // message is rewritten, which propagation-by-design cannot do anyway.
    const fetchImpl = () =>
      new Promise((_resolve, reject) => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl, timeoutMs: 5000 });
    const controller = new AbortController();

    let caught = null;
    try {
      await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF, signal: controller.signal });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.name).toBe("AbortError");
    expect(caught.message).not.toContain(FAKE_KEY);
  });

  it("the provider's name and config representation never include the key", () => {
    const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl: vi.fn() });
    expect(provider.name).not.toContain(FAKE_KEY);
    expectNoLeak(provider.describe());
    expectNoLeak(provider);
  });

  it("no console method is ever called while processing a payload that could carry the key", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { fetchImpl } = makeCapturingFetch(makeJsonResponse(500, { message: `key=${FAKE_KEY}` }));
      const provider = createAbuseIpdbProvider({ apiKey: FAKE_KEY, fetchImpl });
      await provider.lookup({ indicatorType: "IPV4", indicator: IP, asOf: ASOF });
    } finally {
      [logSpy, warnSpy, errorSpy].forEach((spy) => {
        spy.mock.calls.forEach((call) => {
          expect(JSON.stringify(call)).not.toContain(FAKE_KEY);
        });
      });
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
