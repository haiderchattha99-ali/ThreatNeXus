import { describe, it, expect } from "vitest";

const {
  DEFAULT_MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  readBoundedResponseText,
} = require("../../src/services/shared/boundedResponseBody");

// A minimal Fetch API Response stand-in whose `.body` is a real
// ReadableStream-shaped reader over caller-supplied Uint8Array chunks — the
// same shape Node's native fetch(Response) exposes. `headers` mirrors the
// real Headers.get(name) contract (case-insensitive lookup by exact key
// here since every caller passes lowercase names, matching production).
function makeStreamResponse({ chunks, headers = {}, cancelSpy = null } = {}) {
  let index = 0;
  let cancelled = false;
  const reader = {
    async read() {
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
    async cancel(reason) {
      cancelled = true;
      if (cancelSpy) cancelSpy(reason);
    },
  };
  return {
    headers: { get: (name) => headers[name] ?? null },
    body: {
      getReader: () => reader,
      cancel: async (reason) => {
        cancelled = true;
        if (cancelSpy) cancelSpy(reason);
      },
    },
    text: async () => {
      throw new Error("text() should not be called when a streaming body is present");
    },
    get wasCancelled() {
      return cancelled;
    },
  };
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

describe("readBoundedResponseText — small normal response", () => {
  it("returns the exact decoded text for a small single-chunk body", async () => {
    const text = JSON.stringify({ hello: "world" });
    const response = makeStreamResponse({ chunks: [utf8Bytes(text)] });
    await expect(readBoundedResponseText(response, { maxBytes: 1024 })).resolves.toBe(text);
  });

  it("assembles multiple small chunks into the exact original text", async () => {
    const text = "0123456789".repeat(5);
    const bytes = utf8Bytes(text);
    const chunks = [bytes.slice(0, 10), bytes.slice(10, 30), bytes.slice(30)];
    const response = makeStreamResponse({ chunks });
    await expect(readBoundedResponseText(response, { maxBytes: 1024 })).resolves.toBe(text);
  });
});

describe("readBoundedResponseText — at/over the limit", () => {
  it("succeeds when the body is exactly at the byte limit", async () => {
    const text = "a".repeat(100);
    const response = makeStreamResponse({ chunks: [utf8Bytes(text)] });
    await expect(readBoundedResponseText(response, { maxBytes: 100 })).resolves.toBe(text);
  });

  it("fails closed when the body is exactly one byte over the limit", async () => {
    const text = "a".repeat(101);
    const cancels = [];
    const response = makeStreamResponse({ chunks: [utf8Bytes(text)], cancelSpy: (r) => cancels.push(r) });
    await expect(readBoundedResponseText(response, { maxBytes: 100 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
    expect(cancels.length).toBe(1);
  });

  it("fails closed for a body split across many chunks that only exceeds the limit on a later chunk", async () => {
    const bytes = utf8Bytes("x".repeat(250));
    const chunks = [bytes.slice(0, 90), bytes.slice(90, 180), bytes.slice(180)];
    const response = makeStreamResponse({ chunks });
    await expect(readBoundedResponseText(response, { maxBytes: 150 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
  });

  it("cancels the reader — the underlying connection — on overflow", async () => {
    const cancels = [];
    const response = makeStreamResponse({
      chunks: [utf8Bytes("x".repeat(200))],
      cancelSpy: (r) => cancels.push(r),
    });
    await expect(readBoundedResponseText(response, { maxBytes: 50 })).rejects.toThrow();
    expect(cancels.length).toBe(1);
    expect(response.wasCancelled).toBe(true);
  });
});

describe("readBoundedResponseText — Content-Length cannot be bypassed or solely trusted", () => {
  it("enforces the byte bound with NO Content-Length header at all (chunked transfer)", async () => {
    const response = makeStreamResponse({ chunks: [utf8Bytes("y".repeat(200))], headers: {} });
    await expect(readBoundedResponseText(response, { maxBytes: 50 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
  });

  it("enforces the byte bound even when Content-Length UNDERSTATES the true size", async () => {
    // A misbehaving/compromised server claims 10 bytes but actually sends 200.
    const response = makeStreamResponse({
      chunks: [utf8Bytes("z".repeat(200))],
      headers: { "content-length": "10" },
    });
    await expect(readBoundedResponseText(response, { maxBytes: 50 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
  });

  it("refuses EARLY when Content-Length correctly declares an over-limit size, before reading any chunk", async () => {
    let readCalls = 0;
    const chunks = [utf8Bytes("w".repeat(10))];
    const response = makeStreamResponse({ chunks, headers: { "content-length": "999999" } });
    const originalGetReader = response.body.getReader;
    response.body.getReader = () => {
      readCalls += 1;
      return originalGetReader();
    };
    await expect(readBoundedResponseText(response, { maxBytes: 50 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
    expect(readCalls).toBe(0); // never even started streaming
  });

  it("ignores a malformed (non-numeric) Content-Length and falls back to real byte counting", async () => {
    const response = makeStreamResponse({
      chunks: [utf8Bytes("v".repeat(200))],
      headers: { "content-length": "not-a-number" },
    });
    await expect(readBoundedResponseText(response, { maxBytes: 50 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
  });

  it("succeeds when Content-Length is present, accurate, and within the limit", async () => {
    const text = "ok";
    const response = makeStreamResponse({
      chunks: [utf8Bytes(text)],
      headers: { "content-length": String(utf8Bytes(text).byteLength) },
    });
    await expect(readBoundedResponseText(response, { maxBytes: 100 })).resolves.toBe(text);
  });
});

describe("readBoundedResponseText — multibyte/Unicode cannot bypass a byte-based limit", () => {
  it("bounds by raw UTF-8 bytes, not JS string length (multibyte characters count as more than one byte)", async () => {
    // Each "é" is 2 bytes in UTF-8 but 1 UTF-16 code unit in a JS string.
    // 60 copies = 60 chars but 120 bytes — must fail a 100-byte limit even
    // though .length would suggest it fits.
    const text = "é".repeat(60);
    const response = makeStreamResponse({ chunks: [utf8Bytes(text)] });
    expect(utf8Bytes(text).byteLength).toBe(120);
    await expect(readBoundedResponseText(response, { maxBytes: 100 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
  });

  it("correctly decodes multibyte content that fits within the byte limit", async () => {
    const text = "é".repeat(10); // 20 bytes
    const response = makeStreamResponse({ chunks: [utf8Bytes(text)] });
    await expect(readBoundedResponseText(response, { maxBytes: 100 })).resolves.toBe(text);
  });
});

describe("readBoundedResponseText — partial oversized body is never exposed", () => {
  it("throws before returning any text — a caller cannot accidentally JSON.parse a truncated fragment", async () => {
    const response = makeStreamResponse({ chunks: [utf8Bytes(`{"a":"${"x".repeat(200)}"}`)] });
    let resolvedValue;
    let rejected = false;
    try {
      resolvedValue = await readBoundedResponseText(response, { maxBytes: 50 });
    } catch (err) {
      rejected = true;
      expect(err).toBeInstanceOf(ResponseTooLargeError);
      // The error carries only the configured limit, never any body content.
      expect(err.message).not.toContain("x".repeat(10));
      expect(Object.keys(err)).not.toContain("body");
      expect(Object.keys(err)).not.toContain("text");
    }
    expect(rejected).toBe(true);
    expect(resolvedValue).toBeUndefined();
  });
});

describe("readBoundedResponseText — defaults and options", () => {
  it("uses DEFAULT_MAX_RESPONSE_BYTES when no maxBytes option is given", async () => {
    const response = makeStreamResponse({ chunks: [utf8Bytes("small")] });
    await expect(readBoundedResponseText(response)).resolves.toBe("small");
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBeGreaterThan(1024);
  });

  it("falls back to response.text() when no streaming body is available, still honoring Content-Length", async () => {
    const response = {
      headers: { get: (name) => (name === "content-length" ? "999999" : null) },
      body: null,
      text: async () => "should not be reached",
    };
    await expect(readBoundedResponseText(response, { maxBytes: 50 })).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
  });

  it("falls back to response.text() and returns it when no body stream and no oversize Content-Length", async () => {
    const response = {
      headers: { get: () => null },
      body: null,
      text: async () => "fallback text",
    };
    await expect(readBoundedResponseText(response, { maxBytes: 50 })).resolves.toBe("fallback text");
  });
});
