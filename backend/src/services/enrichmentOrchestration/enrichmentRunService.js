"use strict";

// Phase 10A-1 — the orchestration write path. Turns one ASK about one Finding
// into durable, truthful records of what should happen, and stops there.
//
// ===========================================================================
// THIS MODULE EXECUTES NOTHING
// ===========================================================================
// It never constructs a provider, never calls one, never reserves quota, never
// writes a ProviderLookupAttempt or a ProviderDailyUsage row, and never starts
// a worker. An ELIGIBLE item's job is created in a non-terminal state and left
// there: with no worker in this milestone, nothing claims it, so no third
// party is contacted. A static inertness test asserts that no module in this
// package imports a provider factory, a runner or a fetch implementation.
//
// ---------------------------------------------------------------------------
// Two deduplication mechanisms that must never be conflated
// ---------------------------------------------------------------------------
//   idempotencyKey  (UNIQUE on FindingEnrichmentRun)  deduplicates the ASK
//   activeLookupKey (UNIQUE on ProviderLookupJob)     deduplicates the WORK
//
// Consequences that are all simultaneously true, and each has a test:
//   * two concurrent identical requests collapse into ONE run;
//   * an AbuseIPDB-scoped run does NOT suppress a later Censys-scoped run —
//     different scope, different requestScopeHash, different run;
//   * two Findings on one IP produce two runs and two items but ONE job.
//
// ---------------------------------------------------------------------------
// P2002 is caught OUTSIDE any transaction
// ---------------------------------------------------------------------------
// Mirrors enrichmentQueueService.js exactly. A unique violation caught inside
// an open transaction leaves it aborted (25P02) on PostgreSQL, so this module
// issues plain statements and re-runs the read-decide-write cycle a bounded
// number of times, converging by re-reading committed state rather than by
// waiting.

const {
  RUN_ITEM_DECISIONS,
  RUN_STATES,
  RUN_TRIGGERS,
  JOB_TRIGGERS,
  JOB_STATES,
  QUOTA_LANES,
  NON_TERMINAL_JOB_STATES,
  SUCCESSFUL_JOB_STATES,
} = require("./enrichmentDecisionCodes");
const {
  SUBJECT_TYPES,
  KNOWN_PROVIDERS,
  isKnownProvider,
  subjectTypeForProvider,
} = require("./enrichmentSubject");
const {
  EnrichmentIdentityError,
  computeQueryIdentityHash,
  computeRequestScopeHash,
  buildIdempotencyKey,
  manualTimeBucket,
} = require("./enrichmentIdentity");
const { routeTarget } = require("./enrichmentApplicabilityRouter");
const {
  resolveOrchestrationConfig,
  isProviderCredentialConfigured,
} = require("./enrichmentOrchestrationConfig");
const repository = require("./enrichmentOrchestrationRepository");
const { buildEnrichmentCacheIdentity } = require("../enrichment/enrichmentCacheKey");
const { INDICATOR_TYPES } = require("../enrichment/iocEnrichmentTypes");
const { AUDIT_OUTCOMES, safeLogAuditEvent } = require("../auditService");

// Loaded lazily, the same way resolveClient defers config/prisma. env.js
// validates the whole application configuration at require time and throws
// when DATABASE_URL/JWT_SECRET/CORS_ORIGIN are absent — importing it at module
// scope would make every pure unit test of this file depend on a fully
// configured environment, which is exactly the coupling tests/setup.js's
// TNX_SKIP_DOTENV note warns about.
function appEnv() {
  // eslint-disable-next-line global-require
  return require("../../config/env");
}

// Bounded, like every other retry loop in this repository. Each attempt
// re-reads committed state, so convergence does not depend on a delay.
const MAX_CREATE_ATTEMPTS = 5;

const AUDIT_ENTITY_TYPE = "Finding";

const AUDIT_ACTIONS = Object.freeze({
  RUN_CREATED: "enrichment.orchestration.run.created",
  RUN_DEDUPLICATED: "enrichment.orchestration.run.deduplicated",
  RUN_FAILED: "enrichment.orchestration.run.failed",
});

// The two providers whose work an EXISTING queue already owns. A Phase-10 job
// for one of these is RUN_DELEGATED and links the delegate row; it never takes
// execution over, and the delegate's own state machine is untouched.
const DELEGATED_PROVIDERS = Object.freeze(["abuseipdb", "nvd"]);

class EnrichmentRunValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentRunValidationError";
  }
}

class EnrichmentRunNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentRunNotFoundError";
  }
}

function resolveClient(client) {
  if (client) return client;
  // eslint-disable-next-line global-require
  return require("../../config/prisma");
}

function assertValidFindingId(findingId) {
  if (!Number.isInteger(findingId) || findingId <= 0) {
    throw new EnrichmentRunValidationError("findingId must be a positive integer");
  }
  return findingId;
}

function assertValidNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new EnrichmentRunValidationError("now must be an explicit, valid Date");
  }
  return now;
}

/**
 * Normalizes an optional caller-supplied provider scope.
 *
 * An unknown provider is a 400, never a silent drop: a caller who asked for
 * "censsy" should be told, not handed a run that quietly did nothing.
 *
 * @param {unknown} providers
 * @returns {Array<string>} the requested providers, or all known providers
 */
function normalizeProviderScope(providers) {
  if (providers === undefined || providers === null) return [...KNOWN_PROVIDERS];
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new EnrichmentRunValidationError("providers must be a non-empty array when supplied");
  }
  const normalized = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const provider of providers) {
    if (!isKnownProvider(provider)) {
      throw new EnrichmentRunValidationError("providers must contain only known provider identifiers");
    }
    if (!normalized.includes(provider)) normalized.push(provider);
  }
  return normalized;
}

/**
 * Assembles the (provider, subject) targets for one Finding.
 *
 * IPv4 providers each get the Finding's own indicator. NVD gets ONE TARGET PER
 * verified CVE — three verified CVEs are three separate NVD subjects, never
 * one collapsed subject, because they are three different questions with three
 * different answers.
 *
 * A provider in scope with no subject available produces a target-less entry
 * carrying NO_SUBJECT_FOR_PROVIDER, so the run still records honestly that the
 * provider was considered and why nothing was asked.
 *
 * @returns {Promise<{targets: Array, missingSubjectProviders: Array<string>}>}
 */
async function assembleTargets(client, findingId, providerScope) {
  const finding = await repository.findFindingIndicator(client, findingId);
  if (!finding) {
    throw new EnrichmentRunNotFoundError(`Finding ${findingId} was not found`);
  }

  const needsCve = providerScope.some(
    (provider) => subjectTypeForProvider(provider) === SUBJECT_TYPES.CVE
  );
  // Only queried when a CVE provider is actually in scope — an IPv4-only ask
  // must not pay for a vulnerability join it will not use.
  const cveSubjects = needsCve ? await repository.findVerifiedCveSubjects(client, findingId) : [];

  const targets = [];
  const missingSubjectProviders = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const provider of providerScope) {
    const subjectType = subjectTypeForProvider(provider);

    if (subjectType === SUBJECT_TYPES.IPV4) {
      targets.push({ provider, subjectType, subjectValue: finding.indicatorValue });
      // eslint-disable-next-line no-continue
      continue;
    }

    if (subjectType === SUBJECT_TYPES.CVE) {
      if (cveSubjects.length === 0) {
        missingSubjectProviders.push(provider);
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-restricted-syntax
      for (const subject of cveSubjects) {
        targets.push({ provider, subjectType, subjectValue: subject.cveId });
      }
    }
  }

  return { finding, targets, missingSubjectProviders };
}

/**
 * Recomputes a run's state from its items. Never assigned directly anywhere.
 *
 * An item carries no status of its own: a policy skip's status IS its terminal
 * decision, and an ELIGIBLE item's status IS its job's state. Deriving the run
 * state from those two facts is what keeps one copy of the truth.
 *
 * @param {Array<{decision: string, lookupJob: object|null}>} items
 * @returns {string} EnrichmentRunState value
 */
function recomputeRunState(items) {
  if (!Array.isArray(items) || items.length === 0) return RUN_STATES.SKIPPED;

  const eligible = items.filter((item) => item.decision === RUN_ITEM_DECISIONS.ELIGIBLE);
  // Every item was a POLICY skip: nothing was ever asked of any provider.
  if (eligible.length === 0) return RUN_STATES.SKIPPED;

  const jobs = eligible.map((item) => item.lookupJob).filter(Boolean);
  // Defensive: a CHECK constraint makes an ELIGIBLE item without a job
  // impossible, so reaching this means the items were loaded without their
  // jobs included. Reporting PENDING is the only honest answer — never
  // SUCCEEDED, which would invent an outcome.
  if (jobs.length !== eligible.length) return RUN_STATES.PENDING;

  const nonTerminal = jobs.filter((job) => NON_TERMINAL_JOB_STATES.includes(job.state));
  if (nonTerminal.length > 0) {
    // LEASED means a worker holds it right now. In Phase 10A-1 no worker
    // exists, so this branch is unreachable in practice and is here so the
    // state machine is complete before 10A-2 turns one on.
    return nonTerminal.some((job) => job.state === JOB_STATES.LEASED)
      ? RUN_STATES.RUNNING
      : RUN_STATES.PENDING;
  }

  const successful = jobs.filter((job) => SUCCESSFUL_JOB_STATES.includes(job.state));
  if (successful.length === jobs.length) return RUN_STATES.SUCCEEDED;
  if (successful.length === 0) return RUN_STATES.FAILED;
  return RUN_STATES.PARTIAL;
}

const TERMINAL_RUN_STATES = Object.freeze([
  RUN_STATES.SUCCEEDED,
  RUN_STATES.PARTIAL,
  RUN_STATES.FAILED,
  RUN_STATES.SKIPPED,
]);

/**
 * Re-derives and persists a run's state. Safe to call repeatedly.
 */
async function refreshRunState(client, runId, now) {
  const items = await repository.listRunItemsWithJobs(client, runId);
  const state = recomputeRunState(items);
  const completedAt = TERMINAL_RUN_STATES.includes(state) ? now : null;
  const run = await repository.updateRunState(client, runId, { state, completedAt });
  return { run, items, state };
}

/**
 * The AbuseIPDB delegate's cache identity — computed with the SAME inputs
 * ingestion and manual scheduling already use, so a Phase-10 job finds the row
 * they created instead of fragmenting into a second identity.
 */
function abuseIpdbActiveCacheKey(subjectValue) {
  return buildEnrichmentCacheIdentity({
    provider: "abuseipdb",
    indicatorType: INDICATOR_TYPES.IPV4,
    indicator: subjectValue,
    queryParams: { maxAgeInDays: appEnv().ABUSEIPDB_MAX_AGE_DAYS },
  }).cacheKey;
}

/**
 * Finds the existing delegate row for a delegated provider, if one exists.
 *
 * READ ONLY. Phase 10A-1 never creates, claims or mutates a delegate — it
 * links what ingestion or the ADMIN batch already created, so the delegate's
 * behaviour is provably unchanged.
 *
 * @returns {Promise<{field: string, id: number}|null>} the typed FK to set
 */
async function findDelegateLink(client, provider, subjectValue) {
  if (provider === "abuseipdb") {
    const row = await repository.findActiveIocEnrichment(
      client,
      abuseIpdbActiveCacheKey(subjectValue)
    );
    return row ? { field: "iocEnrichmentId", id: row.id } : null;
  }
  if (provider === "nvd") {
    const row = await repository.findActiveVulnerabilityJobForCve(client, subjectValue);
    return row ? { field: "vulnerabilityEnrichmentJobId", id: row.id } : null;
  }
  return null;
}

/**
 * Gets the one active job for a work identity, or creates it.
 *
 * The get-or-create races against every other run doing the same thing. The
 * loser of that race sees P2002 on activeLookupKey and re-reads — which is
 * precisely the behaviour that makes two Findings on one IP share one job.
 */
async function getOrCreateLookupJob(client, { provider, subjectType, subjectValue, lane, now }) {
  const queryIdentityHash = computeQueryIdentityHash({ provider, subjectType, subjectValue });

  const existing = await repository.findActiveJobByLookupKey(client, queryIdentityHash);
  if (existing) return { job: existing, created: false };

  const delegated = DELEGATED_PROVIDERS.includes(provider);
  const delegateLink = delegated ? await findDelegateLink(client, provider, subjectValue) : null;

  const data = {
    provider,
    subjectType,
    subjectValue,
    queryIdentityHash,
    // A delegated job whose delegate already exists is genuinely waiting on
    // that queue. Everything else is PENDING and — with no worker in this
    // milestone — stays PENDING. Neither state contacts a provider.
    state: delegateLink ? JOB_STATES.WAITING_ON_DELEGATE : JOB_STATES.PENDING,
    lane,
    trigger: delegated ? JOB_TRIGGERS.RUN_DELEGATED : JOB_TRIGGERS.RUN_DIRECT,
    requestedAt: now,
    // Non-terminal, so it holds the identity and blocks a duplicate.
    activeLookupKey: queryIdentityHash,
  };
  if (delegateLink) data[delegateLink.field] = delegateLink.id;

  try {
    return { job: await repository.createLookupJob(client, data), created: true };
  } catch (error) {
    if (!repository.isUniqueViolation(error)) throw error;
    // Lost the race — the winner's job is the shared one.
    const winner = await repository.findActiveJobByLookupKey(client, queryIdentityHash);
    if (!winner) throw error;
    return { job: winner, created: false };
  }
}

/**
 * Builds every run item for a run, creating shared jobs for ELIGIBLE ones.
 *
 * Runs AFTER the run row is committed and outside any transaction, for the
 * P2002 reason in the module header. Item creation is itself idempotent
 * against the (runId, provider, subjectType, subjectValue) unique, so a retry
 * after a partial write converges instead of duplicating.
 */
async function materializeItems(client, run, routedTargets, now) {
  const items = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const routed of routedTargets) {
    let lookupJobId = null;
    if (routed.decision === RUN_ITEM_DECISIONS.ELIGIBLE) {
      // eslint-disable-next-line no-await-in-loop
      const { job } = await getOrCreateLookupJob(client, {
        provider: routed.provider,
        subjectType: routed.subjectType,
        subjectValue: routed.subjectValue,
        lane: routed.lane,
        now,
      });
      lookupJobId = job.id;
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const item = await repository.createRunItem(client, {
        runId: run.id,
        findingId: run.findingId,
        provider: routed.provider,
        subjectType: routed.subjectType,
        subjectValue: routed.subjectValue,
        decision: routed.decision,
        skipReason: routed.skipReason,
        lookupJobId,
      });
      items.push(item);
    } catch (error) {
      // Already written by a concurrent retry of this same run — converge.
      if (!repository.isUniqueViolation(error)) throw error;
    }
  }
  return items;
}

async function audit(client, auditContext, event) {
  try {
    await safeLogAuditEvent({ ...auditContext, ...event }, { client });
  } catch (error) {
    console.error("Enrichment orchestration audit failed", { name: error && error.name });
  }
}

/**
 * Bounded, allow-listed audit payload. Carries COUNTS and closed codes only —
 * never a subject value, a hash, an idempotency key or an internal job id.
 */
function runAuditSummary(run, items) {
  const decisionCounts = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const item of items) {
    decisionCounts[item.decision] = (decisionCounts[item.decision] || 0) + 1;
  }
  return {
    runId: run.id,
    findingId: run.findingId,
    trigger: run.trigger,
    state: run.state,
    force: run.force,
    itemCount: items.length,
    decisionCounts,
  };
}

/**
 * Creates (or returns the existing) enrichment run for one Finding.
 *
 * @param {number} findingId
 * @param {{client?: object, trigger: string, providers?: Array<string>,
 *   force?: boolean, rawReportId?: number|null, actorUserId?: number|null,
 *   idempotencyKeyHash?: string|null, now: Date, auditContext?: object}} options
 * @returns {Promise<{run: object, items: Array, created: boolean}>}
 */
async function createEnrichmentRun(findingId, options = {}) {
  const client = resolveClient(options.client);
  const auditContext = options.auditContext || {};
  const id = assertValidFindingId(findingId);
  const now = assertValidNow(options.now);
  const trigger = options.trigger;
  const force = options.force === true;

  if (trigger !== RUN_TRIGGERS.INGESTION && trigger !== RUN_TRIGGERS.MANUAL) {
    throw new EnrichmentRunValidationError("trigger must be INGESTION or MANUAL");
  }
  // The lane is fixed from the trigger and never changed afterwards, so a
  // manual ask can never be charged against the automatic budget or vice
  // versa.
  const lane = trigger === RUN_TRIGGERS.INGESTION ? QUOTA_LANES.AUTOMATIC : QUOTA_LANES.MANUAL;

  const providerScope = normalizeProviderScope(options.providers);
  const config = resolveOrchestrationConfig(process.env);
  const budgets =
    lane === QUOTA_LANES.AUTOMATIC ? config.automaticDailyBudgets : config.manualDailyBudgets;

  const { targets, missingSubjectProviders } = await assembleTargets(client, id, providerScope);

  const requestScopeHash = computeRequestScopeHash({ findingId: id, trigger, force, targets });
  const idempotencyKey = buildIdempotencyKey({
    trigger,
    requestScopeHash,
    rawReportId: options.rawReportId,
    idempotencyKeyHash: options.idempotencyKeyHash,
    bucketedAt: options.idempotencyKeyHash ? null : manualTimeBucket(now),
  });

  // Route every target. Freshness is read per target — bounded by the provider
  // scope (at most five IPv4 providers plus one per verified CVE), never by
  // the size of any table.
  // ponytail: one freshness read per target; batch into a single IN query if a
  // Finding ever carries enough verified CVEs for this to matter.
  const routedTargets = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await repository.findFreshJobForSubject(client, {
      provider: target.provider,
      subjectType: target.subjectType,
      subjectValue: target.subjectValue,
      asOf: now,
    });
    routedTargets.push({
      ...target,
      lane,
      ...routeTarget({
        provider: target.provider,
        subjectType: target.subjectType,
        subjectValue: target.subjectValue,
        lane,
        credentialConfigured: isProviderCredentialConfigured(target.provider, appEnv()),
        laneDailyBudget: budgets[target.provider],
        hasFreshResult: Boolean(fresh),
        force,
      }),
    });
  }

  // A provider that was asked for but has no subject on this Finding is
  // recorded honestly rather than silently omitted. It uses the Finding's own
  // indicator as the item's subject only when the provider's subject type is
  // IPv4; for a CVE provider with no verified CVE there is genuinely no
  // subject, so no item can be written (subjectValue is NOT NULL). The
  // provider is reported through the run summary's `consideredProviders`
  // instead — see enrichmentRunReadService.js.
  const unsubjectedProviders = [...missingSubjectProviders];

  // --- Create the run, converging on the idempotency unique ----------------
  let run = null;
  let created = false;
  // eslint-disable-next-line no-restricted-syntax
  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await repository.findRunByIdempotencyKey(client, idempotencyKey);
    if (existing) {
      run = existing;
      break;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      run = await repository.createRun(client, {
        findingId: id,
        trigger,
        state: RUN_STATES.PENDING,
        requestedAt: now,
        force,
        requestScopeHash,
        idempotencyKey,
        rawReportId: options.rawReportId ?? null,
        actorUserId: trigger === RUN_TRIGGERS.MANUAL ? options.actorUserId ?? null : null,
      });
      created = true;
      break;
    } catch (error) {
      if (!repository.isUniqueViolation(error)) {
        await audit(client, auditContext, {
          action: AUDIT_ACTIONS.RUN_FAILED,
          outcome: AUDIT_OUTCOMES.FAILURE,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: id,
          after: { findingId: id, trigger },
          reason: "Enrichment orchestration run could not be created",
        });
        throw error;
      }
      // Lost the race — the next iteration re-reads and finds the winner.
    }
  }

  if (!run) {
    throw new EnrichmentRunValidationError(
      "Enrichment run could not be created after bounded retries"
    );
  }

  // Items are (re)materialized when the run has none. That covers both the
  // fresh-create path and the rare crash-between-run-and-items case, without
  // ever duplicating items for a run that already has them.
  let items = await repository.listRunItemsWithJobs(client, run.id);
  if (items.length === 0) {
    await materializeItems(client, run, routedTargets, now);
    items = await repository.listRunItemsWithJobs(client, run.id);
  }

  const refreshed = await refreshRunState(client, run.id, now);
  run = refreshed.run;
  items = refreshed.items;

  await audit(client, auditContext, {
    action: created ? AUDIT_ACTIONS.RUN_CREATED : AUDIT_ACTIONS.RUN_DEDUPLICATED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: id,
    after: runAuditSummary(run, items),
    reason: created
      ? "Enrichment orchestration run created (no provider was contacted)"
      : "Enrichment orchestration run deduplicated onto an existing run",
  });

  return { run, items, created, unsubjectedProviders };
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPE,
  MAX_CREATE_ATTEMPTS,
  DELEGATED_PROVIDERS,
  TERMINAL_RUN_STATES,
  EnrichmentRunValidationError,
  EnrichmentRunNotFoundError,
  EnrichmentIdentityError,
  normalizeProviderScope,
  assembleTargets,
  recomputeRunState,
  refreshRunState,
  getOrCreateLookupJob,
  createEnrichmentRun,
};
