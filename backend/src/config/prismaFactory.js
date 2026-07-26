"use strict";

// Constructs a PrismaClient pointed at an explicit connection URL, instead of
// the DATABASE_URL-reading singleton in config/prisma.js. Exists so callers
// outside this package (e.g. eval/run_phase1_gate.js, which lives at the
// repo root as a sibling of backend/, not underneath it, and so cannot
// resolve a bare `require("@prisma/client")` via normal node_modules
// ancestor lookup) can get a real PrismaClient without ever touching
// DATABASE_URL. Mirrors the same-purpose inline pattern already used by
// backend/tests/integration/*Concurrency.test.js
// (`new PrismaClient({datasources:{db:{url}}})`), just factored out so it can
// be reached from outside this package via a plain relative require.

const { PrismaClient } = require("@prisma/client");

function createPrismaClient(url) {
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("createPrismaClient: url must be a non-empty string");
  }
  return new PrismaClient({ datasources: { db: { url } } });
}

module.exports = { createPrismaClient };
