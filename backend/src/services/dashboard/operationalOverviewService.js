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
const { CAPABILITIES, hasCapability } = require("../../lib/roles");

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

  const [lastIocSuccess, vulnerabilityLastSuccess] = await Promise.all([
    client.iocEnrichment.aggregate({
      where: { status: "SUCCESS" },
      _max: { queriedAt: true },
    }),
    client.vulnerabilityProviderResult.groupBy({
      by: ["provider"],
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

  return {
    availability: AVAILABILITY.AVAILABLE,
    asOf: iso,
    ioc: iocProvider,
    vulnerability: vulnerabilityProviders,
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

  const [findings, cases, notifications, frameworks, providers, recentActivity] = await Promise.all([
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
  ]);

  return {
    generatedAt: asOf.toISOString(),
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
    sections: { findings, cases, notifications, frameworkMappings: frameworks, providers, recentActivity },
  };
}

module.exports = {
  buildOperationalOverview,
  AVAILABILITY,
  PROVIDER_STALE_AFTER_MS,
  RECENT_ACTIVITY_LIMIT,
  // exported for tests
  distribution,
  providerFreshness,
};
