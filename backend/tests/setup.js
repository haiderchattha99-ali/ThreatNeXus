"use strict";

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

// Keep the suite hermetic.
//
// src/config/env.js calls dotenv.config() at require time. On a machine with a
// real backend/.env that silently injected the developer's DATABASE_URL, JWT
// secret and live provider API keys into every test process — which made three
// env.test.js cases (the ones asserting that a MISSING required variable is
// rejected) stop failing when they should, and made provider-dependent
// behaviour differ between a machine that has a .env and one that does not.
//
// With this set, every test constructs the environment it needs explicitly.
// That is the condition the suite was written under, and one it previously
// enjoyed only by accident.
process.env.TNX_SKIP_DOTENV = "true";
