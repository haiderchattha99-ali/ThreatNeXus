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

async function listRunsForFinding(client, findingId, { take }) {
  return client.findingEnrichmentRun.findMany({
    where: { findingId },
    orderBy: { requestedAt: "desc" },
    take,
  });
}

// --- Run items -------------------------------------------------------------

async function createRunItem(client, data) {
  return client.findingEnrichmentRunItem.create({ data });
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

// --- Delegate rows (READ ONLY in Phase 10A-1) ------------------------------

/**
 * The existing active IOC enrichment row for one cache identity, if any.
 *
 * Phase 10A-1 only LINKS to a delegate that already exists — it never creates
 * one, never claims one, and never changes one. The row it finds was created
 * by ingestion's own scheduleEnrichment, whose behaviour is untouched.
 */
async function findActiveIocEnrichment(client, activeCacheKey) {
  return client.iocEnrichment.findUnique({ where: { activeCacheKey } });
}

/**
 * The existing active vulnerability enrichment job for one CVE, if any.
 *
 * Same read-only rule. NVD work continues to be executed by the ADMIN
 * vulnerability batch; Phase 10 links to it so the orchestration record can
 * report the delegate's progress truthfully, and does not take it over.
 */
async function findActiveVulnerabilityJobForCve(client, cveId) {
  return client.vulnerabilityEnrichmentJob.findFirst({
    where: {
      vulnerability: { cveId },
      activeJobKey: { not: null },
    },
    orderBy: { requestedAt: "desc" },
  });
}

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
  listRunsForFinding,
  createRunItem,
  listRunItemsWithJobs,
  findActiveJobByLookupKey,
  createLookupJob,
  findFreshJobForSubject,
  listJobsInState,
  updateJob,
  findActiveIocEnrichment,
  findActiveVulnerabilityJobForCve,
  listDailyUsage,
};
