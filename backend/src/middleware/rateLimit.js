"use strict";

// Phase 7 — request rate limiting for the three surfaces that can be abused
// cheaply from outside: authentication (credential stuffing), report upload
// (parser and disk pressure), and explicit provider execution (third-party
// quota spend and cost).
//
// Written without a dependency on purpose. A release candidate that must run
// offline, deterministically, and be auditable line-by-line is not the place to
// add transitive supply-chain surface for ~90 lines of counting. It is a fixed
// window counter, which is the same algorithm express-rate-limit uses by
// default, with the same well-known trade-off: up to 2x `max` can pass across a
// window boundary. That is acceptable here — the goal is to stop an unbounded
// loop, not to meter billing.
//
// What this deliberately does NOT do:
//
//   * It does not read X-Forwarded-For. Express only populates req.ip from that
//     header when `trust proxy` is set, and this app never sets it. Honouring a
//     client-supplied forwarding header without a trusted proxy in front would
//     let any caller rotate their own limiter key by editing a header, which is
//     strictly worse than no limiter at all because it would look like one.
//   * It does not write an AuditLog row. AuditLog records domain acts by an
//     identified actor; a refused request performed no act. Refusals are logged
//     through the same redacting logger as every other server-side event.
//   * It does not put anything caller-controlled in the response body.

const { redact } = require("../lib/redact");

// Hard ceiling on distinct keys held in memory. A limiter that grows without
// bound under a distributed source is a memory-exhaustion vector wearing a
// security-control costume.
const MAX_TRACKED_KEYS = 20000;

/**
 * Resolves the counting key for a request.
 *
 * Authenticated callers are counted per user id, so one noisy analyst cannot
 * consume the budget of everyone sharing an egress IP. Unauthenticated callers
 * (login, refresh) can only be counted per address.
 *
 * The `user:` / `ip:` prefixes keep the two namespaces from colliding — without
 * them a user whose id is "7" and a caller from an address literally named "7"
 * would share a counter.
 */
function resolveKey(req) {
  const userId = req && req.user ? req.user.id : undefined;
  if (userId !== undefined && userId !== null && userId !== "") {
    return `user:${userId}`;
  }
  // req.ip is undefined only when the socket is already gone; "unknown" then
  // groups those together rather than granting them an unlimited budget each.
  const address = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || "unknown";
  return `ip:${address}`;
}

/**
 * Creates one independent fixed-window limiter.
 *
 * Each call owns its own store, so the auth bucket and the upload bucket cannot
 * exhaust one another.
 *
 * @param {{name: string, windowMs: number, max: number, enabled?: boolean}} options
 */
function createRateLimiter(options) {
  const { name, windowMs, max } = options || {};

  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("rateLimit: name is required");
  }
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error(`rateLimit(${name}): windowMs must be a positive integer`);
  }
  if (!Number.isInteger(max) || max <= 0) {
    throw new Error(`rateLimit(${name}): max must be a positive integer`);
  }

  // key -> { count, resetAt }
  const hits = new Map();

  function prune(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) {
        hits.delete(key);
      }
    }
  }

  function middleware(req, res, next) {
    // Read at call time, not at construction time, so a test (or an operator
    // restarting with a different value) does not need a fresh module registry.
    if (options.enabled === false) {
      return next();
    }

    const now = Date.now();
    const key = resolveKey(req);
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      if (hits.size >= MAX_TRACKED_KEYS) {
        prune(now);
        // Still full after pruning: every tracked key is live. Drop the oldest
        // window rather than growing, and never fail open silently for the
        // caller that triggered the eviction.
        if (hits.size >= MAX_TRACKED_KEYS) {
          const oldest = hits.keys().next();
          if (!oldest.done) hits.delete(oldest.value);
        }
      }
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));

      // The key is intentionally absent from the log line: for an
      // unauthenticated caller it is a client address, and this log is not an
      // access log. The bucket name is enough to see which control fired.
      console.warn(
        "Rate limit exceeded",
        redact({
          limiter: name,
          method: req.method,
          path: req.originalUrl,
          requestId: req.context ? req.context.requestId : undefined,
        })
      );

      const body = {
        success: false,
        message: "Too many requests. Please retry later.",
      };
      if (req.context && req.context.requestId) {
        body.requestId = req.context.requestId;
      }
      return res.status(429).json(body);
    }

    return next();
  }

  // Test seam. Production code never calls this; the Phase 7 security suite
  // uses it so one bucket's proof cannot leak into the next test.
  middleware.reset = () => hits.clear();
  middleware.limiterName = name;
  middleware.max = max;
  middleware.windowMs = windowMs;

  return middleware;
}

module.exports = { createRateLimiter, resolveKey, MAX_TRACKED_KEYS };
