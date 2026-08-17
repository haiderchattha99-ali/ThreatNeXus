"use strict";

// TNX-P10C5 — one shared, provider-agnostic safety net for reading an HTTP
// response body. Every real provider adapter in this codebase
// (greynoise/censys/shodan/netlas/abuseipdb) independently called
// `response.json()` after a successful fetch, which materializes the ENTIRE
// body into memory with no upper bound before parsing a single byte. A
// misbehaving or compromised provider endpoint (or one sitting behind a
// compromised/misconfigured proxy) could exhaust process memory with an
// arbitrarily large, or infinite chunked, response — the process never asked
// "how big is this?" before reading all of it.
//
// This module closes that gap ONCE, at the narrowest possible seam: the
// body-read step, after the HTTP response object already exists (status and
// headers known) but before any byte has been decoded or parsed. It does
// NOT touch the fetch call, headers, AbortController/timeout, or
// status-code classification — those stay exactly where they already are,
// in each provider module. One job only: turn a Response's body into a
// bounded UTF-8 string, or refuse before materializing more than the limit.

// A generous, single shared limit rather than a per-provider policy: none of
// this codebase's five provider responses (small reputation/exposure JSON
// records) come remotely close to this size, so one constant is simpler and
// no less safe than reproducing a "per-provider max size" policy five times.
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB

class ResponseTooLargeError extends Error {
  constructor(limitBytes) {
    super(`Provider response body exceeded the ${limitBytes}-byte limit`);
    this.name = "ResponseTooLargeError";
    this.limitBytes = limitBytes;
  }
}

function parseContentLength(response) {
  const raw =
    response && response.headers && typeof response.headers.get === "function"
      ? response.headers.get("content-length")
      : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Content-Length is defined as a non-negative decimal integer. Anything
  // else (blank, negative, non-numeric, a list from a malformed proxy) is
  // treated as absent rather than guessed at — the byte-counting loop below
  // is the real enforcement either way.
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads a Fetch API Response body as UTF-8 text, refusing before more than
 * `maxBytes` is ever materialized in memory.
 *
 * Enforcement is on ACTUAL RECEIVED BYTES read from the stream — never on
 * the declared Content-Length alone, and never on decoded-character length.
 * A missing Content-Length (chunked transfer), or one that understates the
 * true size, cannot bypass the bound: every chunk pulled from the reader is
 * counted by its raw `byteLength` before anything is decoded. A present,
 * over-limit Content-Length is used only as an EARLY refusal, so an
 * obviously oversized response never starts streaming into memory at all —
 * it is an optimization, not the safety boundary itself.
 *
 * On exceeding the limit, the underlying reader (and therefore the fetch's
 * connection) is cancelled where the runtime supports it, no partial bytes
 * are decoded or returned, and no text this function has already
 * accumulated is exposed to the caller — a partial oversized body can never
 * be mistaken for a complete, parseable response.
 *
 * @param {Response} response a Fetch API Response whose body has not yet
 *   been consumed
 * @param {{maxBytes?: number}} [options]
 * @returns {Promise<string>} the decoded body text, present only if the
 *   full body arrived within `maxBytes`
 * @throws {ResponseTooLargeError} if the body exceeds maxBytes
 */
async function readBoundedResponseText(response, options = {}) {
  const maxBytes =
    Number.isInteger(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_MAX_RESPONSE_BYTES;

  const declaredLength = parseContentLength(response);
  if (declaredLength !== null && declaredLength > maxBytes) {
    if (response.body && typeof response.body.cancel === "function") {
      await response.body.cancel().catch(() => {});
    }
    throw new ResponseTooLargeError(maxBytes);
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    // No streaming body reader on this Response implementation. Every real
    // Fetch API Response (Node's native fetch included) exposes one; this
    // path exists only for a caller-supplied stand-in that chooses not to.
    // Content-Length was already checked above; without a stream to count,
    // there is nothing further to bound.
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;

    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      // The real enforcement point — independent of whatever Content-Length
      // claimed, or whether one was sent at all. Cancelling releases the
      // underlying connection instead of letting it run to completion.
      // eslint-disable-next-line no-await-in-loop
      await reader.cancel(`response exceeded ${maxBytes} bytes`).catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  // eslint-disable-next-line no-restricted-syntax
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(body);
}

module.exports = {
  DEFAULT_MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  readBoundedResponseText,
};
