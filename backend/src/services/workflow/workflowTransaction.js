"use strict";

// Shared SERIALIZABLE-transaction runner for the Phase 3 workflow services.
//
// This is a direct reuse of the P1-T4 dedup-service concurrency pattern (see
// services/normalization/dedupService.js's header) and the P2-T1 ownership
// supersede-then-insert repair. The reasoning is unchanged and is repeated
// here because it is the single most-repeated correctness trap in this
// repository:
//
//   On PostgreSQL a constraint violation puts the SURROUNDING transaction into
//   an aborted state. Every later statement on it fails with SQLSTATE 25P02
//   ("current transaction is aborted"), which Prisma surfaces as an opaque
//   PrismaClientUnknownRequestError with code undefined. So an in-transaction
//   `catch (P2002) -> re-query` pattern does not merely fail to recover, it
//   converts a recoverable race into an unreadable error.
//
// Recovery therefore ALWAYS re-runs the entire transaction from the outside,
// reloading state and re-deciding from scratch. Callback bodies must never
// catch a Prisma error and keep using `tx`.
//
// Under SERIALIZABLE, two concurrent transactions that both read and then
// write the same Case or Finding cannot both commit — PostgreSQL rejects the
// loser (P2034) instead of applying a stale read-modify-write. That is what
// makes the plain read + guarded update in every Phase 3 service safe with no
// version column, no advisory lock and no raw SQL.

// Unique-constraint violation (a currentForFindingId / currentLinkKey /
// activeCaseId / recurrence-idempotency race). Retryable as a WHOLE
// transaction: re-running makes the winning row visible to our own read.
const PRISMA_UNIQUE_VIOLATION = "P2002";
// Write conflict / deadlock — how PostgreSQL serialization failures (40001)
// and deadlocks (40P01) surface through the installed Prisma client.
const PRISMA_TRANSACTION_CONFLICT = "P2034";

const RETRYABLE_ERROR_CODES = Object.freeze([
  PRISMA_UNIQUE_VIOLATION,
  PRISMA_TRANSACTION_CONFLICT,
]);

const MAX_TRANSACTION_ATTEMPTS = 5;
const TRANSACTION_ISOLATION_LEVEL = "Serializable";

// Bounded backoff between attempts.
//
// Retrying a serialization failure IMMEDIATELY is how a retry budget gets
// burned without ever making progress: every loser wakes at the same instant,
// collides with the same winner's successor, and the whole set marches in
// lockstep until the budget is exhausted. Measured directly here — six clients
// creating cases concurrently exhausted five immediate retries and surfaced a
// raw P2034 to the caller.
//
// The delay grows linearly with the attempt number and carries jitter so the
// losers do not re-collide with each other. It is capped so a pathological
// contention spike still fails fast rather than holding a request open.
const RETRY_BASE_DELAY_MS = 25;
const RETRY_MAX_DELAY_MS = 200;

function retryDelayMs(attempt) {
  const base = Math.min(RETRY_BASE_DELAY_MS * attempt, RETRY_MAX_DELAY_MS);
  return base + Math.floor(Math.random() * RETRY_BASE_DELAY_MS);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Deliberately does NOT match a PrismaClientUnknownRequestError (code
// undefined): that is the signature of a genuinely broken transaction, not a
// resolvable race, and retrying it would hide a real defect.
function isRetryableConcurrencyError(error) {
  return Boolean(error) && RETRYABLE_ERROR_CODES.includes(error.code);
}

/**
 * Runs `fn(tx)` inside one SERIALIZABLE interactive transaction, re-running the
 * ENTIRE transaction (up to MAX_TRANSACTION_ATTEMPTS) on a recognised
 * concurrency error. Any other error propagates unchanged and is never retried.
 *
 * @param {object} client - a PrismaClient (or a transaction-capable stub)
 * @param {(tx:object)=>Promise<any>} fn
 * @returns {Promise<any>}
 */
async function runSerializable(client, fn) {
  return runWithRetry(client, fn, { isolationLevel: TRANSACTION_ISOLATION_LEVEL });
}

/**
 * Runs `fn(tx)` inside one transaction at the connection's DEFAULT isolation
 * level (READ COMMITTED on PostgreSQL), with the same bounded retry.
 *
 * For transactions that are purely additive — every row they write is a fresh
 * INSERT, and no decision inside them depends on a value they read and then
 * write back. Case creation is the one such path in this phase: the case
 * reference is derived from the database's own assigned primary key, so two
 * concurrent creations cannot produce the same value no matter how they
 * interleave.
 *
 * Using SERIALIZABLE there is not merely unnecessary, it is actively harmful:
 * assigning a value into the unique caseReference index takes predicate locks
 * on the index pages, so concurrent creations conflict with each other on
 * PAGE adjacency rather than on any real data dependency. Measured directly —
 * six concurrent creations exhausted five SERIALIZABLE retries and surfaced a
 * raw P2034, and still do with backoff added, because the conflict is
 * structural rather than transient.
 *
 * The rule for choosing: if the callback re-reads state and then writes based
 * on it, use runSerializable. If it only inserts, use this.
 */
async function runAtomic(client, fn) {
  return runWithRetry(client, fn, {});
}

async function runWithRetry(client, fn, transactionOptions) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await client.$transaction((tx) => fn(tx), transactionOptions);
    } catch (error) {
      if (!isRetryableConcurrencyError(error)) throw error;
      lastError = error;
      if (attempt < MAX_TRANSACTION_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(retryDelayMs(attempt));
      }
    }
  }
  // Bounded retries exhausted — rethrow the real Prisma error unchanged so the
  // caller sees the actual cause rather than an invented one.
  throw lastError;
}

module.exports = {
  PRISMA_UNIQUE_VIOLATION,
  PRISMA_TRANSACTION_CONFLICT,
  RETRYABLE_ERROR_CODES,
  MAX_TRANSACTION_ATTEMPTS,
  TRANSACTION_ISOLATION_LEVEL,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  retryDelayMs,
  isRetryableConcurrencyError,
  runSerializable,
  runAtomic,
};
