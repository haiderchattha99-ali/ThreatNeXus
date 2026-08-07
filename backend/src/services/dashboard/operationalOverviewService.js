"use strict";

// Phase 6 — the truthful operational overview.
//
// This module is the ONLY producer of the analyst dashboard's figures, and it
// exists because the pre-Phase-6 dashboard was largely fabricated: a hardcoded
// "78% ATT&CK coverage", invented service latencies, a seven-day "threat trend"
// that was a literal array, per-country attack percentages, and a live feed of
// made-up indicators. None of it came from the database and none of it could be
// defended.
//
// The contract every figure below obeys:
//
//   { value, availability, source, asOf }
//
//   value        a number this process actually counted, or null
//   availability AVAILABLE | RESTRICTED | UNAVAILABLE  (never a silent zero)
//   source       the persisted table/column the number came from, in words an
//                engineer can go and verify
//   asOf         the single evaluation instant the whole snapshot was read at
//
// Hard rules:
//   - No network call of any kind. Provider *status* is derived from
//     configuration flags and from rows already persisted by earlier phases;
//     rendering this dashboard never contacts AbuseIPDB, NVD, KEV, EPSS or
//     anything else.
//   - No percentage without a denominator that is also returned.
//   - No metric a caller may not read. Sections are capability-gated
//     individually and come back RESTRICTED — not absent, and not zero.
//   - No inference. Nothing here derives a CVE from a port, a location from an
//     address, or "coverage" from a mapping count.
//   - Bounded and N+1-free: every query is a count/groupBy/aggregate, or a
//     findMany with an explicit small take.

const prisma = require("../../config/prisma");
const env = require("../../config/env");
const {
  CAPABILITIES,
  hasCapability,
  resolveAuthorizationRole,
} = require("../../lib/roles");

// Section availability.
const AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  RESTRICTED: "RESTRICTED",
  UNAVAILABLE: "UNAVAILABLE",
});

// How long a persisted provider result may be before the dashboard calls its
// freshness STALE. This describes the age of stored evidence only; it never
// triggers a refresh and never contacts anybody.
const PROVIDER_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Bounded size of the recent-activity list. A dashboard is a summary; anyone
// who needs the full history opens the case.
const RECENT_ACTIVITY_LIMIT = 8;

// Phase 6.1 — bounded size of every attention queue. A queue is a shortlist of
// what to do next, not a paged table: the full list lives on the screen the
// queue links to, which is also where filtering and paging already exist.
const QUEUE_LIMIT = 6;

// Phase 6.1 — the stored-observation trend window, in whole UTC days ending on
// the snapshot's own day. Seven is the window the demo dataset spans; it is a
// constant here rather than a query parameter because nothing in this snapshot
// accepts caller input.
const TREND_WINDOW_DAYS = 7;

/** A computed figure. `value` may legitimately be 0 — that is a counted zero. */
function metric(value, source, asOf) {
  return { value, availability: AVAILABILITY.AVAILABLE, source, asOf };
}

/** The caller's role does not grant reading this. NOT a zero. */
function restricted(source, reason) {
  return { value: null, availability: AVAILABILITY.RESTRICTED, source, asOf: null, reason };
}

/** Could not be computed. NOT a zero. */
function unavailable(source, reason) {
  return { value: null, availability: AVAILABILITY.UNAVAILABLE, source, asOf: null, reason };
}

/**
 * Turns a Prisma groupBy result into a fixed-key distribution, so a bucket with
 * no rows appears as an explicit 0 rather than vanishing from the chart. A
 * missing bar and a zero bar mean different things and must look different.
 */
function distribution(rows, keyField, allKeys) {
  const counts = new Map(allKeys.map((k) => [k, 0]));
  for (const row of rows) {
    const key = row[keyField];
    if (counts.has(key)) counts.set(key, row._count?._all ?? 0);
    else counts.set(key, row._count?._all ?? 0);
  }
  return Array.from(counts, ([key, count]) => ({ key, count }));
}

const RISK_BANDS = ["INFORMATIONAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const CASE_STATES = ["OPEN", "WAITING_FOR_ORG", "CLOSURE_PENDING", "CLOSED"];
const NOTIFICATION_STATES = ["DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED"];
const OCCURRENCE_ACTIONS = ["CREATED", "PERSISTED", "RECURRED", "HISTORICAL"];
const DELIVERY_STATUSES = ["SENT_MANUALLY", "DELIVERED", "FAILED", "BOUNCED", "UNKNOWN"];
const FRAMEWORKS = ["MITRE_ATTACK", "NIST_CSF", "CIS_CONTROLS"];
const MAPPING_SOURCES = ["MANUAL", "AI_SUGGESTION_PROMOTED"];

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

async function buildFindingsSection(client, asOf) {
  const [
    total,
    open,
    closed,
    persistent,
    withRecurrence,
    occurrenceRows,
    bandRows,
    scoredTotal,
    reportTypeRows,
    reportsTotal,
    reportsRejected,
  ] = await Promise.all([
    client.finding.count(),
    client.finding.count({ where: { status: "OPEN" } }),
    client.finding.count({ where: { status: "CLOSED" } }),
    // Seen in more than one report — the persistence signal, straight from the
    // append-only occurrence counter Phase 1 maintains.
    client.finding.count({ where: { occurrenceCount: { gt: 1 } } }),
    client.finding.count({ where: { recurrenceCount: { gt: 0 } } }),
    client.findingOccurrence.groupBy({ by: ["action"], _count: { _all: true } }),
    // Current scores only: one row per Finding, via the unique
    // currentForFindingId projection. Superseded snapshots are history and must
    // not be counted twice.
    client.riskScore.groupBy({
      by: ["riskBand"],
      where: { currentForFindingId: { not: null } },
      _count: { _all: true },
    }),
    client.riskScore.count({ where: { currentForFindingId: { not: null } } }),
    client.finding.groupBy({ by: ["reportType"], _count: { _all: true } }),
    client.rawReport.count(),
    client.rawReport.count({ where: { status: "REJECTED" } }),
  ]);

  // Ageing by last observation. Buckets are computed against the SAME asOf the
  // rest of the snapshot used, not against a fresh wall-clock read per query.
  const day = 24 * 60 * 60 * 1000;
  const t = asOf.getTime();
  const [age24h, age7d, age30d, ageOlder] = await Promise.all([
    client.finding.count({ where: { lastSeen: { gte: new Date(t - day) } } }),
    client.finding.count({
      where: { lastSeen: { gte: new Date(t - 7 * day), lt: new Date(t - day) } },
    }),
    client.finding.count({
      where: { lastSeen: { gte: new Date(t - 30 * day), lt: new Date(t - 7 * day) } },
    }),
    client.finding.count({ where: { lastSeen: { lt: new Date(t - 30 * day) } } }),
  ]);

  const iso = asOf.toISOString();
  const src = (s) => s;

  return {
    availability: AVAILABILITY.AVAILABLE,
    metrics: {
      total: metric(total, src("Finding"), iso),
      open: metric(open, src("Finding.status = OPEN"), iso),
      closed: metric(closed, src("Finding.status = CLOSED"), iso),
      persistent: metric(persistent, src("Finding.occurrenceCount > 1"), iso),
      withRecurrence: metric(withRecurrence, src("Finding.recurrenceCount > 0"), iso),
      reportsProcessed: metric(reportsTotal, src("RawReport"), iso),
      reportsRejected: metric(reportsRejected, src("RawReport.status = REJECTED"), iso),
      // The honest denominator for the band chart: Findings with no current
      // score are NOT silently folded into INFORMATIONAL.
      scored: metric(scoredTotal, src("RiskScore.currentForFindingId IS NOT NULL"), iso),
      unscored: metric(
        Math.max(total - scoredTotal, 0),
        src("Finding minus RiskScore.currentForFindingId"),
        iso
      ),
    },
    distributions: {
      riskBand: {
        items: distribution(bandRows, "riskBand", RISK_BANDS),
        source: "RiskScore.riskBand where currentForFindingId IS NOT NULL",
        asOf: iso,
        denominator: scoredTotal,
      },
      occurrenceOutcome: {
        items: distribution(occurrenceRows, "action", OCCURRENCE_ACTIONS),
        source: "FindingOccurrence.action (all ingested reports)",
        asOf: iso,
        denominator: occurrenceRows.reduce((n, r) => n + (r._count?._all ?? 0), 0),
      },
      reportType: {
        items: reportTypeRows.map((r) => ({ key: r.reportType, count: r._count._all })),
        source: "Finding.reportType",
        asOf: iso,
        denominator: total,
      },
      ageing: {
        items: [
          { key: "LAST_24H", count: age24h },
          { key: "1_7_DAYS", count: age7d },
          { key: "8_30_DAYS", count: age30d },
          { key: "OVER_30_DAYS", count: ageOlder },
        ],
        source: "Finding.lastSeen relative to this snapshot's asOf",
        asOf: iso,
        denominator: total,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function buildCasesSection(client, asOf) {
  const [stateRows, total, pendingClosureRequests, responses, reopenedByRecurrence, manualReopens] =
    await Promise.all([
      client.case.groupBy({ by: ["lifecycleState"], _count: { _all: true } }),
      client.case.count(),
      client.caseClosureRequest.count({ where: { state: "PENDING" } }),
      client.caseOrganizationResponse.count(),
      // Only evaluations that actually reopened something. The ledger also
      // records the ones that decided NOT to reopen; counting those as reopens
      // would overstate recurrence handling.
      client.caseRecurrenceReopen.count({ where: { outcome: "REOPENED" } }),
      client.case.count({ where: { lastReopenTrigger: "MANUAL" } }),
    ]);

  const iso = asOf.toISOString();
  const byState = distribution(stateRows, "lifecycleState", CASE_STATES);
  const at = (key) => byState.find((b) => b.key === key)?.count ?? 0;

  return {
    availability: AVAILABILITY.AVAILABLE,
    metrics: {
      total: metric(total, "Case", iso),
      open: metric(at("OPEN"), "Case.lifecycleState = OPEN", iso),
      waitingForOrganization: metric(
        at("WAITING_FOR_ORG"),
        "Case.lifecycleState = WAITING_FOR_ORG",
        iso
      ),
      closurePending: metric(at("CLOSURE_PENDING"), "Case.lifecycleState = CLOSURE_PENDING", iso),
      closed: metric(at("CLOSED"), "Case.lifecycleState = CLOSED", iso),
      pendingClosureRequests: metric(
        pendingClosureRequests,
        "CaseClosureRequest.state = PENDING",
        iso
      ),
      organizationResponses: metric(responses, "CaseOrganizationResponse", iso),
      reopenedByRecurrence: metric(
        reopenedByRecurrence,
        "CaseRecurrenceReopen.outcome = REOPENED",
        iso
      ),
      reopenedManually: metric(manualReopens, "Case.lastReopenTrigger = MANUAL", iso),
    },
    distributions: {
      lifecycleState: {
        items: byState,
        source: "Case.lifecycleState",
        asOf: iso,
        denominator: total,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function buildNotificationsSection(client, asOf) {
  const [stateRows, workflowTotal, exports, deliveryRows, deliveryTotal] = await Promise.all([
    // caseId NOT NULL excludes legacy, non-workflow notification rows, which
    // would otherwise inflate DRAFT with records no reviewer will ever see.
    client.notification.groupBy({
      by: ["lifecycleState"],
      where: { caseId: { not: null } },
      _count: { _all: true },
    }),
    client.notification.count({ where: { caseId: { not: null } } }),
    client.notificationExport.count(),
    client.notificationDeliveryEvent.groupBy({ by: ["status"], _count: { _all: true } }),
    client.notificationDeliveryEvent.count(),
  ]);

  const iso = asOf.toISOString();
  const byState = distribution(stateRows, "lifecycleState", NOTIFICATION_STATES);
  const at = (key) => byState.find((b) => b.key === key)?.count ?? 0;

  return {
    availability: AVAILABILITY.AVAILABLE,
    metrics: {
      total: metric(workflowTotal, "Notification WHERE caseId IS NOT NULL", iso),
      draft: metric(at("DRAFT"), "Notification.lifecycleState = DRAFT", iso),
      pendingReview: metric(at("PENDING_REVIEW"), "Notification.lifecycleState = PENDING_REVIEW", iso),
      approved: metric(at("APPROVED"), "Notification.lifecycleState = APPROVED", iso),
      rejected: metric(at("REJECTED"), "Notification.lifecycleState = REJECTED", iso),
      // Deliberately separate metrics, never summed and never presented as one
      // number: producing an artifact is not sending it, and this system has no
      // SMTP or webhook client at all.
      exports: metric(exports, "NotificationExport", iso),
      deliveryObservations: metric(deliveryTotal, "NotificationDeliveryEvent", iso),
    },
    distributions: {
      lifecycleState: {
        items: byState,
        source: "Notification.lifecycleState WHERE caseId IS NOT NULL",
        asOf: iso,
        denominator: workflowTotal,
      },
      deliveryStatus: {
        items: distribution(deliveryRows, "status", DELIVERY_STATUSES),
        source: "NotificationDeliveryEvent.status (analyst-recorded observations)",
        asOf: iso,
        denominator: deliveryTotal,
      },
    },
    disclaimer:
      "Export is not delivery. An export produces a file for the analyst to send by hand; every delivery figure here is a human observation recorded afterwards.",
  };
}

// ---------------------------------------------------------------------------
// Framework mappings
// ---------------------------------------------------------------------------

async function buildFrameworkSection(client, asOf) {
  const [frameworkRows, sourceRows, activeTotal, historyTotal, pendingSuggestions] =
    await Promise.all([
      client.caseFrameworkMapping.groupBy({
        by: ["framework"],
        where: { state: "ACTIVE", currentMappingKey: { not: null } },
        _count: { _all: true },
      }),
      client.caseFrameworkMapping.groupBy({
        by: ["source"],
        where: { state: "ACTIVE", currentMappingKey: { not: null } },
        _count: { _all: true },
      }),
      client.caseFrameworkMapping.count({
        where: { state: "ACTIVE", currentMappingKey: { not: null } },
      }),
      client.caseFrameworkMapping.count(),
      client.aiFrameworkMappingSuggestion.count({ where: { state: "PENDING" } }),
    ]);

  const iso = asOf.toISOString();

  return {
    availability: AVAILABILITY.AVAILABLE,
    metrics: {
      active: metric(activeTotal, "CaseFrameworkMapping.state = ACTIVE (current rows)", iso),
      historyRows: metric(historyTotal, "CaseFrameworkMapping (append-only history)", iso),
      // An inert count. A PENDING suggestion changes nothing about any case
      // until a human approves it.
      pendingAiSuggestions: metric(
        pendingSuggestions,
        "AiFrameworkMappingSuggestion.state = PENDING",
        iso
      ),
    },
    distributions: {
      byFramework: {
        items: distribution(frameworkRows, "framework", FRAMEWORKS),
        source: "CaseFrameworkMapping.framework WHERE state = ACTIVE",
        asOf: iso,
        denominator: activeTotal,
      },
      bySource: {
        items: distribution(sourceRows, "source", MAPPING_SOURCES),
        source: "CaseFrameworkMapping.source WHERE state = ACTIVE",
        asOf: iso,
        denominator: activeTotal,
      },
    },
    // The label is part of the contract, not decoration. These counts are
    // analyst-asserted context and are never coverage, compliance, maturity,
    // implementation level or security posture.
    label: "Analyst-associated framework context",
    disclaimer:
      "These are controls an analyst associated with a case, on a stated evidence basis. They are not coverage, compliance, maturity or security-posture measurements, and no percentage of any catalogue is implied.",
  };
}

// ---------------------------------------------------------------------------
// Provider and configuration visibility
// ---------------------------------------------------------------------------
//
// Derived from configuration flags plus rows earlier phases already persisted.
// NOTHING here performs a lookup, and nothing here exposes a key, a base URL,
// a raw provider payload, an HTTP status or a latency figure.

function providerFreshness(lastSuccessAt, asOf) {
  if (!lastSuccessAt) return { state: "NO_SUCCESSFUL_LOOKUP_RECORDED", lastSuccessAt: null };
  const age = asOf.getTime() - new Date(lastSuccessAt).getTime();
  return {
    state: age > PROVIDER_STALE_AFTER_MS ? "STALE" : "FRESH",
    lastSuccessAt: new Date(lastSuccessAt).toISOString(),
  };
}

async function buildProvidersSection(client, asOf) {
  const iso = asOf.toISOString();

  const [lastIocSuccess, vulnerabilityLastSuccess, lastCensysSuccess] = await Promise.all([
    client.iocEnrichment.aggregate({
      where: { status: "SUCCESS" },
      _max: { queriedAt: true },
    }),
    client.vulnerabilityProviderResult.groupBy({
      by: ["provider"],
      where: { status: "SUCCESS" },
      _max: { queriedAt: true },
    }),
    client.censysEnrichment.aggregate({
      where: { status: "SUCCESS" },
      _max: { queriedAt: true },
    }),
  ]);

  const selectedIocProvider = String(env.IOC_ENRICHMENT_PROVIDER || "mock").toLowerCase();
  const abuseIpdbKeyPresent = Boolean(env.ABUSEIPDB_API_KEY);

  // "Configured" reports only whether a key is present, never its value or any
  // fragment of it.
  const iocProvider = {
    id: "ioc-reputation",
    name: "IP reputation",
    selected: selectedIocProvider,
    // The mock provider needs no key and is always usable; the real one is
    // usable only when a key exists.
    status:
      selectedIocProvider === "mock"
        ? "MOCK_PROVIDER"
        : abuseIpdbKeyPresent
          ? "CONFIGURED"
          : "NOT_CONFIGURED",
    ...providerFreshness(lastIocSuccess?._max?.queriedAt, asOf),
    source: "IocEnrichment.queriedAt WHERE status = SUCCESS",
  };

  const vulnMax = new Map(
    vulnerabilityLastSuccess.map((row) => [row.provider, row._max?.queriedAt || null])
  );

  const vulnerabilityProviders = [
    {
      id: "NVD",
      name: "NVD (CVE metadata)",
      // NVD works without a key at a lower public rate limit, so absence of a
      // key is not "not configured" — it is a different, still-valid mode.
      status: env.NVD_API_KEY ? "CONFIGURED_WITH_KEY" : "KEYLESS_PUBLIC_RATE_LIMIT",
      ...providerFreshness(vulnMax.get("NVD"), asOf),
      source: "VulnerabilityProviderResult.queriedAt WHERE provider = NVD AND status = SUCCESS",
    },
    {
      id: "CISA_KEV",
      name: "CISA KEV (known exploited)",
      status: "NO_KEY_REQUIRED",
      ...providerFreshness(vulnMax.get("CISA_KEV"), asOf),
      source: "VulnerabilityProviderResult.queriedAt WHERE provider = CISA_KEV AND status = SUCCESS",
    },
    {
      id: "FIRST_EPSS",
      name: "FIRST EPSS (exploitation probability)",
      status: "NO_KEY_REQUIRED",
      ...providerFreshness(vulnMax.get("FIRST_EPSS"), asOf),
      source:
        "VulnerabilityProviderResult.queriedAt WHERE provider = FIRST_EPSS AND status = SUCCESS",
    },
  ];

  // Phase 8B — Censys internet-exposure/attack-surface provider. Requires
  // BOTH CENSYS_API_ID and CENSYS_API_SECRET (Basic Auth pair); a caller with
  // only one is reported NOT_CONFIGURED, never a fabricated partial state.
  const censysConfigured = Boolean(env.CENSYS_API_ID) && Boolean(env.CENSYS_API_SECRET);
  const exposureProviders = [
    {
      id: "censys",
      name: "Censys (internet exposure / attack surface)",
      status: censysConfigured ? "CONFIGURED" : "NOT_CONFIGURED",
      ...providerFreshness(lastCensysSuccess?._max?.queriedAt, asOf),
      source: "CensysEnrichment.queriedAt WHERE status = SUCCESS",
    },
  ];

  // Phase 6.1 — a one-line freshness roll-up, so "can I trust the stored
  // intelligence context behind these scores?" is answerable at a glance
  // without reading four rows. Every figure is a count of the rows above; it
  // asserts nothing the individual entries do not already say, and in
  // particular it is NOT a health, uptime or availability score.
  const allProviders = [iocProvider, ...vulnerabilityProviders, ...exposureProviders];
  const countState = (state) => allProviders.filter((p) => p.state === state).length;
  const summary = {
    total: allProviders.length,
    fresh: countState("FRESH"),
    stale: countState("STALE"),
    noSuccessfulLookup: countState("NO_SUCCESSFUL_LOOKUP_RECORDED"),
    source: "Counted from the provider entries in this same snapshot",
    asOf: iso,
    staleAfterHours: PROVIDER_STALE_AFTER_MS / (60 * 60 * 1000),
  };

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: iso,
    summary,
    ioc: iocProvider,
    vulnerability: vulnerabilityProviders,
    exposure: exposureProviders,
    ai: {
      id: "ai-mapping-assistance",
      name: "AI mapping assistance",
      // Off by default, and there is no live provider in this repository at all.
      status: env.AI_ENABLED ? "ENABLED" : "DISABLED",
      provider: env.AI_PROVIDER || "null",
      note: "Optional and disabled by default. Suggestions are inert until a human approves them, and AI can never score, close, approve, export or map on its own.",
    },
    // Rendering this dashboard makes no provider request. Every value above is
    // configuration state or a previously persisted row.
    liveLookupPerformed: false,
    disclaimer:
      "Provider status is read from configuration and from previously stored lookup results. This view performs no provider request, reports no latency, and never claims that all systems are operational.",
  };
}

// ---------------------------------------------------------------------------
// Recent activity (bounded)
// ---------------------------------------------------------------------------

async function buildRecentActivity(client, asOf) {
  const events = await client.caseLifecycleEvent.findMany({
    take: RECENT_ACTIVITY_LIMIT,
    orderBy: { occurredAt: "desc" },
    select: {
      id: true,
      caseId: true,
      eventType: true,
      occurredAt: true,
      fromState: true,
      toState: true,
      case: { select: { caseReference: true } },
    },
  });

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: asOf.toISOString(),
    source: "CaseLifecycleEvent, newest first",
    limit: RECENT_ACTIVITY_LIMIT,
    items: events.map((e) => ({
      id: e.id,
      caseId: e.caseId,
      caseReference: e.case?.caseReference || null,
      eventType: e.eventType,
      fromState: e.fromState || null,
      toState: e.toState || null,
      occurredAt: e.occurredAt ? e.occurredAt.toISOString() : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Phase 6.1 — attention queues
// ---------------------------------------------------------------------------
//
// A count tells an analyst that work exists. A queue tells them WHICH work, and
// gives them somewhere to click. That is the whole difference between the
// operations report this dashboard was and the command centre it has to be.
//
// Every queue below obeys the same five rules:
//
//   1. BOUNDED     — an explicit `take`, never an unbounded findMany.
//   2. DETERMINISTIC — the ordering ends in a unique tiebreaker (an id), so the
//                    same database state always produces the same list. A queue
//                    whose order changes between two identical reads is a queue
//                    two analysts will disagree about.
//   3. ALLOWLISTED — an explicit `select` and an explicit serializer. No row is
//                    ever spread into the response, so a column added to a model
//                    later cannot silently start being published.
//   4. COUNTED     — `total` is a real count of everything matching the queue's
//                    predicate, so "6 shown" can never be mistaken for "6 exist".
//   5. GATED       — on an EXISTING capability. Phase 6.1 mints no new authority.

// The only Finding columns any queue publishes. Deliberately excludes
// closedBy/closureReason/closedThroughObservedAt and every relation.
const FINDING_QUEUE_SELECT = Object.freeze({
  id: true,
  indicatorValue: true,
  port: true,
  protocol: true,
  reportType: true,
  status: true,
  occurrenceCount: true,
  recurrenceCount: true,
  firstSeen: true,
  lastSeen: true,
});

function isoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

/**
 * One queue row for a Finding.
 *
 * `risk.state` is a factual lifecycle state, not an availability: NOT_SCORED
 * means the scoring engine has genuinely never produced a current snapshot for
 * this Finding, which is different from "we could not read it". A row in that
 * state carries nulls, never a zero and never the lowest band.
 */
function serializeFindingQueueItem(finding, score) {
  return {
    id: finding.id,
    indicatorValue: finding.indicatorValue,
    port: finding.port,
    protocol: finding.protocol,
    reportType: finding.reportType,
    status: finding.status,
    occurrenceCount: finding.occurrenceCount,
    recurrenceCount: finding.recurrenceCount,
    firstSeen: isoOrNull(finding.firstSeen),
    lastSeen: isoOrNull(finding.lastSeen),
    // Derived from the two counters above and shown alongside them, so the
    // badge can always be checked against the number it was derived from.
    persistent: finding.occurrenceCount > 1,
    recurred: finding.recurrenceCount > 0,
    risk: score
      ? {
          state: "SCORED",
          band: score.riskBand,
          // The same floor(basisPoints / 100) projection the Finding read path
          // uses. Risk v1 is a locked contract; nothing here rescores.
          displayScore: Math.floor(score.scoreBasisPoints / 100),
          scoreBasisPoints: score.scoreBasisPoints,
          asOf: isoOrNull(score.asOf),
        }
      : { state: "NOT_SCORED", band: null, displayScore: null, scoreBasisPoints: null, asOf: null },
  };
}

async function buildFindingQueues(client, asOf) {
  const iso = asOf.toISOString();

  // "Awaiting triage" is expressed against the current-triage projection
  // (FindingTriage.currentForFindingId), which is the same column the triage
  // read path treats as authoritative. It is NOT inferred from the absence of
  // history — a Finding whose only triage row was superseded is still triaged.
  const untriaged = {
    status: "OPEN",
    triageHistory: { none: { currentForFindingId: { not: null } } },
  };

  const [openTotal, untriagedTotal, priorityRows, untriagedRows] = await Promise.all([
    client.finding.count({ where: { status: "OPEN" } }),
    client.finding.count({ where: untriaged }),
    // Driven from RiskScore rather than Finding, because the current score is
    // reachable there through the unique currentForFindingId projection —
    // which means one bounded query, no per-row lookup, and an ordering
    // PostgreSQL can satisfy from an index.
    client.riskScore.findMany({
      where: { currentForFindingId: { not: null }, finding: { status: "OPEN" } },
      take: QUEUE_LIMIT,
      orderBy: [{ scoreBasisPoints: "desc" }, { findingId: "asc" }],
      select: {
        scoreBasisPoints: true,
        riskBand: true,
        asOf: true,
        finding: { select: FINDING_QUEUE_SELECT },
      },
    }),
    client.finding.findMany({
      where: untriaged,
      take: QUEUE_LIMIT,
      // Most-repeated first: a Finding seen in five reports and never triaged
      // is a worse backlog item than one seen once. `id` closes the ordering.
      orderBy: [{ occurrenceCount: "desc" }, { lastSeen: "desc" }, { id: "asc" }],
      select: FINDING_QUEUE_SELECT,
    }),
  ]);

  // One extra bounded query — never one per row — to attach the current score
  // to the triage backlog. `in` is over at most QUEUE_LIMIT ids.
  const untriagedIds = untriagedRows.map((f) => f.id);
  const untriagedScores = untriagedIds.length
    ? await client.riskScore.findMany({
        where: { currentForFindingId: { in: untriagedIds } },
        select: { currentForFindingId: true, scoreBasisPoints: true, riskBand: true, asOf: true },
      })
    : [];
  const scoreByFinding = new Map(untriagedScores.map((s) => [s.currentForFindingId, s]));

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: iso,
    limit: QUEUE_LIMIT,
    priority: {
      availability: AVAILABILITY.AVAILABLE,
      // Named for what it is. This is the highest CURRENT Risk v1 score among
      // open findings — not a severity, not a threat level, and not a ranking
      // of anything outside the loaded dataset.
      label: "Highest current Risk v1 score, open findings",
      source:
        "RiskScore.scoreBasisPoints WHERE currentForFindingId IS NOT NULL AND Finding.status = OPEN, ordered by score descending then findingId",
      asOf: iso,
      total: openTotal,
      totalLabel: "open findings",
      items: priorityRows.map((row) => serializeFindingQueueItem(row.finding, row)),
    },
    awaitingTriage: {
      availability: AVAILABILITY.AVAILABLE,
      label: "Open findings with no current triage decision",
      source:
        "Finding.status = OPEN with no FindingTriage row holding currentForFindingId, ordered by occurrenceCount descending then lastSeen descending then id",
      asOf: iso,
      total: untriagedTotal,
      totalLabel: "awaiting a triage decision",
      items: untriagedRows.map((f) => serializeFindingQueueItem(f, scoreByFinding.get(f.id) || null)),
    },
  };
}

// The only Case columns any queue publishes. caseReference/title/organization
// name are already what the Phase 3 case serializer exposes to every holder of
// read:cases, so this adds no new exposure; organization CONTACT detail (email,
// phone, contact person) is excluded here exactly as it is there.
const CASE_QUEUE_SELECT = Object.freeze({
  id: true,
  caseReference: true,
  title: true,
  lifecycleState: true,
  createdAt: true,
  updatedAt: true,
  ownerOrganization: { select: { name: true } },
});

function serializeCaseQueueItem(record) {
  return {
    id: record.id,
    caseReference: record.caseReference || null,
    title: record.title,
    lifecycleState: record.lifecycleState,
    organizationName: record.ownerOrganization ? record.ownerOrganization.name : null,
    createdAt: isoOrNull(record.createdAt),
    updatedAt: isoOrNull(record.updatedAt),
  };
}

async function buildCaseQueues(client, asOf) {
  const iso = asOf.toISOString();

  const [closureTotal, waitingTotal, closureRows, waitingRows] = await Promise.all([
    client.caseClosureRequest.count({ where: { state: "PENDING" } }),
    client.case.count({ where: { lifecycleState: "WAITING_FOR_ORG" } }),
    client.caseClosureRequest.findMany({
      where: { state: "PENDING" },
      take: QUEUE_LIMIT,
      // Oldest request first: a review queue that surfaces the newest item is a
      // queue whose oldest item is never reached.
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        caseId: true,
        closureReason: true,
        requestedAt: true,
        case: { select: CASE_QUEUE_SELECT },
      },
    }),
    client.case.findMany({
      where: { lifecycleState: "WAITING_FOR_ORG" },
      take: QUEUE_LIMIT,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: CASE_QUEUE_SELECT,
    }),
  ]);

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: iso,
    limit: QUEUE_LIMIT,
    closureReview: {
      availability: AVAILABILITY.AVAILABLE,
      label: "Closure requests awaiting a reviewer decision",
      source: "CaseClosureRequest.state = PENDING, ordered by requestedAt ascending then id",
      asOf: iso,
      total: closureTotal,
      totalLabel: "pending closure requests",
      items: closureRows.map((row) => ({
        id: row.id,
        caseId: row.caseId,
        closureReason: row.closureReason,
        requestedAt: isoOrNull(row.requestedAt),
        // The analyst's written justification is deliberately NOT published
        // here. It belongs on the case, where the reviewer reads it in full
        // before deciding — not truncated into a dashboard row.
        case: row.case ? serializeCaseQueueItem(row.case) : null,
      })),
    },
    waitingOnOrganization: {
      availability: AVAILABILITY.AVAILABLE,
      label: "Cases waiting on a constituent organization",
      source: "Case.lifecycleState = WAITING_FOR_ORG, ordered by updatedAt ascending then id",
      asOf: iso,
      total: waitingTotal,
      totalLabel: "cases waiting on an organization",
      items: waitingRows.map(serializeCaseQueueItem),
    },
  };
}

// Notification queue columns. `title` and `message` are constituent-addressed
// CONTENT and are never published to a dashboard — a reviewer opens the
// notification to read what it says, which is also where the revision the
// approval will bind to is shown.
const NOTIFICATION_QUEUE_SELECT = Object.freeze({
  id: true,
  notificationReference: true,
  lifecycleState: true,
  createdAt: true,
  caseId: true,
  case: { select: { caseReference: true } },
  ownerOrganization: { select: { name: true } },
});

function serializeNotificationQueueItem(record) {
  return {
    id: record.id,
    notificationReference: record.notificationReference || null,
    lifecycleState: record.lifecycleState,
    caseId: record.caseId,
    caseReference: record.case ? record.case.caseReference : null,
    organizationName: record.ownerOrganization ? record.ownerOrganization.name : null,
    createdAt: isoOrNull(record.createdAt),
  };
}

async function buildNotificationQueue(client, asOf) {
  const iso = asOf.toISOString();
  const workflow = { caseId: { not: null } };

  const [reviewTotal, draftTotal, reviewRows, draftRows] = await Promise.all([
    client.notification.count({ where: { ...workflow, lifecycleState: "PENDING_REVIEW" } }),
    client.notification.count({ where: { ...workflow, lifecycleState: "DRAFT" } }),
    client.notification.findMany({
      where: { ...workflow, lifecycleState: "PENDING_REVIEW" },
      take: QUEUE_LIMIT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: NOTIFICATION_QUEUE_SELECT,
    }),
    client.notification.findMany({
      where: { ...workflow, lifecycleState: "DRAFT" },
      take: QUEUE_LIMIT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: NOTIFICATION_QUEUE_SELECT,
    }),
  ]);

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: iso,
    limit: QUEUE_LIMIT,
    awaitingReview: {
      availability: AVAILABILITY.AVAILABLE,
      label: "Notifications awaiting a reviewer decision",
      source:
        "Notification.lifecycleState = PENDING_REVIEW WHERE caseId IS NOT NULL, ordered by createdAt ascending then id",
      asOf: iso,
      total: reviewTotal,
      totalLabel: "awaiting review",
      items: reviewRows.map(serializeNotificationQueueItem),
    },
    drafting: {
      availability: AVAILABILITY.AVAILABLE,
      label: "Drafts not yet submitted for review",
      source:
        "Notification.lifecycleState = DRAFT WHERE caseId IS NOT NULL, ordered by createdAt ascending then id",
      asOf: iso,
      total: draftTotal,
      totalLabel: "drafts in progress",
      items: draftRows.map(serializeNotificationQueueItem),
    },
  };
}

// ---------------------------------------------------------------------------
// Phase 6.1 — stored observation trend
// ---------------------------------------------------------------------------
//
// This is NOT a trend line, and the distinction is the reason it is allowed to
// exist at all. Each entry is a COUNT OF PERSISTED ROWS whose timestamp falls
// inside one whole UTC day. Nothing is interpolated, smoothed, forecast or
// carried forward: a day on which no report was ingested is a factual zero,
// because the query ran and found none. The frontend renders it as discrete
// bars for the same reason — a continuous curve would imply measurements
// between the days that this system never took.

function utcDayStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function buildIngestionTrend(client, asOf) {
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = utcDayStart(asOf);

  const windows = [];
  for (let back = TREND_WINDOW_DAYS - 1; back >= 0; back -= 1) {
    const start = new Date(todayStart.getTime() - back * dayMs);
    windows.push({ start, end: new Date(start.getTime() + dayMs) });
  }

  // 2 bounded aggregates per day. Fixed at 14 queries regardless of how much
  // data exists, and none of them returns a row.
  const results = await Promise.all(
    windows.flatMap(({ start, end }) => [
      client.findingOccurrence.groupBy({
        by: ["action"],
        where: { observedAt: { gte: start, lt: end } },
        _count: { _all: true },
      }),
      client.rawReport.count({ where: { ingestedAt: { gte: start, lt: end } } }),
    ])
  );

  const days = windows.map(({ start }, index) => {
    const actionRows = results[index * 2] || [];
    const reportsIngested = results[index * 2 + 1] || 0;
    const byAction = new Map(OCCURRENCE_ACTIONS.map((a) => [a, 0]));
    let observations = 0;
    for (const row of actionRows) {
      const count = row._count?._all ?? 0;
      byAction.set(row.action, count);
      observations += count;
    }
    return {
      date: start.toISOString().slice(0, 10),
      observations,
      reportsIngested,
      byAction: Array.from(byAction, ([key, count]) => ({ key, count })),
    };
  });

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: asOf.toISOString(),
    windowDays: TREND_WINDOW_DAYS,
    source:
      "FindingOccurrence.observedAt and RawReport.ingestedAt, counted per whole UTC day (persisted rows only)",
    days,
    totals: {
      observations: days.reduce((n, d) => n + d.observations, 0),
      reportsIngested: days.reduce((n, d) => n + d.reportsIngested, 0),
    },
    note: "Each column counts persisted rows for one UTC day. A day with no ingested report is a counted zero, not an interpolated point, and no value between two days is implied.",
  };
}

// ---------------------------------------------------------------------------
// Phase 6.2 — Risk v1 factor pressure
// ---------------------------------------------------------------------------
//
// The analyst question this answers, and the only one it answers:
//
//   "Across the findings that currently carry a Risk v1 score, which factors
//    are actually producing that risk — and which are producing none because
//    the evidence for them was never available?"
//
// That second half is the point. A dashboard that only shows a band
// distribution cannot tell an analyst that, say, every IOC-reputation
// contribution in this dataset is zero because no enrichment lookup ever
// succeeded. Reading a HIGH band without knowing which evidence was missing
// when it was computed is how a score gets over-trusted.
//
// Every number below is a SUM OR COUNT OF PERSISTED RiskFactorContribution
// ROWS. Nothing is rescored, re-weighted, re-derived or inferred: Risk v1 is a
// locked contract and this view only reads what the engine already wrote.
//
// Three properties are deliberate:
//
//   - Aggregated by factorKey ONLY, over the CURRENT score of each Finding
//     (RiskScore.currentForFindingId IS NOT NULL). Superseded snapshots are
//     history; counting them would let one heavily-rescored Finding dominate.
//   - The per-factor cap comes from the stored maximumContributionBasisPoints
//     column, not from the live configuration table. That is what keeps an old
//     contribution explicable as "300 of a possible 1200" after a future
//     configuration version changes the cap.
//   - Applicability is reported as three separate counts, never collapsed.
//     APPLIED, NOT_AVAILABLE and NOT_APPLICABLE all contribute basis points
//     that may be zero, but they mean different things: "measured as nothing",
//     "we could not measure it", and "it cannot apply to this finding".
//
// Ownership confidence is NOT here and can never be: it is not a Risk v1
// factor, it affects routing and actionability only, and the ten keys the
// engine writes do not include it.

const RISK_FACTOR_APPLICABILITY = ["APPLIED", "NOT_AVAILABLE", "NOT_APPLICABLE"];

async function buildRiskFactorPressure(client, asOf) {
  const iso = asOf.toISOString();

  // Only contributions belonging to a CURRENT score.
  const currentScoresOnly = { riskScore: { currentForFindingId: { not: null } } };

  // Two bounded aggregates. Neither returns a row, and neither grows with the
  // number of findings — the grouping is over at most (10 factors x 3
  // applicabilities) buckets no matter how large the dataset gets.
  const [rows, scoredFindings] = await Promise.all([
    client.riskFactorContribution.groupBy({
      by: ["factorKey", "applicability"],
      where: currentScoresOnly,
      _count: { _all: true },
      _sum: { contributionBasisPoints: true, maximumContributionBasisPoints: true },
      // Stable presentation order comes from the engine's own displayOrder, so
      // this list reads identically on every machine and every replay.
      _min: { displayOrder: true },
    }),
    client.riskScore.count({ where: { currentForFindingId: { not: null } } }),
  ]);

  const byFactor = new Map();
  for (const row of rows) {
    const key = row.factorKey;
    if (!byFactor.has(key)) {
      byFactor.set(key, {
        factorKey: key,
        displayOrder: row._min?.displayOrder ?? Number.MAX_SAFE_INTEGER,
        contributionBasisPoints: 0,
        maximumContributionBasisPoints: 0,
        scoredFindings: 0,
        applicability: Object.fromEntries(RISK_FACTOR_APPLICABILITY.map((a) => [a, 0])),
      });
    }
    const entry = byFactor.get(key);
    entry.contributionBasisPoints += row._sum?.contributionBasisPoints ?? 0;
    entry.maximumContributionBasisPoints += row._sum?.maximumContributionBasisPoints ?? 0;
    const count = row._count?._all ?? 0;
    entry.scoredFindings += count;
    if (row.applicability in entry.applicability) {
      entry.applicability[row.applicability] += count;
    }
    entry.displayOrder = Math.min(entry.displayOrder, row._min?.displayOrder ?? entry.displayOrder);
  }

  const factors = Array.from(byFactor.values())
    .sort((a, b) => a.displayOrder - b.displayOrder || a.factorKey.localeCompare(b.factorKey))
    .map((entry) => ({
      factorKey: entry.factorKey,
      displayOrder: entry.displayOrder,
      // What this factor actually added, summed across every current score.
      contributionBasisPoints: entry.contributionBasisPoints,
      // What it could have added across those same scores, summed from the cap
      // each row was drawn against at the time it was written.
      maximumContributionBasisPoints: entry.maximumContributionBasisPoints,
      // How many current scores carry a contribution row for this factor at
      // all. Equal to `scoredFindings` below in a coherent dataset; published
      // separately so a mismatch is visible rather than hidden.
      contributionRows: entry.scoredFindings,
      applied: entry.applicability.APPLIED,
      notAvailable: entry.applicability.NOT_AVAILABLE,
      notApplicable: entry.applicability.NOT_APPLICABLE,
    }));

  const totalContribution = factors.reduce((n, f) => n + f.contributionBasisPoints, 0);
  const totalMaximum = factors.reduce((n, f) => n + f.maximumContributionBasisPoints, 0);

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: iso,
    label: "Risk v1 factor pressure",
    factors,
    // The denominator is stated, and so is what it means. Every per-factor
    // count above is out of exactly this many findings.
    denominator: scoredFindings,
    denominatorDefinition:
      "Findings holding a current Risk v1 score (RiskScore.currentForFindingId IS NOT NULL). Findings with no current score contribute no row to any factor here and are not counted in any figure on this panel.",
    totals: {
      contributionBasisPoints: totalContribution,
      maximumContributionBasisPoints: totalMaximum,
      // Stated rather than computed into a percentage: the ten locked factor
      // caps sum to exactly SCORE_MAX_BASIS_POINTS, so this total is also the
      // sum of every current score's basis points. Publishing it lets that
      // identity be checked instead of trusted.
      note: "Total contribution equals the sum of every current Risk v1 score in basis points, because the ten locked factor caps sum to the maximum score.",
    },
    source:
      "RiskFactorContribution.contributionBasisPoints and .maximumContributionBasisPoints, grouped by factorKey and applicability, restricted to rows whose RiskScore holds currentForFindingId",
    disclaimer:
      "Persisted contributions from the locked Risk v1 engine, summed. Nothing here is rescored, re-weighted or inferred, and no factor's share is presented as a proportion of any catalogue, population or national total. A factor contributing zero basis points may mean the evidence was measured as negligible or that it could never be read — the applicability counts distinguish the two.",
  };
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Builds the whole snapshot.
 *
 * Section isolation is deliberate: if one section's queries fail, that section
 * reports UNAVAILABLE and the rest still render. A dashboard that returns 500
 * because one aggregate broke tells an analyst nothing; a dashboard that
 * silently shows zeros for it tells them something false.
 *
 * @param {object} options
 * @param {string} options.role   the caller's resolved role
 * @param {Date}   [options.asOf] explicit evaluation instant (tests pass this)
 * @param {object} [options.client] Prisma client/transaction
 */
async function buildOperationalOverview({ role, asOf = new Date(), client = prisma } = {}) {
  const can = (capability) => hasCapability(role, capability);

  async function section(name, capability, builder, restrictedReason) {
    if (capability && !can(capability)) {
      return {
        availability: AVAILABILITY.RESTRICTED,
        reason: restrictedReason,
        metrics: {},
        distributions: {},
      };
    }
    try {
      return await builder(client, asOf);
    } catch (error) {
      // Never leaks the error text. The message is fixed; the detail stays in
      // the server log where it belongs.
      console.error("Dashboard section failed", { section: name, name: error?.name });
      return {
        availability: AVAILABILITY.UNAVAILABLE,
        reason: "This section could not be computed. It is shown as unavailable rather than zero.",
        metrics: {},
        distributions: {},
      };
    }
  }

  const [
    findings,
    cases,
    notifications,
    frameworks,
    providers,
    recentActivity,
    findingQueues,
    caseQueues,
    notificationQueue,
    ingestionTrend,
    riskFactorPressure,
  ] = await Promise.all([
    section("findings", CAPABILITIES.READ_FINDINGS, buildFindingsSection, "Reading findings requires read:findings."),
    section("cases", CAPABILITIES.READ_CASES, buildCasesSection, "Reading cases requires read:cases."),
    // VIEWER holds read:dashboard but deliberately NOT read:notifications — a
    // notification is constituent-addressed correspondence, and Phase 4 decided
    // read-only oversight of it was not granted. So this section is restricted
    // rather than quietly counted for them.
    section(
      "notifications",
      CAPABILITIES.READ_NOTIFICATIONS,
      buildNotificationsSection,
      "Reading notifications requires read:notifications."
    ),
    // Framework mappings reuse read:cases, exactly as the Phase 5 mapping read
    // routes do — reading which controls an analyst associated with a case IS
    // reading the case.
    section(
      "frameworkMappings",
      CAPABILITIES.READ_CASES,
      buildFrameworkSection,
      "Reading framework mappings requires read:cases."
    ),
    // Provider availability is operational context every dashboard reader needs
    // in order to interpret a risk score, and it exposes no key, no URL and no
    // provider payload — so it rides on read:dashboard itself.
    section("providers", null, buildProvidersSection, null),
    section(
      "recentActivity",
      CAPABILITIES.READ_CASES,
      buildRecentActivity,
      "Reading case activity requires read:cases."
    ),
    // Phase 6.1 attention queues. Each rides on the SAME existing capability
    // as the counts it details — a queue of findings is findings, a queue of
    // cases is cases — so no role can see through a queue what the equivalent
    // section already refuses it.
    section(
      "findingQueues",
      CAPABILITIES.READ_FINDINGS,
      buildFindingQueues,
      "Reading findings requires read:findings."
    ),
    section(
      "caseQueues",
      CAPABILITIES.READ_CASES,
      buildCaseQueues,
      "Reading cases requires read:cases."
    ),
    section(
      "notificationQueue",
      CAPABILITIES.READ_NOTIFICATIONS,
      buildNotificationQueue,
      "Reading notifications requires read:notifications."
    ),
    section(
      "ingestionTrend",
      CAPABILITIES.READ_FINDINGS,
      buildIngestionTrend,
      "Reading ingestion history requires read:findings."
    ),
    // Phase 6.2. Factor contributions are Risk v1 evidence about Findings, and
    // the band distribution they explain already rides on read:findings — so
    // this reuses the SAME capability and mints no new authority.
    section(
      "riskFactorPressure",
      CAPABILITIES.READ_FINDINGS,
      buildRiskFactorPressure,
      "Reading risk factor contributions requires read:findings."
    ),
  ]);

  return {
    generatedAt: asOf.toISOString(),
    // The role this snapshot was actually gated against. Returned so the UI
    // composes its layout from the SAME server-resolved role that decided which
    // sections are readable, rather than from a separately-fetched profile that
    // could disagree with it. It is a UX input only: nothing the client does
    // with it can widen what this response already contains.
    audience: { role: resolveAuthorizationRole(role) },
    // Every consumer must render this. The dataset is what has been loaded into
    // this instance — it is not a national, sector-wide or Internet-wide
    // measurement, and no figure here may be presented as one.
    datasetScope:
      "Loaded dataset only. These figures describe reports ingested into this instance, not national or Internet-wide exposure.",
    geographic: {
      // No coordinate is stored anywhere in this schema, and none may be
      // inferred from an address, an organization name or a provider response.
      availability: AVAILABILITY.UNAVAILABLE,
      message: "Verified geographic observations are not currently available.",
      reason:
        "No provenance-backed coordinate is persisted by any phase, and geolocation is never inferred from an indicator, an organization or a provider response.",
    },
    sections: {
      findings,
      cases,
      notifications,
      frameworkMappings: frameworks,
      providers,
      recentActivity,
      findingQueues,
      caseQueues,
      notificationQueue,
      ingestionTrend,
      riskFactorPressure,
    },
  };
}

module.exports = {
  buildOperationalOverview,
  AVAILABILITY,
  PROVIDER_STALE_AFTER_MS,
  RECENT_ACTIVITY_LIMIT,
  QUEUE_LIMIT,
  TREND_WINDOW_DAYS,
  RISK_FACTOR_APPLICABILITY,
  // exported for tests
  distribution,
  providerFreshness,
  serializeFindingQueueItem,
  serializeCaseQueueItem,
  serializeNotificationQueueItem,
  utcDayStart,
};
