"use strict";

// Phase 10A-1 — every database statement the orchestration layer issues.
// Nothing above this file talks to Prisma directly, and nothing in this file
// makes a decision: the router decides, this persists.
//
// NO PROVIDER, NO NETWORK. This module must never import a provider factory,
// enrichmentRunner, vulnerabilityRunner or any fetch implementation — a static
// inertness test asserts exactly that for the whole enrichmentOrchestration
// package.
//
// ---------------------------------------------------------------------------
// P2002 is handled by the CALLER, outside any transaction
// ---------------------------------------------------------------------------
// Same hard-won rule enrichmentQueueService.js documents: on PostgreSQL a
// constraint violation caught INSIDE an open transaction leaves it aborted
// (25P02) and every later statement in it fails opaquely. So the functions
// here issue plain statements and let their caller re-read committed state and
// retry the whole read-decide-write cycle.

const PRISMA_UNIQUE_VIOLATION = "P2002";

/**
 * Whether an error is the unique-constraint violation the create paths race
 * on. Exported so the service's retry loop and the tests agree on one
 * definition.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isUniqueViolation(error) {
  return Boolean(error) && error.code === PRISMA_UNIQUE_VIOLATION;
}

// --- Finding subjects ------------------------------------------------------

/**
 * Loads the Finding's own IPv4 indicator.
 *
 * @returns {Promise<{id: number, indicatorValue: string}|null>}
 */
async function findFindingIndicator(client, findingId) {
  return client.finding.findUnique({
    where: { id: findingId },
    select: { id: true, indicatorValue: true },
  });
}

/**
 * The CVE subjects for one Finding.
 *
 * Both filters are applied explicitly even though VulnerabilityEvidenceSource
 * currently has exactly one value (ANALYST_VERIFIED): the rule "never derive a
 * CVE association from provider text" must be visible and testable in the
 * query, not left as an implicit consequence of today's enum having one
 * member. If a PROVIDER_REPORTED value is ever added, this query already
 * excludes it.
 *
 * `supersededAt: null` restricts to the CURRENT association — a superseded row
 * is history, not a live subject.
 *
 * @returns {Promise<Array<{cveId: string}>>} distinct canonical CVE ids
 */
async function findVerifiedCveSubjects(client, findingId) {
  const rows = await client.findingVulnerability.findMany({
    where: {
      findingId,
      state: "ACTIVE",
      evidenceSource: "ANALYST_VERIFIED",
      supersededAt: null,
    },
    select: { vulnerability: { select: { cveId: true } } },
    orderBy: { id: "asc" },
  });

  // Three verified CVEs stay three subjects. Deduplication is by canonical
  // cveId only, so the same CVE associated twice cannot become two subjects.
  const seen = new Set();
  const subjects = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const row of rows) {
    const cveId = row.vulnerability ? row.vulnerability.cveId : null;
    if (cveId && !seen.has(cveId)) {
      seen.add(cveId);
      subjects.push({ cveId });
    }
  }
  return subjects;
}

// --- Runs ------------------------------------------------------------------

async function findRunByIdempotencyKey(client, idempotencyKey) {
  return client.findingEnrichmentRun.findUnique({ where: { idempotencyKey } });
}

async function createRun(client, data) {
  return client.findingEnrichmentRun.create({ data });
}

async function findRunById(client, runId) {
  return client.findingEnrichmentRun.findUnique({ where: { id: runId } });
}

async function updateRunState(client, runId, { state, completedAt }) {
  return client.findingEnrichmentRun.update({
    where: { id: runId },
    data: { state, completedAt },
  });
}

// There is deliberately NO "list every run for a Finding" query. A run-history
// browser is not part of the Phase 10A-1 contract, and the surface that existed
// for it was unplanned; the summary read below answers the question an analyst
// actually has ("what is known about this Finding?") without paging through
// request records.

// --- Run items -------------------------------------------------------------

async function createRunItem(client, data) {
  return client.findingEnrichmentRunItem.create({ data });
}

/**
 * The most recent item for ONE (Finding, provider, subject) triple, with its
 * job AND the job's delegate rows.
 *
 * Bounded by construction: the summary calls this once per known provider plus
 * once per verified CVE, never once per row in any table. The delegates are
 * included because a delegated job's own state is WAITING_ON_DELEGATE, which is
 * a fact about the job and not about the work — the truth lives in the
 * canonical queue's row.
 *
 * Ordered by id descending: a Finding accumulates one item per run per target
 * over time, and the CURRENT answer is the newest one.
 */
async function findLatestRunItemForSubject(
  client,
  { findingId, provider, subjectType, subjectValue }
) {
  return client.findingEnrichmentRunItem.findFirst({
    where: { findingId, provider, subjectType, subjectValue },
    orderBy: { id: "desc" },
    include: {
      lookupJob: { include: { iocEnrichment: true, vulnerabilityEnrichmentJob: true } },
    },
  });
}

/**
 * A run's items with each item's linked job. The job is included because an
 * ELIGIBLE item has NO status of its own — its observed status IS its job's
 * state (one copy of the truth, so nothing can drift).
 */
async function listRunItemsWithJobs(client, runId) {
  return client.findingEnrichmentRunItem.findMany({
    where: { runId },
    orderBy: { id: "asc" },
    include: { lookupJob: true },
  });
}

// --- Lookup jobs -----------------------------------------------------------

/**
 * The single active job for one work identity, if one exists.
 *
 * activeLookupKey is UNIQUE and carries queryIdentityHash only while the job
 * is non-terminal, so this returns at most one row and unlimited terminal
 * history coexists beneath it. THIS IS THE WHOLE CROSS-FINDING DEDUP
 * MECHANISM — ten Findings on one IP find the same row here.
 */
async function findActiveJobByLookupKey(client, activeLookupKey) {
  return client.providerLookupJob.findUnique({ where: { activeLookupKey } });
}

async function createLookupJob(client, data) {
  return client.providerLookupJob.create({ data });
}

/**
 * The freshest terminal job for one subject, used for the freshness decision.
 *
 * Only a job whose freshUntil is still in the future counts. `queriedAt` order
 * makes "freshest" deterministic when several terminal rows exist.
 */
async function findFreshJobForSubject(client, { provider, subjectType, subjectValue, asOf }) {
  return client.providerLookupJob.findFirst({
    where: {
      provider,
      subjectType,
      subjectValue,
      freshUntil: { gt: asOf },
    },
    orderBy: { queriedAt: "desc" },
  });
}

/**
 * Non-terminal jobs in one state, for the reconciliation service.
 *
 * Bounded by `take` — a reconciliation pass must never load an unbounded
 * result set into memory.
 */
async function listJobsInState(client, { state, take }) {
  return client.providerLookupJob.findMany({
    where: { state },
    orderBy: { requestedAt: "asc" },
    take,
    include: { iocEnrichment: true, vulnerabilityEnrichmentJob: true },
  });
}

async function updateJob(client, jobId, data) {
  return client.providerLookupJob.update({ where: { id: jobId }, data });
}

// --- Phase 10A-2 execution -------------------------------------------------
//
// Every statement below is a GUARDED single statement whose WHERE names the
// state it expects. That guard IS the concurrency control, exactly as
// iocEnrichmentRepository.js's header explains: at READ COMMITTED PostgreSQL
// row-locks the target for the duration of the UPDATE and re-evaluates the
// WHERE against the winner's committed row, so a loser matches zero rows
// instead of overwriting the winner's work.
//
// `claimToken` is the ONLY completion credential. `updatedAt` is never used as
// a concurrency version token — that mistake is already recorded and withdrawn
// in STATUS.md for P1-T4.

const crypto = require("node:crypto");

const NON_TERMINAL_DIRECT_STATES = Object.freeze(["PENDING"]);

/**
 * Bounded, deterministically ordered direct-execution candidates.
 *
 * RETRY_WAIT is deliberately absent: Phase 10A-2 never retries a provider
 * OUTCOME (D-P10A2-06), so no job ever enters that state and listing it would
 * imply a retry path that does not exist.
 */
async function listDirectCandidates(client, { providers, asOf, take }) {
  return client.providerLookupJob.findMany({
    where: {
      trigger: "RUN_DIRECT",
      provider: { in: providers },
      state: { in: [...NON_TERMINAL_DIRECT_STATES] },
      OR: [{ claimToken: null }, { leaseExpiresAt: { lte: asOf } }],
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    take,
  });
}

/**
 * Targeted AbuseIPDB candidates — Phase-10 jobs whose LINKED canonical row is
 * actually claimable right now.
 *
 * The relation filter mirrors every gate claimPendingJob will apply. Without
 * it, the same head-of-queue jobs whose delegates are leased, retry-gated or
 * budget-exhausted are re-selected on every tick, every claim loses, and later
 * eligible work is never reached.
 *
 * `provider` is matched by POSITIVE equality rather than by excluding nvd: a
 * negative filter silently admits any provider added later, whereas this
 * structurally excludes everything that is not AbuseIPDB.
 */
async function listTargetedDelegateCandidates(client, { asOf, take, skip = 0 }) {
  return client.providerLookupJob.findMany({
    where: {
      trigger: "RUN_DELEGATED",
      provider: "abuseipdb",
      state: "WAITING_ON_DELEGATE",
      iocEnrichmentId: { not: null },
      iocEnrichment: {
        is: {
          status: "PENDING",
          AND: [
            { OR: [{ claimToken: null }, { leaseExpiresAt: { lte: asOf } }] },
            { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: asOf } }] },
          ],
        },
      },
    },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    take,
    skip,
    include: { iocEnrichment: true },
  });
}

/**
 * Atomically leases one direct job AND consumes one unit of its attempt
 * budget, in the SAME statement — so two racers can never both count an
 * attempt for the same lease.
 *
 * `maxAttempts` is read first and used as a constant in the WHERE. That is
 * safe because it is immutable for a row's life, while `attemptCount` is
 * re-evaluated by PostgreSQL at update time against the winner's committed
 * row — the identical reasoning claimPendingJob documents.
 *
 * @returns {Promise<{record: object, claimToken: string}|null>} null for every
 *   loser: already leased, already terminal, or budget exhausted.
 */
async function claimLookupJob(client, id, { now, leaseMs }) {
  const existing = await client.providerLookupJob.findUnique({ where: { id } });
  if (!existing || !NON_TERMINAL_DIRECT_STATES.includes(existing.state)) return null;
  const maxAttempts = Number.isInteger(existing.maxAttempts) ? existing.maxAttempts : 0;

  const claimToken = crypto.randomUUID();

  const { count } = await client.providerLookupJob.updateMany({
    where: {
      id,
      state: { in: [...NON_TERMINAL_DIRECT_STATES] },
      attemptCount: { lt: maxAttempts },
      OR: [{ claimToken: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      state: "LEASED",
      claimToken,
      claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      lastAttemptAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (count === 0) return null;

  const record = await client.providerLookupJob.findUnique({ where: { id } });
  // Ownership is never assumed from a local variable alone.
  if (!record || record.claimToken !== claimToken) return null;
  return { record, claimToken };
}

/**
 * Drives a claimed direct job to a terminal state, guarded by its claim token.
 *
 * `activeLookupKey: null` is the load-bearing field: it is what releases the
 * work identity so a FUTURE ask about this subject can create fresh work.
 * PostgreSQL treats multiple NULLs in a unique index as distinct, so the
 * terminal row stays as history without blocking anything.
 *
 * @returns {Promise<boolean>} true when THIS call performed the transition
 */
async function terminalizeClaimedJob(client, { id, claimToken, state, now, evidence, freshUntil, httpStatus, errorCode, retryAfterSeconds, terminalReasonCode }) {
  const { count } = await client.providerLookupJob.updateMany({
    where: { id, state: "LEASED", claimToken },
    data: {
      state,
      completedAt: now,
      queriedAt: now,
      freshUntil: freshUntil ?? null,
      activeLookupKey: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      httpStatus: httpStatus ?? null,
      errorCode: errorCode ?? null,
      retryAfterSeconds: retryAfterSeconds ?? null,
      terminalReasonCode: terminalReasonCode ?? null,
      ...(state === "DEAD_LETTER" ? { deadLetteredAt: now } : {}),
      ...(evidence || {}),
    },
  });
  return count === 1;
}

/**
 * Refuses a claimed direct job for budget in ONE statement: terminalize,
 * refund the attempt, and clear the lease and the work identity together.
 *
 * Deliberately not "release, then terminalize". That ordering leaves a window
 * in which another worker can claim the released job and call the provider
 * before the first worker records the refusal.
 */
async function refuseClaimedJobForBudget(client, { id, claimToken, now }) {
  const { count } = await client.providerLookupJob.updateMany({
    where: { id, state: "LEASED", claimToken },
    data: {
      state: "SKIPPED_BUDGET",
      completedAt: now,
      activeLookupKey: null,
      claimToken: null,
      claimedAt: null,
      leaseExpiresAt: null,
      // The attempt never happened — no provider was contacted and no quota
      // was reserved — so the budget unit this claim consumed is given back.
      attemptCount: { decrement: 1 },
    },
  });
  return count === 1;
}

/**
 * Transitions a WAITING_ON_DELEGATE job to a terminal state, guarded on that
 * state. Used by reconciliation, by targeted budget refusal, and by ambiguity
 * resolution — none of which holds a Phase-10 claim token, because the
 * targeted path never leases the Phase-10 job (D-P10A2-05).
 */
async function terminalizeDelegatedJob(client, { id, state, now, terminalReasonCode }) {
  const { count } = await client.providerLookupJob.updateMany({
    where: { id, state: "WAITING_ON_DELEGATE" },
    data: {
      state,
      completedAt: now,
      activeLookupKey: null,
      terminalReasonCode: terminalReasonCode ?? null,
      ...(state === "DEAD_LETTER" ? { deadLetteredAt: now } : {}),
    },
  });
  return count === 1;
}

/**
 * Direct jobs whose lease has expired, for stale-claim recovery. The owning
 * attempt is included because the lease alone cannot decide what to do: a
 * contacted attempt must never be requeued.
 */
async function listExpiredDirectLeases(client, { asOf, take }) {
  return client.providerLookupJob.findMany({
    where: { state: "LEASED", leaseExpiresAt: { lte: asOf } },
    orderBy: { leaseExpiresAt: "asc" },
    take,
    include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } },
  });
}

/**
 * Returns an expired-lease job to the queue. `attemptCount` is NOT refunded:
 * the attempt genuinely happened, and refunding it would let a job that
 * crashes reliably retry forever.
 */
async function releaseExpiredDirectLease(client, { id, claimToken, exhausted, now }) {
  const { count } = await client.providerLookupJob.updateMany({
    where: { id, state: "LEASED", claimToken },
    data: exhausted
      ? {
          state: "DEAD_LETTER",
          completedAt: now,
          deadLetteredAt: now,
          terminalReasonCode: "MAX_ATTEMPTS_EXHAUSTED",
          activeLookupKey: null,
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
        }
      : {
          state: "PENDING",
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
        },
  });
  return count === 1;
}

/**
 * The distinct run ids holding an item that points at one job. Used to refresh
 * every affected run after a job goes terminal — a shared job can belong to
 * many runs, and leaving any of them stale would misreport what is known.
 */
async function listRunIdsForJob(client, jobId) {
  const rows = await client.findingEnrichmentRunItem.findMany({
    where: { lookupJobId: jobId },
    select: { runId: true },
    distinct: ["runId"],
  });
  return rows.map((row) => row.runId);
}

// --- Delegate rows ---------------------------------------------------------
//
// There is deliberately NO delegate lookup here. Finding-or-creating a delegate
// is the canonical queue services' job (enrichmentQueueService for AbuseIPDB,
// vulnerabilityQueueService for NVD), and a second implementation of "is there
// an active row for this subject?" in this file would be a second definition of
// active-job uniqueness — the exact duplication that lets two answers drift
// apart. enrichmentRunService calls those services directly.

// --- Usage accounting ------------------------------------------------------

/**
 * Phase-10 reservation rows. In Phase 10A-1 this always returns an empty set,
 * because nothing writes ProviderDailyUsage — the usage API says so explicitly
 * rather than presenting the empty result as "zero provider calls happened".
 */
async function listDailyUsage(client, { usageDate }) {
  return client.providerDailyUsage.findMany({
    where: usageDate ? { usageDate } : {},
    orderBy: [{ usageDate: "desc" }, { provider: "asc" }, { lane: "asc" }],
  });
}

module.exports = {
  PRISMA_UNIQUE_VIOLATION,
  isUniqueViolation,
  findFindingIndicator,
  findVerifiedCveSubjects,
  findRunByIdempotencyKey,
  createRun,
  findRunById,
  updateRunState,
  createRunItem,
  findLatestRunItemForSubject,
  listRunItemsWithJobs,
  findActiveJobByLookupKey,
  createLookupJob,
  findFreshJobForSubject,
  listJobsInState,
  updateJob,
  listDailyUsage,
  // Phase 10A-2 execution
  NON_TERMINAL_DIRECT_STATES,
  listDirectCandidates,
  listTargetedDelegateCandidates,
  claimLookupJob,
  terminalizeClaimedJob,
  refuseClaimedJobForBudget,
  terminalizeDelegatedJob,
  listExpiredDirectLeases,
  releaseExpiredDirectLease,
  listRunIdsForJob,
};
