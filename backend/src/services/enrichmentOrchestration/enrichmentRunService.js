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
// The two DELEGATED providers (abuseipdb, nvd) are scheduled through the
// canonical queue services that already own their execution. Those services are
// database-only by construction — they create or find a PENDING row and return
// it — so scheduling a delegate contacts nobody either. Execution stays exactly
// where it already was: the IOC batch runner and the ADMIN vulnerability batch,
// neither of which this milestone changes.
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
  RUN_REQUEST_OUTCOMES,
  JOB_TRIGGERS,
  JOB_STATES,
  QUOTA_LANES,
  SKIP_REASONS,
  NON_TERMINAL_JOB_STATES,
  SUCCESSFUL_JOB_STATES,
} = require("./enrichmentDecisionCodes");
const {
  SUBJECT_TYPES,
  KNOWN_PROVIDERS,
  isKnownProvider,
  subjectTypeForProvider,
  serializeProviderList: serializeNoSubjectProviders,
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
const { INDICATOR_TYPES } = require("../enrichment/iocEnrichmentTypes");
// The CANONICAL scheduling services for the two delegated providers. Phase 10
// never duplicates their queue logic and never bypasses them: it asks them for
// a delegate exactly the way the analyst-facing and ingestion paths already do,
// and links whatever row they return. Neither module performs I/O beyond the
// database, which is why importing them keeps this package inert.
const {
  SCHEDULE_OUTCOME,
  scheduleEnrichment,
  scheduleEnrichmentForced,
} = require("../enrichment/enrichmentQueueService");
const {
  VULNERABILITY_SCHEDULE_OUTCOME,
  scheduleVulnerabilityEnrichment,
  scheduleVulnerabilityEnrichmentForced,
} = require("../vulnerability/vulnerabilityQueueService");
const { VULNERABILITY_JOB_TRIGGER } = require("../vulnerability/vulnerabilityQueueRules");
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

// The SAME bounds findingEnrichmentScheduleService.js and
// findingOwnershipService.js already enforce for an analyst-written reason.
// Mirrored rather than imported for the reason the module header gives about
// env.js: findingEnrichmentScheduleService requires config/env at module scope,
// and importing it here would make every pure unit test of this file depend on
// a fully configured environment.
const MAX_JUSTIFICATION_LENGTH = 1000;
const JUSTIFICATION_PREVIEW_LENGTH = 200;

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
 * Normalizes the analyst's optional written reason.
 *
 * A supplied justification is NEVER silently discarded: it is trimmed and
 * bounded, and a value that fails the bound is a 400 rather than a request that
 * quietly proceeds with the reason dropped. When `force` is set it is
 * REQUIRED — bypassing freshness spends real third-party quota once a worker
 * exists, and an unexplained bypass is exactly what an audit trail is for.
 *
 * The raw value never reaches a response body and reaches audit only as a
 * bounded preview (see boundedJustificationPreview).
 *
 * @param {unknown} value
 * @param {boolean} force
 * @returns {string|null}
 */
function normalizeJustification(value, force) {
  if (value === undefined || value === null) {
    if (force) {
      throw new EnrichmentRunValidationError(
        `justification is required and must be 1-${MAX_JUSTIFICATION_LENGTH} characters when force=true`
      );
    }
    return null;
  }
  if (typeof value !== "string") {
    throw new EnrichmentRunValidationError("justification must be a string");
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_JUSTIFICATION_LENGTH) {
    throw new EnrichmentRunValidationError(
      `justification must be 1-${MAX_JUSTIFICATION_LENGTH} characters`
    );
  }
  return trimmed;
}

/**
 * The only form of a justification allowed to leave this module. Bounded, and
 * only ever placed in an audit payload — never in an HTTP response.
 *
 * @param {string|null} value
 * @returns {string|null}
 */
function boundedJustificationPreview(value) {
  if (typeof value !== "string" || value === "") return null;
  return value.length > JUSTIFICATION_PREVIEW_LENGTH
    ? `${value.slice(0, JUSTIFICATION_PREVIEW_LENGTH)}…`
    : value;
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
 * Establishes the delegate a RUN_DELEGATED job will link, through the CANONICAL
 * queue service that owns that provider's execution.
 *
 * ===========================================================================
 * Why this schedules rather than merely reads
 * ===========================================================================
 * A ProviderLookupJob with trigger=RUN_DELEGATED and no delegate FK is a job
 * nothing can ever finish: no Phase-10 worker executes it (there is none), and
 * reconciliation has no delegate row to copy a verdict from. It would sit
 * non-terminal forever, holding activeLookupKey and blocking every future ask
 * about that subject. So the delegate is established FIRST, and a job is
 * created only once there is a real row to point at.
 *
 * Nothing here executes anything. Both queue services are database-only by
 * construction (see their module headers) — they create or find a PENDING row
 * and return it. Execution stays with the pipelines that already own it: the
 * IOC batch runner and the ADMIN vulnerability batch, neither of which is
 * changed by this milestone.
 *
 * `force` is passed through to the queue service's own forced variant rather
 * than reinterpreted here, so "force means ignore the cache, never ignore the
 * queue" keeps exactly one definition in the codebase.
 *
 * @returns {Promise<{status: "LINKED", field: string, id: number}
 *   | {status: "FRESH"} | {status: "NONE"}>}
 *   LINKED — a delegate row exists and its typed FK should be set.
 *   FRESH  — the canonical service reports a fresh answer already on file, so
 *            no outbound work is warranted and no job should be created.
 *   NONE   — this provider is not delegated.
 * @throws whatever the canonical service throws; the caller turns that into
 *   SKIPPED_EXECUTION_UNAVAILABLE and creates no job.
 */
async function establishDelegate(client, { provider, subjectValue, force, now }) {
  if (provider === "abuseipdb") {
    // The SAME identity inputs ingestion and manual scheduling already use, so
    // this converges onto the row they created instead of fragmenting into a
    // second cache identity.
    const identity = {
      provider: "abuseipdb",
      indicatorType: INDICATOR_TYPES.IPV4,
      indicator: subjectValue,
      queryParams: { maxAgeInDays: appEnv().ABUSEIPDB_MAX_AGE_DAYS },
    };
    const result = force
      ? await scheduleEnrichmentForced(identity, { client, asOf: now })
      : await scheduleEnrichment(identity, { client, asOf: now });

    // CACHE_HIT is a terminal row, not schedulable work. Linking it would
    // create a job "waiting" on something that already finished.
    if (result.outcome === SCHEDULE_OUTCOME.CACHE_HIT) return { status: "FRESH" };
    if (!result.record) return { status: "FRESH" };
    return { status: "LINKED", field: "iocEnrichmentId", id: result.record.id };
  }

  if (provider === "nvd") {
    // The canonical Vulnerability row already exists — the only way a CVE
    // becomes a subject here is an ACTIVE, ANALYST_VERIFIED FindingVulnerability
    // association, which cannot exist without it. So this path never creates an
    // unattached Vulnerability row.
    const request = { cveId: subjectValue, trigger: VULNERABILITY_JOB_TRIGGER.MANUAL };
    const result = force
      ? await scheduleVulnerabilityEnrichmentForced({ cveId: subjectValue }, { client, asOf: now })
      : await scheduleVulnerabilityEnrichment(request, { client, asOf: now });

    // The vulnerability queue returns record: null on CACHE_HIT, so both
    // conditions are checked rather than one being inferred from the other.
    if (result.outcome === VULNERABILITY_SCHEDULE_OUTCOME.CACHE_HIT) return { status: "FRESH" };
    if (!result.record) return { status: "FRESH" };
    return { status: "LINKED", field: "vulnerabilityEnrichmentJobId", id: result.record.id };
  }

  return { status: "NONE" };
}

/**
 * Resolves ONE routed target the router marked ELIGIBLE into the item that
 * should be written for it.
 *
 * The decision can still change here, and that is deliberate: routing decides
 * whether work is WARRANTED, this decides whether work is POSSIBLE. A delegate
 * that reports a fresh answer downgrades the item to SKIPPED_CACHED; a delegate
 * that cannot be established downgrades it to SKIPPED_EXECUTION_UNAVAILABLE. In
 * both cases NO ProviderLookupJob is created, so a stranded delegated job
 * cannot exist.
 *
 * `jobCreated` distinguishes a job this call INSERTED from one it merely
 * attached to. The upload response reports the two separately (`jobsCreated`
 * vs `jobsShared`) and neither can be inferred afterwards: an item holding a
 * job id looks identical either way.
 *
 * @returns {Promise<{decision: string, skipReason: string|null,
 *   lookupJobId: number|null, jobCreated: boolean}>}
 */
async function resolveEligibleTarget(client, routed, { force, now }) {
  const { provider, subjectType, subjectValue, lane } = routed;
  const queryIdentityHash = computeQueryIdentityHash({ provider, subjectType, subjectValue });

  // THE cross-Finding dedup point: ten Findings on one IP find the same row.
  // An existing active job already carries whatever delegate link it needs, so
  // nothing is scheduled a second time.
  const existing = await repository.findActiveJobByLookupKey(client, queryIdentityHash);
  if (existing) {
    return {
      decision: RUN_ITEM_DECISIONS.ELIGIBLE,
      skipReason: null,
      lookupJobId: existing.id,
      jobCreated: false,
    };
  }

  const delegated = DELEGATED_PROVIDERS.includes(provider);
  let delegate = { status: "NONE" };
  if (delegated) {
    try {
      delegate = await establishDelegate(client, { provider, subjectValue, force, now });
    } catch (error) {
      // A refusal or failure from the canonical service is a DECISION about
      // this one target, not a reason to abort the whole run. The name is
      // logged; the message is not, so a third-party or validation string can
      // never reach the database through skipReason.
      console.error("Enrichment orchestration delegate scheduling failed", {
        provider,
        name: error && error.name,
      });
      return {
        decision: RUN_ITEM_DECISIONS.SKIPPED_EXECUTION_UNAVAILABLE,
        skipReason: SKIP_REASONS.DELEGATE_UNAVAILABLE,
        lookupJobId: null,
        jobCreated: false,
      };
    }

    if (delegate.status === "FRESH") {
      return {
        decision: RUN_ITEM_DECISIONS.SKIPPED_CACHED,
        skipReason: SKIP_REASONS.FRESH_RESULT_EXISTS,
        lookupJobId: null,
        jobCreated: false,
      };
    }
    if (delegate.status !== "LINKED") {
      return {
        decision: RUN_ITEM_DECISIONS.SKIPPED_EXECUTION_UNAVAILABLE,
        skipReason: SKIP_REASONS.DELEGATE_UNAVAILABLE,
        lookupJobId: null,
        jobCreated: false,
      };
    }
  }

  const data = {
    provider,
    subjectType,
    subjectValue,
    queryIdentityHash,
    // A delegated job is, by construction, waiting on the delegate established
    // immediately above. A direct job is PENDING and — with no worker in this
    // milestone — stays PENDING. Neither state contacts a provider.
    state: delegated ? JOB_STATES.WAITING_ON_DELEGATE : JOB_STATES.PENDING,
    lane,
    trigger: delegated ? JOB_TRIGGERS.RUN_DELEGATED : JOB_TRIGGERS.RUN_DIRECT,
    requestedAt: now,
    // Non-terminal, so it holds the identity and blocks a duplicate.
    activeLookupKey: queryIdentityHash,
  };
  if (delegate.status === "LINKED") data[delegate.field] = delegate.id;

  let job;
  let jobCreated = true;
  try {
    job = await repository.createLookupJob(client, data);
  } catch (error) {
    if (!repository.isUniqueViolation(error)) throw error;
    // Lost the race on activeLookupKey — the winner's job is the shared one.
    // The delegate scheduling above was idempotent, so the loser created no
    // duplicate delegate either. The race WINNER's job is shared, not created,
    // by this call: exactly one caller may count it as created.
    job = await repository.findActiveJobByLookupKey(client, queryIdentityHash);
    if (!job) throw error;
    jobCreated = false;
  }
  return {
    decision: RUN_ITEM_DECISIONS.ELIGIBLE,
    skipReason: null,
    lookupJobId: job.id,
    jobCreated,
  };
}

/**
 * The identity that makes an item and a routed target the same thing.
 *
 * JSON.stringify over an ARRAY, not a delimiter join. A delimiter has to be a
 * character no value can contain, and every candidate is either legal
 * somewhere in a subject or - as this line previously was - a literal NUL byte
 * embedded in a source file: unreviewable in a diff, hostile to every text
 * tool, and rejected outright by some of them. JSON quoting is text-safe and
 * collision-resistant by construction, because the encoding escapes whatever
 * the values contain.
 */
function targetKey(target) {
  return JSON.stringify([target.provider, target.subjectType, target.subjectValue]);
}

/**
 * Materializes every EXPECTED routed target that is not already written.
 *
 * ===========================================================================
 * Convergent, not "only when empty"
 * ===========================================================================
 * A crash between two item INSERTs leaves a run holding some of its items. A
 * guard of "materialize only when the run has none" would then never write the
 * rest — the missing targets would be lost permanently, and the run would
 * report a state derived from a partial truth.
 *
 * So every idempotent replay attempts the COMPLETE expected set, skipping what
 * is already present and letting the (runId, provider, subjectType,
 * subjectValue) unique absorb anything a concurrent replay wrote in between.
 * Nothing is ever updated: an existing item keeps its identity and its
 * decision, so a replay can add what is missing but can never silently rewrite
 * what was already decided.
 *
 * Runs AFTER the run row is committed and outside any transaction, for the
 * P2002 reason in the module header.
 *
 * Every count returned describes what THIS CALL wrote, never the run's totals.
 * On a replay that converged onto an existing run the two differ, and reporting
 * the totals would claim work a previous request had already recorded.
 *
 * @param {Array<object>} existingItems the run's already-written items
 * @returns {Promise<{itemsCreated: number, jobsCreated: number,
 *   jobsShared: number, skipped: number}>}
 */
async function materializeItems(client, run, routedTargets, existingItems, { force, now }) {
  const present = new Set(existingItems.map(targetKey));
  const counts = { itemsCreated: 0, jobsCreated: 0, jobsShared: 0, skipped: 0 };

  // eslint-disable-next-line no-restricted-syntax
  for (const routed of routedTargets) {
    // eslint-disable-next-line no-continue
    if (present.has(targetKey(routed))) continue;

    let resolved = {
      decision: routed.decision,
      skipReason: routed.skipReason,
      lookupJobId: null,
      jobCreated: false,
    };
    if (routed.decision === RUN_ITEM_DECISIONS.ELIGIBLE) {
      // eslint-disable-next-line no-await-in-loop
      resolved = await resolveEligibleTarget(client, routed, { force, now });
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      await repository.createRunItem(client, {
        runId: run.id,
        findingId: run.findingId,
        provider: routed.provider,
        subjectType: routed.subjectType,
        subjectValue: routed.subjectValue,
        decision: resolved.decision,
        skipReason: resolved.skipReason,
        lookupJobId: resolved.lookupJobId,
      });
      counts.itemsCreated += 1;
      if (resolved.decision === RUN_ITEM_DECISIONS.ELIGIBLE) {
        if (resolved.jobCreated) counts.jobsCreated += 1;
        else counts.jobsShared += 1;
      } else {
        // Every non-ELIGIBLE decision is a policy refusal, and none of them
        // created a job.
        counts.skipped += 1;
      }
    } catch (error) {
      // Already written by a concurrent replay of this same run — converge on
      // it rather than overwriting the decision it recorded.
      if (!repository.isUniqueViolation(error)) throw error;
    }
  }
  return counts;
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
 * @returns {Promise<{run: object, items: Array, created: boolean,
 *   itemsCreated: number, jobsCreated: number, jobsShared: number,
 *   skipped: number, outcome: string}>} `outcome` is a RUN_REQUEST_OUTCOMES
 *   value — the API contract, decided here rather than in the controller. The
 *   four counts describe what THIS call wrote, never the run's totals.
 *
 *   Providers that were in scope but had no subject are NOT returned separately:
 *   they are persisted on the run itself (`noSubjectProviders`), so the answer a
 *   caller serializes now and the answer a later GET serializes are the same
 *   stored fact rather than two independent derivations.
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

  // Validated BEFORE anything touches the database, so a rejected reason never
  // produces an orchestration record or an audit row.
  const justification = normalizeJustification(options.justification, force);

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
  // recorded DURABLY, not just serialized into this one response. For a CVE
  // provider with no verified CVE there is genuinely no subject, so no item can
  // be written (subjectValue is NOT NULL) — and previously the fact lived only
  // in the POST body and vanished from every later GET of the same run.
  //
  // Persisted on the run row, written once at creation and never updated, so:
  //   * the immediate POST and any later GET return the identical list;
  //   * associating a verified CVE afterwards cannot rewrite history;
  //   * nothing has to reverse requestScopeHash to recover the asked scope.
  const noSubjectProviders = serializeNoSubjectProviders(missingSubjectProviders);

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
        noSubjectProviders,
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

  // Convergent materialization: EVERY call attempts the complete expected
  // target set and writes only what is missing. That covers the fresh-create
  // path, an idempotent replay, and a crash that committed some items but not
  // all of them — see materializeItems for why "only when empty" loses targets.
  const existingItems = await repository.listRunItemsWithJobs(client, run.id);
  const counts = await materializeItems(client, run, routedTargets, existingItems, {
    force,
    now,
  });

  const refreshed = await refreshRunState(client, run.id, now);
  run = refreshed.run;
  const items = refreshed.items;

  // The ask's outcome. `created` alone cannot express it: a brand-new run whose
  // every target was refused by policy recorded no work, and answering that
  // with the same "accepted" signal as a run that did would be untrue.
  const hasEligibleWork = items.some((item) => item.decision === RUN_ITEM_DECISIONS.ELIGIBLE);
  let outcome;
  if (!created) {
    outcome = RUN_REQUEST_OUTCOMES.ALREADY_RUNNING;
  } else if (hasEligibleWork) {
    outcome = RUN_REQUEST_OUTCOMES.CREATED;
  } else {
    outcome = RUN_REQUEST_OUTCOMES.SKIPPED;
  }

  await audit(client, auditContext, {
    action: created ? AUDIT_ACTIONS.RUN_CREATED : AUDIT_ACTIONS.RUN_DEDUPLICATED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: id,
    after: {
      ...runAuditSummary(run, items),
      // Bounded preview only, the existing convention
      // (findingEnrichmentScheduleService.js). The raw reason is never stored
      // in an audit payload and never returned to any caller.
      justification: boundedJustificationPreview(justification),
    },
    reason: created
      ? "Enrichment orchestration run created (no provider was contacted)"
      : "Enrichment orchestration run deduplicated onto an existing run",
  });

  return { run, items, created, outcome, ...counts };
}

module.exports = {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPE,
  MAX_CREATE_ATTEMPTS,
  MAX_JUSTIFICATION_LENGTH,
  JUSTIFICATION_PREVIEW_LENGTH,
  DELEGATED_PROVIDERS,
  TERMINAL_RUN_STATES,
  EnrichmentRunValidationError,
  EnrichmentRunNotFoundError,
  EnrichmentIdentityError,
  normalizeJustification,
  boundedJustificationPreview,
  normalizeProviderScope,
  assembleTargets,
  recomputeRunState,
  refreshRunState,
  targetKey,
  establishDelegate,
  resolveEligibleTarget,
  materializeItems,
  createEnrichmentRun,
};
