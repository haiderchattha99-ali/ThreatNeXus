"use strict";

// Phase 10A-1 — the Finding enrichment SUMMARY read.
//
// ===========================================================================
// This endpoint asks nobody anything
// ===========================================================================
// It performs no provider call, creates no run, no item, no job, no
// ProviderLookupAttempt and no ProviderDailyUsage row, reserves no quota and
// starts no worker. It issues SELECTs and returns what is already stored. The
// static inertness gate covers the package; a behavioural test asserts that a
// summary request writes nothing.
//
// ---------------------------------------------------------------------------
// One timestamped row per KNOWN provider — always all six
// ---------------------------------------------------------------------------
// Omitting a provider that has no record would make "we never asked" and "this
// provider does not exist" indistinguishable. Every known provider appears in
// every response, in a stable order, carrying a closed `status` code.
//
// ---------------------------------------------------------------------------
// NVD, and the rule an IP must never violate
// ---------------------------------------------------------------------------
// NVD's subject is a CVE. The only way a CVE becomes a subject is an ACTIVE,
// ANALYST_VERIFIED FindingVulnerability association — provider text naming a
// CVE is never promoted into one. A Finding with three verified CVEs gets three
// NVD sub-rows, because they are three different questions with three different
// answers.
//
// A Finding with NO such association gets exactly one NVD row with
// status = NO_SUBJECT and skipReason = NO_SUBJECT_FOR_PROVIDER: NVD was
// considered, and there was nothing valid to ask it about. NO NVD RUN ITEM IS
// CREATED (T-09), and an IP is never substituted as an NVD subject — this
// module never even reads the indicator on the NVD path.
//
// ---------------------------------------------------------------------------
// Where each row's truth comes from, and the boundary of that claim
// ---------------------------------------------------------------------------
// A delegated provider's Phase-10 job sits in WAITING_ON_DELEGATE, which is a
// fact about the job and NOT about the work. So when a job carries a delegate
// link, the state is read from the DELEGATE row and `source` says so.
//
// The boundary, stated deliberately: this summary describes ORCHESTRATION
// state. It resolves a delegate only through a link an orchestration item
// actually recorded. It does not go hunting for unlinked evidence that some
// other pipeline produced — a Finding whose AbuseIPDB row came from the legacy
// ingestion path, with no orchestration item, truthfully reads NOT_REQUESTED /
// source NONE here, and that evidence is served by the pre-existing
// GET /api/findings/:id/enrichments surface which exists for exactly that.
// Reporting it here would mean this endpoint claimed credit for work it has no
// record of.

const {
  SUMMARY_STATUSES,
  SUMMARY_SOURCES,
  SKIP_REASONS,
  RUN_ITEM_DECISIONS,
  NON_TERMINAL_JOB_STATES,
  SUCCESSFUL_JOB_STATES,
  SKIPPED_JOB_STATES,
  isKnownSkipReason,
} = require("./enrichmentDecisionCodes");
const {
  SUBJECT_TYPES,
  KNOWN_PROVIDERS,
  subjectTypeForProvider,
  purposeForProvider,
} = require("./enrichmentSubject");
const { resolveExecutionState } = require("./enrichmentRunReadService");
const repository = require("./enrichmentOrchestrationRepository");
const { ENRICHMENT_STATUS } = require("../enrichment/iocEnrichmentTypes");

class EnrichmentSummaryNotFoundError extends Error {
  constructor(findingId) {
    super(`Finding ${findingId} was not found`);
    this.name = "EnrichmentSummaryNotFoundError";
  }
}

class EnrichmentSummaryValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentSummaryValidationError";
  }
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

// An IocEnrichment status is a PROVIDER outcome vocabulary, not a job state, so
// it gets its own explicit map rather than being pattern-matched. NOT_FOUND is
// COMPLETED on purpose: "the provider has no record of this indicator" is a
// real answer, and calling it UNAVAILABLE would turn a known absence into an
// unknown — the exact confusion the IOC read service already guards against.
const IOC_STATUS_TO_SUMMARY = Object.freeze({
  [ENRICHMENT_STATUS.PENDING]: SUMMARY_STATUSES.PENDING,
  [ENRICHMENT_STATUS.SUCCESS]: SUMMARY_STATUSES.COMPLETED,
  [ENRICHMENT_STATUS.NOT_FOUND]: SUMMARY_STATUSES.COMPLETED,
  [ENRICHMENT_STATUS.RATE_LIMITED]: SUMMARY_STATUSES.UNAVAILABLE,
  [ENRICHMENT_STATUS.INVALID_KEY]: SUMMARY_STATUSES.UNAVAILABLE,
  [ENRICHMENT_STATUS.TIMEOUT]: SUMMARY_STATUSES.UNAVAILABLE,
  [ENRICHMENT_STATUS.FAILED]: SUMMARY_STATUSES.UNAVAILABLE,
  [ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR]: SUMMARY_STATUSES.SKIPPED,
  [ENRICHMENT_STATUS.SKIPPED_DISABLED]: SUMMARY_STATUSES.SKIPPED,
  // Queue lifecycle, not a provider outcome: we stopped processing. Never
  // COMPLETED, which would read as "nothing found".
  DEAD_LETTER: SUMMARY_STATUSES.UNAVAILABLE,
});

const VULNERABILITY_STATUS_TO_SUMMARY = Object.freeze({
  PENDING: SUMMARY_STATUSES.PENDING,
  COMPLETED: SUMMARY_STATUSES.COMPLETED,
  DEAD_LETTER: SUMMARY_STATUSES.UNAVAILABLE,
});

/**
 * Maps a ProviderLookupJob state onto the summary vocabulary.
 *
 * @param {string} state
 * @returns {string} a SUMMARY_STATUSES value
 */
function statusForJobState(state) {
  if (NON_TERMINAL_JOB_STATES.includes(state)) return SUMMARY_STATUSES.PENDING;
  if (SUCCESSFUL_JOB_STATES.includes(state)) return SUMMARY_STATUSES.COMPLETED;
  if (SKIPPED_JOB_STATES.includes(state)) return SUMMARY_STATUSES.SKIPPED;
  // FAILED and DEAD_LETTER, plus anything a future state addition forgets to
  // classify. Defaulting to UNAVAILABLE is the only safe direction: it says
  // "we do not know", never "there is nothing".
  return SUMMARY_STATUSES.UNAVAILABLE;
}

/**
 * Resolves ONE (provider, subject) pair into a summary row body.
 *
 * @param {object|null} item the latest FindingEnrichmentRunItem for this pair,
 *   with `lookupJob` and its delegate rows included
 * @param {Date} asOf
 * @returns {{status: string, skipReason: string|null, source: string,
 *   freshUntil: Date|null, isStale: boolean, evidenceAvailable: boolean}}
 */
function resolveSubjectState(item, asOf) {
  if (!item) {
    return {
      status: SUMMARY_STATUSES.NOT_REQUESTED,
      skipReason: null,
      source: SUMMARY_SOURCES.NONE,
      freshUntil: null,
      isStale: false,
      evidenceAvailable: false,
    };
  }

  if (item.decision !== RUN_ITEM_DECISIONS.ELIGIBLE) {
    return {
      status: SUMMARY_STATUSES.SKIPPED,
      // Filtered through the closed vocabulary, so a value written by some
      // future path that ignored the enum cannot become a free-text leak.
      skipReason: isKnownSkipReason(item.skipReason) ? item.skipReason : null,
      source: SUMMARY_SOURCES.NONE,
      freshUntil: null,
      isStale: false,
      evidenceAvailable: false,
    };
  }

  const job = item.lookupJob;
  if (!job) {
    // A CHECK constraint makes an ELIGIBLE item without a job impossible, so
    // this means the item was loaded without its job. PENDING is the only
    // honest answer — never COMPLETED, which would invent an outcome.
    return {
      status: SUMMARY_STATUSES.PENDING,
      skipReason: null,
      source: SUMMARY_SOURCES.ORCHESTRATION_JOB,
      freshUntil: null,
      isStale: false,
      evidenceAvailable: false,
    };
  }

  let status;
  let source;
  let freshUntil;

  if (job.iocEnrichment) {
    // The canonical IOC queue owns this work. Its row is the truth; the
    // Phase-10 job merely waits on it.
    source = SUMMARY_SOURCES.IOC_ENRICHMENT;
    status = IOC_STATUS_TO_SUMMARY[job.iocEnrichment.status] || SUMMARY_STATUSES.UNAVAILABLE;
    freshUntil = job.iocEnrichment.expiresAt || null;
  } else if (job.vulnerabilityEnrichmentJob) {
    source = SUMMARY_SOURCES.VULNERABILITY_ENRICHMENT;
    status =
      VULNERABILITY_STATUS_TO_SUMMARY[job.vulnerabilityEnrichmentJob.status] ||
      SUMMARY_STATUSES.UNAVAILABLE;
    // VulnerabilityEnrichmentJob carries no expiry column, so there is no
    // freshness horizon to report. null means unknown, and is never rendered
    // as "fresh forever" — isStale stays false and evidenceAvailable depends
    // only on the status.
    freshUntil = null;
  } else {
    source = SUMMARY_SOURCES.ORCHESTRATION_JOB;
    status = statusForJobState(job.state);
    freshUntil = job.freshUntil || null;
  }

  const isStale = Boolean(freshUntil) && freshUntil.getTime() <= asOf.getTime();

  return {
    status,
    // skipReason belongs to a ROUTING refusal, which is recorded on the item.
    // An ELIGIBLE item has none, and inventing one from a job state would
    // conflate a routing-time refusal with an execution-time one — two
    // structurally different events (see SKIP_REASONS.AUTOMATIC_BUDGET_ZERO).
    skipReason: null,
    source,
    freshUntil,
    isStale,
    // A real answer that is still current. A stale answer is not evidence: it
    // is a record of what was true once.
    evidenceAvailable: status === SUMMARY_STATUSES.COMPLETED && !isStale,
  };
}

/**
 * The enrichment summary for one Finding: one row per known provider.
 *
 * @param {number} findingId
 * @param {{client?: object, asOf: Date}} options `asOf` is the caller's single
 *   explicit evaluation time — this module never reads the wall clock.
 * @returns {Promise<object>} frozen
 * @throws {EnrichmentSummaryNotFoundError} when the Finding does not exist
 */
async function getFindingEnrichmentSummary(findingId, options = {}) {
  const client = resolveClient(options.client);
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new EnrichmentSummaryValidationError("findingId must be a positive integer");
  }
  const asOf = options.asOf;
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new EnrichmentSummaryValidationError("asOf must be an explicit, valid Date");
  }

  const finding = await repository.findFindingIndicator(client, findingId);
  if (!finding) throw new EnrichmentSummaryNotFoundError(findingId);

  // Read ONCE, not per NVD sub-row.
  const cveSubjects = await repository.findVerifiedCveSubjects(client, findingId);

  const providers = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const provider of KNOWN_PROVIDERS) {
    const subjectType = subjectTypeForProvider(provider);
    const base = { provider, purpose: purposeForProvider(provider), asOf };

    if (subjectType === SUBJECT_TYPES.CVE) {
      if (cveSubjects.length === 0) {
        // Considered, no valid subject. No item exists, and none is created.
        providers.push(
          Object.freeze({
            ...base,
            status: SUMMARY_STATUSES.NO_SUBJECT,
            skipReason: SKIP_REASONS.NO_SUBJECT_FOR_PROVIDER,
            source: SUMMARY_SOURCES.NONE,
            freshUntil: null,
            isStale: false,
            evidenceAvailable: false,
            subjects: Object.freeze([]),
          })
        );
        // eslint-disable-next-line no-continue
        continue;
      }

      const subjects = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const subject of cveSubjects) {
        // eslint-disable-next-line no-await-in-loop
        const item = await repository.findLatestRunItemForSubject(client, {
          findingId,
          provider,
          subjectType,
          subjectValue: subject.cveId,
        });
        subjects.push(
          Object.freeze({ subjectValue: subject.cveId, ...resolveSubjectState(item, asOf) })
        );
      }

      providers.push(Object.freeze({ ...base, ...rollUp(subjects), subjects: Object.freeze(subjects) }));
      // eslint-disable-next-line no-continue
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const item = await repository.findLatestRunItemForSubject(client, {
      findingId,
      provider,
      subjectType,
      subjectValue: finding.indicatorValue,
    });
    providers.push(Object.freeze({ ...base, ...resolveSubjectState(item, asOf) }));
  }

  return Object.freeze({
    findingId,
    asOf,
    executionState: resolveExecutionState(process.env),
    providers: Object.freeze(providers),
  });
}

/**
 * Collapses several CVE sub-rows into the provider-level row.
 *
 * Deliberately pessimistic: the provider row claims evidence only when EVERY
 * subject has it, and reports the least-settled status any subject is in. Three
 * verified CVEs where one lookup failed is not "NVD: completed".
 *
 * @param {Array<object>} subjects
 * @returns {object} the provider-level status fields
 */
function rollUp(subjects) {
  const statuses = subjects.map((subject) => subject.status);
  // Least settled first: an outstanding or failed subject outranks a finished
  // one, because it is the fact an analyst needs to act on.
  const precedence = [
    SUMMARY_STATUSES.PENDING,
    SUMMARY_STATUSES.UNAVAILABLE,
    SUMMARY_STATUSES.SKIPPED,
    SUMMARY_STATUSES.NOT_REQUESTED,
    SUMMARY_STATUSES.COMPLETED,
  ];
  const status = precedence.find((candidate) => statuses.includes(candidate)) || statuses[0];

  const freshUntils = subjects
    .map((subject) => subject.freshUntil)
    .filter(Boolean)
    .map((value) => value.getTime());

  return {
    status,
    skipReason: null,
    // A roll-up is not itself a stored record, so it names no single source.
    source: subjects.every((subject) => subject.source === subjects[0].source)
      ? subjects[0].source
      : SUMMARY_SOURCES.NONE,
    // The EARLIEST horizon: the provider's answer stops being wholly current
    // as soon as its first subject does.
    freshUntil: freshUntils.length > 0 ? new Date(Math.min(...freshUntils)) : null,
    isStale: subjects.some((subject) => subject.isStale),
    evidenceAvailable: subjects.every((subject) => subject.evidenceAvailable),
  };
}

module.exports = {
  EnrichmentSummaryNotFoundError,
  EnrichmentSummaryValidationError,
  IOC_STATUS_TO_SUMMARY,
  VULNERABILITY_STATUS_TO_SUMMARY,
  statusForJobState,
  resolveSubjectState,
  rollUp,
  getFindingEnrichmentSummary,
};
