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
  SUMMARY_STATUS_PRECEDENCE,
  SUMMARY_SOURCES,
  SKIP_REASONS,
  RUN_ITEM_DECISIONS,
  NON_TERMINAL_JOB_STATES,
  SKIPPED_JOB_STATES,
  JOB_STATES,
  EXECUTION_SKIP_REASONS,
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
const { ENRICHMENT_STATUS, PROVIDER_ERROR_CODES } = require("../enrichment/iocEnrichmentTypes");
const { ENRICHMENT_TERMINAL_REASON } = require("../enrichment/iocEnrichmentCacheRules");

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
// its own status, NO_RECORD, on purpose: "the provider has no record of this
// indicator" is a real answer distinct from SUCCESS (which is real evidence,
// including a SUCCESS carrying a zero score — see iocEnrichmentCacheRules.js),
// and calling either UNAVAILABLE would turn a known absence into an unknown —
// the exact confusion the IOC read service already guards against. DEAD_LETTER
// is resolved separately, below, because it needs terminalReasonCode to tell an
// ordinary exhausted-retry failure apart from a charged, manual-review
// ambiguity.
const IOC_STATUS_TO_SUMMARY = Object.freeze({
  [ENRICHMENT_STATUS.PENDING]: SUMMARY_STATUSES.PENDING,
  [ENRICHMENT_STATUS.SUCCESS]: SUMMARY_STATUSES.COMPLETED,
  [ENRICHMENT_STATUS.NOT_FOUND]: SUMMARY_STATUSES.NO_RECORD,
  [ENRICHMENT_STATUS.RATE_LIMITED]: SUMMARY_STATUSES.RATE_LIMITED,
  [ENRICHMENT_STATUS.INVALID_KEY]: SUMMARY_STATUSES.UNAVAILABLE,
  [ENRICHMENT_STATUS.TIMEOUT]: SUMMARY_STATUSES.UNAVAILABLE,
  [ENRICHMENT_STATUS.FAILED]: SUMMARY_STATUSES.UNAVAILABLE,
  [ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR]: SUMMARY_STATUSES.SKIPPED,
  [ENRICHMENT_STATUS.SKIPPED_DISABLED]: SUMMARY_STATUSES.SKIPPED,
});

// The execution-time skipReason for an IOC-derived SKIPPED row (defect 4's two
// IOC-derived skips). Reuses the SAME sibling codes the job-state path uses
// below — one vocabulary of REASONS, observed from two different layers.
const IOC_STATUS_TO_EXECUTION_SKIP_REASON = Object.freeze({
  [ENRICHMENT_STATUS.UNSUPPORTED_INDICATOR]: EXECUTION_SKIP_REASONS.EXECUTION_UNSUPPORTED_SUBJECT,
  [ENRICHMENT_STATUS.SKIPPED_DISABLED]: EXECUTION_SKIP_REASONS.EXECUTION_DISABLED,
});

/**
 * Resolves a terminal IocEnrichment delegate row onto the summary vocabulary.
 * DEAD_LETTER is handled outside the static map above because "ambiguous,
 * possibly charged, manual review" and "an ordinary exhausted-retry failure"
 * are different facts an analyst must act on differently (invariant 5), and
 * telling them apart needs the row's own closed `terminalReasonCode` — never
 * an unfiltered string, so an unrecognized reason still fails toward the
 * generic, truthful UNAVAILABLE rather than inventing AMBIGUOUS.
 *
 * @param {{status: string, terminalReasonCode: string|null}} delegate
 * @returns {string} a SUMMARY_STATUSES value
 */
function summaryForIocDelegate(delegate) {
  if (delegate.status === "DEAD_LETTER") {
    return delegate.terminalReasonCode === ENRICHMENT_TERMINAL_REASON.AMBIGUOUS_AFTER_CONTACT
      ? SUMMARY_STATUSES.AMBIGUOUS
      : SUMMARY_STATUSES.UNAVAILABLE;
  }
  return IOC_STATUS_TO_SUMMARY[delegate.status] || SUMMARY_STATUSES.UNAVAILABLE;
}

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
  // SUCCEEDED and NO_RECORD are both real, terminal answers — split apart
  // exactly as the IOC path splits SUCCESS from NOT_FOUND (defect 1).
  if (state === JOB_STATES.SUCCEEDED) return SUMMARY_STATUSES.COMPLETED;
  if (state === JOB_STATES.NO_RECORD) return SUMMARY_STATUSES.NO_RECORD;
  if (SKIPPED_JOB_STATES.includes(state)) return SUMMARY_STATUSES.SKIPPED;
  // FAILED and DEAD_LETTER, plus anything a future state addition forgets to
  // classify. Defaulting to UNAVAILABLE is the only safe direction: it says
  // "we do not know", never "there is nothing". The caller refines this
  // further into RATE_LIMITED/AMBIGUOUS from the job's own closed diagnostics.
  return SUMMARY_STATUSES.UNAVAILABLE;
}

/**
 * Recovers RATE_LIMITED / AMBIGUOUS out of a job's generic UNAVAILABLE,
 * exclusively from recognized closed diagnostics (invariants 5 and 7). Never
 * reads terminalReasonCode/errorCode as free text — an unrecognized value
 * fails safely toward the generic UNAVAILABLE it already had.
 *
 * @param {{terminalReasonCode: string|null, errorCode: string|null}} job
 * @returns {string} a SUMMARY_STATUSES value
 */
function refineUnavailableJobStatus(job) {
  if (job.terminalReasonCode === ENRICHMENT_TERMINAL_REASON.AMBIGUOUS_AFTER_CONTACT) {
    return SUMMARY_STATUSES.AMBIGUOUS;
  }
  if (job.errorCode === PROVIDER_ERROR_CODES.PROVIDER_RATE_LIMITED) {
    return SUMMARY_STATUSES.RATE_LIMITED;
  }
  return SUMMARY_STATUSES.UNAVAILABLE;
}

// Execution-time skipReason for an ELIGIBLE item whose JOB (not its routing
// decision) reached one of the four execution-time SKIPPED_* states (defect 4).
const JOB_STATE_TO_EXECUTION_SKIP_REASON = Object.freeze({
  [JOB_STATES.SKIPPED_DISABLED]: EXECUTION_SKIP_REASONS.EXECUTION_DISABLED,
  [JOB_STATES.SKIPPED_NOT_CONFIGURED]: EXECUTION_SKIP_REASONS.EXECUTION_NOT_CONFIGURED,
  [JOB_STATES.SKIPPED_UNSUPPORTED_SUBJECT]: EXECUTION_SKIP_REASONS.EXECUTION_UNSUPPORTED_SUBJECT,
  [JOB_STATES.SKIPPED_BUDGET]: EXECUTION_SKIP_REASONS.EXECUTION_BUDGET_EXHAUSTED,
});

// ===========================================================================
// `evidence` — WHAT the provider actually said, from rows already stored
// ===========================================================================
// The summary answered "did we ask, and did an answer arrive" but never "what
// was the answer", which left an analyst at "Lookup completed" with nowhere to
// go. This adds the already-persisted, analyst-facing columns of the SAME row
// the status was derived from. It reads nothing new: the four direct evidence
// relations arrive pre-narrowed by an explicit Prisma `select` in the
// repository, and the IOC delegate is narrowed here by the same explicit pick.
//
// The rules it does not break:
//   - a field that is null in storage stays null; nothing is defaulted to 0,
//     "Unknown" or "N/A", and the renderer drops absent fields rather than
//     printing a placeholder
//   - no transport or diagnostic column (httpStatus, errorCode, errorMessage,
//     cacheKey, claimToken) is ever picked, so a provider body or an exception
//     string has no path to a client
//   - a NO_RECORD row still carries whatever its provider row stored; "the
//     provider has no record" is itself the answer and is never dressed up as
//     evidence by the status mapping above
//   - the vulnerability path now carries the batch's own immutable per-source
//     results (UX Ticket C), each with its OWN VulnerabilityProviderStatus, so
//     NVD / CISA KEV / FIRST EPSS stay three separately-attributed answers and
//     the batch's COMPLETED state is never read as "all three succeeded". The
//     row-level `evidenceAvailable` flag is deliberately UNCHANGED and still
//     false for this source (gate P1-1): this adds readable content, not a new
//     claim that a current positive answer exists

// AbuseIPDB's delegate row is included whole (its status and expiry drive the
// status mapping), so its analyst-facing columns are picked explicitly here.
function pickIocEvidence(row) {
  if (!row) return null;
  return {
    queriedAt: row.queriedAt || null,
    abuseConfidenceScore: row.abuseConfidenceScore,
    totalReports: row.totalReports,
    countryCode: row.countryCode,
    isp: row.isp,
    domain: row.domain,
    usageType: row.usageType,
    isWhitelisted: row.isWhitelisted,
    lastReportedAt: row.lastReportedAt,
  };
}

// The columns of ONE VulnerabilityProviderResult that are analyst-facing
// evidence. Named explicitly, exactly like the repository's `select`, so a
// future column is opt-in rather than leaked by default: id/jobId and the
// httpStatus/errorCode/retryAfterSeconds transport trio are never picked.
//
// Only SUCCESS may carry normalized data (the schema's own rule), so a
// non-SUCCESS entry truthfully arrives with nulls beside its own status rather
// than being dropped — "FIRST EPSS timed out" is an answer an analyst needs,
// and omitting the row would make it indistinguishable from "never asked".
function pickVulnerabilityResult(result) {
  return {
    provider: result.provider,
    status: result.status,
    queriedAt: result.queriedAt || null,
    expiresAt: result.expiresAt || null,
    nvdCveStatus: result.nvdCveStatus,
    publishedAt: result.publishedAt,
    lastModifiedAt: result.lastModifiedAt,
    englishDescription: result.englishDescription,
    cvssVersion: result.cvssVersion,
    cvssBaseScoreTenths: result.cvssBaseScoreTenths,
    cvssSeverity: result.cvssSeverity,
    primaryCweIds: result.primaryCweIds,
    sourceIdentifier: result.sourceIdentifier,
    isKnownExploited: result.isKnownExploited,
    dateAdded: result.dateAdded,
    dueDate: result.dueDate,
    knownRansomwareCampaignUse: result.knownRansomwareCampaignUse,
    requiredAction: result.requiredAction,
    catalogVersion: result.catalogVersion,
    catalogReleasedAt: result.catalogReleasedAt,
    epssProbabilityBasisPoints: result.epssProbabilityBasisPoints,
    epssPercentileBasisPoints: result.epssPercentileBasisPoints,
    modelDate: result.modelDate,
  };
}

/**
 * The vulnerability batch's stored per-source evidence, or null when the batch
 * recorded no result at all (still PENDING, or dead-lettered before any
 * provider answered) — null keeps "no result was recorded" distinct from "a
 * result was recorded and it was empty".
 *
 * @param {{providerResults?: Array<object>}} job
 * @returns {{sources: Array<object>}|null}
 */
function pickVulnerabilityEvidence(job) {
  const results = Array.isArray(job.providerResults) ? job.providerResults : [];
  if (results.length === 0) return null;
  return { sources: results.map(pickVulnerabilityResult) };
}

// The one direct evidence row this job links, if any. The CHECK constraint on
// ProviderLookupJob allows at most one, so the first match is the only match.
function directEvidence(job) {
  return (
    job.censysEnrichment ||
    job.greyNoiseEnrichment ||
    job.shodanEnrichment ||
    job.netlasEnrichment ||
    null
  );
}

/**
 * Resolves ONE (provider, subject) pair into a summary row body.
 *
 * @param {object|null} item the latest FindingEnrichmentRunItem for this pair,
 *   with `lookupJob` and its delegate rows included
 * @param {Date} asOf
 * @returns {{status: string, skipReason: string|null, source: string,
 *   freshUntil: Date|null, isStale: boolean, evidenceAvailable: boolean,
 *   evidence: object|null}}
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
      evidence: null,
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
      evidence: null,
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
      evidence: null,
    };
  }

  let status;
  let source;
  let freshUntil;
  let skipReason = null;
  // Always the row the STATUS was read from, so the two can never disagree.
  let evidence = null;

  // A terminal Phase-10 job outranks a non-terminal (PENDING) delegate
  // (invariant 2, closing defect 6): a delegated job can be dead-lettered
  // (e.g. AMBIGUOUS_AFTER_CONTACT) while its own delegate row is deliberately
  // left PENDING by the runner, which still holds the live claim. Reading the
  // delegate unconditionally there would report a terminally dead-lettered,
  // possibly-charged, manual-review job as PENDING forever. The delegate stays
  // authoritative only while the job is non-terminal, or once both are
  // terminal.
  const jobIsTerminal = !NON_TERMINAL_JOB_STATES.includes(job.state);
  const delegateIsNonTerminal =
    job.iocEnrichment && job.iocEnrichment.status === ENRICHMENT_STATUS.PENDING;

  if (job.iocEnrichment && !(jobIsTerminal && delegateIsNonTerminal)) {
    // The canonical IOC queue owns this work. Its row is the truth; the
    // Phase-10 job merely waits on it.
    source = SUMMARY_SOURCES.IOC_ENRICHMENT;
    status = summaryForIocDelegate(job.iocEnrichment);
    evidence = pickIocEvidence(job.iocEnrichment);
    freshUntil = job.iocEnrichment.expiresAt || null;
    if (status === SUMMARY_STATUSES.SKIPPED) {
      skipReason = IOC_STATUS_TO_EXECUTION_SKIP_REASON[job.iocEnrichment.status] || null;
    }
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
    // The batch's own immutable per-source results. Each carries its own
    // status, so the reader can attribute (and disbelieve) NVD, CISA KEV and
    // FIRST EPSS separately instead of inheriting the batch's verdict.
    evidence = pickVulnerabilityEvidence(job.vulnerabilityEnrichmentJob);
  } else {
    // Either a plain direct provider's own job, or a terminal Phase-10 job
    // that just outranked its still-PENDING delegate above — either way the
    // job's own state (and its own closed diagnostics) is the truth here.
    source = SUMMARY_SOURCES.ORCHESTRATION_JOB;
    status = statusForJobState(job.state);
    if (status === SUMMARY_STATUSES.UNAVAILABLE) {
      status = refineUnavailableJobStatus(job);
    } else if (status === SUMMARY_STATUSES.SKIPPED) {
      skipReason = JOB_STATE_TO_EXECUTION_SKIP_REASON[job.state] || null;
    }
    freshUntil = job.freshUntil || null;
    evidence = directEvidence(job);
  }

  const isStale = Boolean(freshUntil) && freshUntil.getTime() <= asOf.getTime();

  return {
    status,
    // A routing refusal (item.decision !== ELIGIBLE, handled above) records
    // its own skipReason on the item. This is an ELIGIBLE item, so any
    // skipReason here is EXECUTION-time — resolved above from the job's or
    // delegate's own state, never invented from an unfiltered string (see
    // SKIP_REASONS.AUTOMATIC_BUDGET_ZERO for why routing and execution stay
    // structurally separate).
    skipReason,
    source,
    freshUntil,
    isStale,
    // A real, positive answer that is still current. NO_RECORD, a stale
    // answer, and every VULNERABILITY_ENRICHMENT row are never evidence: a
    // vulnerability orchestration JOB reaching COMPLETED proves only that the
    // batch finished, not that every per-source provider answered — the
    // per-source rows `evidence` now carries each keep their OWN status and
    // freshness horizon, and this row-level flag deliberately does not try to
    // roll them up into a single claim (gate P1-1 unchanged).
    evidenceAvailable:
      source !== SUMMARY_SOURCES.VULNERABILITY_ENRICHMENT &&
      status === SUMMARY_STATUSES.COMPLETED &&
      !isStale,
    // Deliberately independent of `evidenceAvailable`: that flag answers "is
    // there a current, positive answer", this field answers "what does the
    // stored row say". A stale COMPLETED row still has readable content, and
    // the renderer keeps labelling it stale.
    evidence,
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
            evidence: null,
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
  // Least settled/most-actionable first (SUMMARY_STATUS_PRECEDENCE, gate
  // invariant 8). The fallback is the array's OWN most-unsettled entry, never
  // `statuses[0]` — an unranked status must never be silently overridden by
  // any ranked one. A test asserts SUMMARY_STATUS_PRECEDENCE covers every
  // SUMMARY_STATUSES value, so this fallback is unreachable for a valid
  // status and exists only to fail safely if that ever stops being true.
  const status =
    SUMMARY_STATUS_PRECEDENCE.find((candidate) => statuses.includes(candidate)) ||
    SUMMARY_STATUS_PRECEDENCE[0];

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
  refineUnavailableJobStatus,
  summaryForIocDelegate,
  pickVulnerabilityEvidence,
  resolveSubjectState,
  rollUp,
  getFindingEnrichmentSummary,
};
