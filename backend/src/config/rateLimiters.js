"use strict";

// The three application rate-limit buckets, built once from configuration.
//
// They live here rather than inside each router so the counters are shared by
// every route that belongs to the same surface. Two routers that both spend
// provider quota must draw on ONE budget, or the limit is only as strong as the
// most permissive path into it.
//
// Like every other module under src/, this is re-evaluated whenever a test
// clears the require cache, which is how the Phase 7 security suite constructs
// an app with deliberately tiny limits.

const env = require("./env");
const { createRateLimiter } = require("../middleware/rateLimit");

// Credential surface: login and register. The tightest bucket, because this is
// the one an attacker can drive with no account at all.
const authRateLimiter = createRateLimiter({
  name: "auth",
  windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS,
  max: env.RATE_LIMIT_AUTH_MAX,
  enabled: env.RATE_LIMIT_ENABLED,
});

// Report ingestion. Each accepted upload costs a multipart write to disk plus a
// bounded-but-real parse of up to REPORT_MAX_ROWS rows.
const uploadRateLimiter = createRateLimiter({
  name: "upload",
  windowMs: env.RATE_LIMIT_UPLOAD_WINDOW_MS,
  max: env.RATE_LIMIT_UPLOAD_MAX,
  enabled: env.RATE_LIMIT_ENABLED,
});

// Explicit provider execution: the routes where an authenticated caller asks
// the system to go and spend somebody else's quota — IOC enrichment, CVE
// enrichment, both batch workers, and an AI suggestion generation run.
//
// Note this bounds the REQUEST rate, which is a different control from the
// provider-side queue, cache, TTL and dead-letter policy. Those bound how much
// work reaches the third party; this bounds how often a caller may ask.
const providerRateLimiter = createRateLimiter({
  name: "provider",
  windowMs: env.RATE_LIMIT_PROVIDER_WINDOW_MS,
  max: env.RATE_LIMIT_PROVIDER_MAX,
  enabled: env.RATE_LIMIT_ENABLED,
});

module.exports = {
  authRateLimiter,
  uploadRateLimiter,
  providerRateLimiter,
};
