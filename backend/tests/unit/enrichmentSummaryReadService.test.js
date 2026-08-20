import { describe, it, expect } from "vitest";

// Phase 10A-1 — the Finding enrichment SUMMARY.
//
// Pure-ish unit coverage: the service is driven against a hand-built fake
// client, so every branch of the status/source resolution is exercised without
// a database and without any possibility of a provider call. The HTTP contract
// (routes, roles, exact keys) is proven separately in
// tests/integration/phase10a1RouteAuthorization.test.js, and the static
// inertness gate proves the package cannot reach a third party at all.

const {
  EnrichmentSummaryNotFoundError,
  EnrichmentSummaryValidationError,
  statusForJobState,
  refineUnavailableJobStatus,
  summaryForIocDelegate,
  resolveSubjectState,
  rollUp,
  getFindingEnrichmentSummary,
} = require("../../src/services/enrichmentOrchestration/enrichmentSummaryReadService");
const {
  SUMMARY_STATUSES,
  SUMMARY_STATUS_PRECEDENCE,
  SUMMARY_SOURCES,
  RUN_ITEM_DECISIONS,
  JOB_STATES,
  SKIP_REASONS,
  EXECUTION_SKIP_REASONS,
} = require("../../src/services/enrichmentOrchestration/enrichmentDecisionCodes");

const ASOF = new Date("2026-08-12T00:00:00.000Z");
const INDICATOR = "198.18.0.9";

/**
 * A minimal fake client. `items` is keyed by "provider|subjectValue".
 */
function fakeClient({ finding = { id: 1, indicatorValue: INDICATOR }, cves = [], items = {} }) {
  return {
    finding: {
      findUnique: async ({ where }) => (where.id === (finding && finding.id) ? finding : null),
    },
    findingVulnerability: {
      findMany: async () => cves.map((cveId) => ({ vulnerability: { cveId } })),
    },
    findingEnrichmentRunItem: {
      findFirst: async ({ where }) => items[`${where.provider}|${where.subjectValue}`] || null,
    },
  };
}

const eligibleItem = (job) => ({
  decision: RUN_ITEM_DECISIONS.ELIGIBLE,
  skipReason: null,
  lookupJob: { state: JOB_STATES.PENDING, freshUntil: null, ...job },
});

describe("job state to summary status", () => {
  it("never reports an unknown or failed state as a finished answer", () => {
    expect(statusForJobState(JOB_STATES.PENDING)).toBe(SUMMARY_STATUSES.PENDING);
    expect(statusForJobState(JOB_STATES.WAITING_ON_DELEGATE)).toBe(SUMMARY_STATUSES.PENDING);
    expect(statusForJobState(JOB_STATES.SUCCEEDED)).toBe(SUMMARY_STATUSES.COMPLETED);
    // "The provider has no record" is a real answer, distinct from a positive
    // one — never collapsed into COMPLETED, which would overclaim (defect 1).
    expect(statusForJobState(JOB_STATES.NO_RECORD)).toBe(SUMMARY_STATUSES.NO_RECORD);
    expect(statusForJobState(JOB_STATES.FAILED)).toBe(SUMMARY_STATUSES.UNAVAILABLE);
    expect(statusForJobState(JOB_STATES.DEAD_LETTER)).toBe(SUMMARY_STATUSES.UNAVAILABLE);
    expect(statusForJobState(JOB_STATES.SKIPPED_BUDGET)).toBe(SUMMARY_STATUSES.SKIPPED);
    // A state nobody classified must fail toward "we do not know", never
    // toward "there is nothing".
    expect(statusForJobState("SOMETHING_ADDED_IN_A_LATER_PHASE")).toBe(
      SUMMARY_STATUSES.UNAVAILABLE
    );
  });
});

describe("refining a job's generic UNAVAILABLE from closed diagnostics only", () => {
  it("recovers RATE_LIMITED only from the recognized provider error code (guarantee 7)", () => {
    expect(
      refineUnavailableJobStatus({ terminalReasonCode: null, errorCode: "PROVIDER_RATE_LIMITED" })
    ).toBe(SUMMARY_STATUSES.RATE_LIMITED);
  });

  it("recovers AMBIGUOUS only from the recognized terminal reason code (guarantee 6)", () => {
    expect(
      refineUnavailableJobStatus({ terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT", errorCode: null })
    ).toBe(SUMMARY_STATUSES.AMBIGUOUS);
  });

  it("never invents a status from an unrecognized diagnostic (guarantee 9)", () => {
    expect(
      refineUnavailableJobStatus({
        terminalReasonCode: "TypeError: connect ECONNREFUSED 10.0.0.1:443",
        errorCode: "SOME_FUTURE_CODE",
      })
    ).toBe(SUMMARY_STATUSES.UNAVAILABLE);
  });
});

describe("resolving a terminal IOC delegate", () => {
  it("distinguishes ambiguous from an ordinary exhausted dead-letter (guarantee 6)", () => {
    expect(
      summaryForIocDelegate({ status: "DEAD_LETTER", terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT" })
    ).toBe(SUMMARY_STATUSES.AMBIGUOUS);
    expect(
      summaryForIocDelegate({ status: "DEAD_LETTER", terminalReasonCode: "MAX_ATTEMPTS_EXHAUSTED" })
    ).toBe(SUMMARY_STATUSES.UNAVAILABLE);
  });
});

// `evidence` — the stored answer itself, so a finished lookup can say more
// than "completed". Nothing here reads a new row: it is the SAME row the status
// was already derived from, narrowed by the repository's explicit select.
describe("attaching the stored evidence to a row", () => {
  it("carries the direct provider's evidence row through, and only that row", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.SUCCEEDED,
        censysEnrichment: {
          queriedAt: new Date("2026-08-11T10:00:00.000Z"),
          services: [{ port: 3389, protocol: "TCP", serviceName: "RDP" }],
          autonomousSystemNumber: 13335,
          autonomousSystemName: "CLOUDFLARENET",
          certificateCount: null,
        },
      }),
      ASOF
    );

    expect(resolved.status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(resolved.evidence.autonomousSystemName).toBe("CLOUDFLARENET");
    expect(resolved.evidence.services).toHaveLength(1);
    // A null column stays null — it is never defaulted into a number.
    expect(resolved.evidence.certificateCount).toBeNull();
  });

  it("picks the AbuseIPDB delegate's analyst columns and no transport or key material", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: {
          status: "SUCCESS",
          expiresAt: new Date("2026-08-13T00:00:00.000Z"),
          queriedAt: new Date("2026-08-11T10:00:00.000Z"),
          abuseConfidenceScore: 100,
          totalReports: 412,
          usageType: "Data Center",
          isWhitelisted: false,
          errorMessage: "TypeError: connect ECONNREFUSED 10.0.0.1:443",
          cacheKey: "secret-cache-key",
          claimToken: "secret-claim-token",
        },
      }),
      ASOF
    );

    expect(resolved.source).toBe(SUMMARY_SOURCES.IOC_ENRICHMENT);
    expect(resolved.evidence.abuseConfidenceScore).toBe(100);
    expect(resolved.evidence.isWhitelisted).toBe(false);
    expect(Object.keys(resolved.evidence)).not.toEqual(
      expect.arrayContaining(["errorMessage", "cacheKey", "claimToken", "httpStatus", "errorCode"])
    );
  });

  it("attaches no evidence to a row that has no answer to show", () => {
    expect(resolveSubjectState(null, ASOF).evidence).toBeNull();
    expect(
      resolveSubjectState(
        {
          decision: RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED,
          skipReason: SKIP_REASONS.PROVIDER_NOT_CONFIGURED,
          lookupJob: null,
        },
        ASOF
      ).evidence
    ).toBeNull();
    // The vulnerability batch finishing is not a per-source provider result,
    // and this layer cannot read one — so it claims none.
    expect(
      resolveSubjectState(
        eligibleItem({
          state: JOB_STATES.WAITING_ON_DELEGATE,
          vulnerabilityEnrichmentJob: { status: "COMPLETED" },
        }),
        ASOF
      ).evidence
    ).toBeNull();
  });
});

describe("resolving one subject", () => {
  it("distinguishes never-asked from refused", () => {
    expect(resolveSubjectState(null, ASOF)).toMatchObject({
      status: SUMMARY_STATUSES.NOT_REQUESTED,
      source: SUMMARY_SOURCES.NONE,
      evidenceAvailable: false,
    });

    expect(
      resolveSubjectState(
        {
          decision: RUN_ITEM_DECISIONS.SKIPPED_NOT_CONFIGURED,
          skipReason: SKIP_REASONS.PROVIDER_NOT_CONFIGURED,
          lookupJob: null,
        },
        ASOF
      )
    ).toMatchObject({
      status: SUMMARY_STATUSES.SKIPPED,
      skipReason: SKIP_REASONS.PROVIDER_NOT_CONFIGURED,
    });
  });

  it("suppresses a stored skipReason outside the closed vocabulary", () => {
    const resolved = resolveSubjectState(
      {
        decision: RUN_ITEM_DECISIONS.SKIPPED_DISABLED,
        skipReason: "TypeError: connect ECONNREFUSED 10.0.0.1:443",
        lookupJob: null,
      },
      ASOF
    );
    expect(resolved.skipReason).toBeNull();
  });

  it("reads a DELEGATED provider's truth from the delegate, not from the waiting job", () => {
    // The Phase-10 job says WAITING_ON_DELEGATE, which is a fact about the job.
    // The work's real state lives in the canonical IOC row.
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: { status: "SUCCESS", expiresAt: new Date("2026-08-13T00:00:00.000Z") },
      }),
      ASOF
    );

    expect(resolved.status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(resolved.source).toBe(SUMMARY_SOURCES.IOC_ENRICHMENT);
    expect(resolved.isStale).toBe(false);
    expect(resolved.evidenceAvailable).toBe(true);
  });

  it("treats an expired answer as stale, and stale as NOT evidence", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: { status: "SUCCESS", expiresAt: new Date("2026-08-11T00:00:00.000Z") },
      }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(resolved.isStale).toBe(true);
    // A record of what was true once is not current evidence.
    expect(resolved.evidenceAvailable).toBe(false);
  });

  it("never turns a dead-lettered delegate into 'nothing found'", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: { status: "DEAD_LETTER", expiresAt: null },
      }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.UNAVAILABLE);
    expect(resolved.evidenceAvailable).toBe(false);
  });

  it("falls back to the orchestration job for a DIRECT provider", () => {
    const resolved = resolveSubjectState(eligibleItem({ state: JOB_STATES.PENDING }), ASOF);
    expect(resolved.status).toBe(SUMMARY_STATUSES.PENDING);
    expect(resolved.source).toBe(SUMMARY_SOURCES.ORCHESTRATION_JOB);
  });

  it("distinguishes a direct positive answer from a direct nothing-on-file answer (guarantee 1)", () => {
    const positive = resolveSubjectState(eligibleItem({ state: JOB_STATES.SUCCEEDED }), ASOF);
    expect(positive.status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(positive.evidenceAvailable).toBe(true);

    const nothingOnFile = resolveSubjectState(eligibleItem({ state: JOB_STATES.NO_RECORD }), ASOF);
    expect(nothingOnFile.status).toBe(SUMMARY_STATUSES.NO_RECORD);
    expect(nothingOnFile.evidenceAvailable).toBe(false);
  });

  it("distinguishes IOC SUCCESS from IOC NOT_FOUND (guarantee 2)", () => {
    const success = resolveSubjectState(
      eligibleItem({ state: JOB_STATES.WAITING_ON_DELEGATE, iocEnrichment: { status: "SUCCESS", expiresAt: null } }),
      ASOF
    );
    expect(success.status).toBe(SUMMARY_STATUSES.COMPLETED);

    const notFound = resolveSubjectState(
      eligibleItem({ state: JOB_STATES.WAITING_ON_DELEGATE, iocEnrichment: { status: "NOT_FOUND", expiresAt: null } }),
      ASOF
    );
    expect(notFound.status).toBe(SUMMARY_STATUSES.NO_RECORD);
    expect(notFound.evidenceAvailable).toBe(false);
  });

  it("never claims evidenceAvailable for VULNERABILITY_ENRICHMENT merely from job completion (gate P1-1)", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        vulnerabilityEnrichmentJob: { status: "COMPLETED" },
      }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(resolved.source).toBe(SUMMARY_SOURCES.VULNERABILITY_ENRICHMENT);
    // COMPLETED here means only "the batch finished this CVE" — this layer
    // never read VulnerabilityProviderStatus, so it cannot claim evidence.
    expect(resolved.evidenceAvailable).toBe(false);
  });

  it("lets a terminal Phase-10 job outrank a non-terminal delegate, reporting source ORCHESTRATION_JOB (gate P2, closes defect 6)", () => {
    // The runner dead-lettered the Phase-10 job on AMBIGUOUS_AFTER_CONTACT but
    // deliberately left the delegate row PENDING (it still holds the live
    // claim). Reading the delegate here would report a charged,
    // manual-review job as PENDING forever.
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.DEAD_LETTER,
        terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT",
        iocEnrichment: { status: "PENDING", expiresAt: null },
      }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.AMBIGUOUS);
    expect(resolved.source).toBe(SUMMARY_SOURCES.ORCHESTRATION_JOB);
    expect(resolved.evidenceAvailable).toBe(false);
  });

  it("leaves the delegate authoritative while the job is still non-terminal", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: { status: "PENDING", expiresAt: null },
      }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.PENDING);
    expect(resolved.source).toBe(SUMMARY_SOURCES.IOC_ENRICHMENT);
  });

  it("leaves the delegate authoritative once both job and delegate are terminal", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.SUCCEEDED,
        iocEnrichment: { status: "SUCCESS", expiresAt: null },
      }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(resolved.source).toBe(SUMMARY_SOURCES.IOC_ENRICHMENT);
  });

  it("distinguishes a recognized rate limit from a generic direct failure (guarantee 7)", () => {
    const resolved = resolveSubjectState(
      eligibleItem({ state: JOB_STATES.FAILED, errorCode: "PROVIDER_RATE_LIMITED" }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.RATE_LIMITED);
    expect(resolved.evidenceAvailable).toBe(false);
  });

  it("distinguishes a recognized rate limit on the delegated IOC path too (guarantee 7)", () => {
    const resolved = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: { status: "RATE_LIMITED", expiresAt: null },
      }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.RATE_LIMITED);
    expect(resolved.source).toBe(SUMMARY_SOURCES.IOC_ENRICHMENT);
    expect(resolved.evidenceAvailable).toBe(false);
  });

  it("distinguishes post-contact ambiguity from a generic direct failure (guarantee 6)", () => {
    const resolved = resolveSubjectState(
      eligibleItem({ state: JOB_STATES.DEAD_LETTER, terminalReasonCode: "AMBIGUOUS_AFTER_CONTACT" }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.AMBIGUOUS);

    const ordinaryFailure = resolveSubjectState(eligibleItem({ state: JOB_STATES.FAILED, errorCode: null }), ASOF);
    expect(ordinaryFailure.status).toBe(SUMMARY_STATUSES.UNAVAILABLE);
  });

  it("names a layer-correct closed reason for every execution-time skip (guarantee 8)", () => {
    const jobBudgetSkip = resolveSubjectState(eligibleItem({ state: JOB_STATES.SKIPPED_BUDGET }), ASOF);
    expect(jobBudgetSkip.status).toBe(SUMMARY_STATUSES.SKIPPED);
    expect(jobBudgetSkip.skipReason).toBe(EXECUTION_SKIP_REASONS.EXECUTION_BUDGET_EXHAUSTED);

    const jobDisabledSkip = resolveSubjectState(eligibleItem({ state: JOB_STATES.SKIPPED_DISABLED }), ASOF);
    expect(jobDisabledSkip.skipReason).toBe(EXECUTION_SKIP_REASONS.EXECUTION_DISABLED);

    // The two IOC-derived skips (defect 4).
    const iocUnsupported = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: { status: "UNSUPPORTED_INDICATOR", expiresAt: null },
      }),
      ASOF
    );
    expect(iocUnsupported.status).toBe(SUMMARY_STATUSES.SKIPPED);
    expect(iocUnsupported.skipReason).toBe(EXECUTION_SKIP_REASONS.EXECUTION_UNSUPPORTED_SUBJECT);

    const iocDisabled = resolveSubjectState(
      eligibleItem({
        state: JOB_STATES.WAITING_ON_DELEGATE,
        iocEnrichment: { status: "SKIPPED_DISABLED", expiresAt: null },
      }),
      ASOF
    );
    expect(iocDisabled.skipReason).toBe(EXECUTION_SKIP_REASONS.EXECUTION_DISABLED);
  });

  it("never turns a stale nothing-on-file answer into stale evidence (guarantee 11)", () => {
    const resolved = resolveSubjectState(
      eligibleItem({ state: JOB_STATES.NO_RECORD, freshUntil: new Date("2026-08-11T00:00:00.000Z") }),
      ASOF
    );
    expect(resolved.status).toBe(SUMMARY_STATUSES.NO_RECORD);
    expect(resolved.isStale).toBe(true);
    expect(resolved.evidenceAvailable).toBe(false);
  });
});

describe("SUMMARY_STATUS_PRECEDENCE completeness (guarantee 10)", () => {
  it("ranks exactly the same set of statuses SUMMARY_STATUSES defines", () => {
    expect(new Set(SUMMARY_STATUS_PRECEDENCE)).toEqual(new Set(Object.values(SUMMARY_STATUSES)));
    expect(SUMMARY_STATUS_PRECEDENCE.length).toBe(Object.values(SUMMARY_STATUSES).length);
  });
});

describe("rolling several CVE subjects into one provider row", () => {
  it("is pessimistic: one unfinished subject means the provider is not finished", () => {
    const done = { status: SUMMARY_STATUSES.COMPLETED, source: SUMMARY_SOURCES.ORCHESTRATION_JOB, freshUntil: null, isStale: false, evidenceAvailable: true };
    const pending = { ...done, status: SUMMARY_STATUSES.PENDING, evidenceAvailable: false };

    expect(rollUp([done, done]).status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(rollUp([done, done]).evidenceAvailable).toBe(true);

    // Two of three answered is not "NVD: completed".
    expect(rollUp([done, pending, done]).status).toBe(SUMMARY_STATUSES.PENDING);
    expect(rollUp([done, pending, done]).evidenceAvailable).toBe(false);
  });

  it("reports the EARLIEST freshness horizon and any staleness", () => {
    const early = new Date("2026-09-01T00:00:00.000Z");
    const late = new Date("2026-12-01T00:00:00.000Z");
    const row = (freshUntil, isStale) => ({
      status: SUMMARY_STATUSES.COMPLETED,
      source: SUMMARY_SOURCES.ORCHESTRATION_JOB,
      freshUntil,
      isStale,
      evidenceAvailable: !isStale,
    });

    const rolled = rollUp([row(late, false), row(early, false)]);
    expect(rolled.freshUntil.getTime()).toBe(early.getTime());
    expect(rollUp([row(late, false), row(early, true)]).isStale).toBe(true);
  });
});

describe("the whole summary", () => {
  it("rejects a bad finding id and a missing asOf before touching the database", async () => {
    await expect(getFindingEnrichmentSummary(0, { client: fakeClient({}), asOf: ASOF })).rejects.toBeInstanceOf(
      EnrichmentSummaryValidationError
    );
    await expect(getFindingEnrichmentSummary(1, { client: fakeClient({}) })).rejects.toBeInstanceOf(
      EnrichmentSummaryValidationError
    );
  });

  it("reports a missing Finding as not found", async () => {
    await expect(
      getFindingEnrichmentSummary(404, { client: fakeClient({}), asOf: ASOF })
    ).rejects.toBeInstanceOf(EnrichmentSummaryNotFoundError);
  });

  it("emits one row per known provider, every one timestamped", async () => {
    const summary = await getFindingEnrichmentSummary(1, {
      client: fakeClient({}),
      asOf: ASOF,
    });
    expect(summary.providers).toHaveLength(6);
    // eslint-disable-next-line no-restricted-syntax
    for (const row of summary.providers) {
      expect(row.asOf).toBe(ASOF);
    }
    expect(summary.providers.map((row) => row.purpose)).toEqual([
      "IOC_REPUTATION", // abuseipdb
      "EXPOSURE", // censys
      "IOC_REPUTATION", // greynoise
      "EXPOSURE", // netlas
      "VULNERABILITY", // nvd — a separate path, never folded into reputation
      "EXPOSURE", // shodan
    ]);
  });

  it("shows NVD as considered-with-no-subject when no verified CVE exists", async () => {
    const summary = await getFindingEnrichmentSummary(1, {
      client: fakeClient({ cves: [] }),
      asOf: ASOF,
    });
    const nvd = summary.providers.find((row) => row.provider === "nvd");

    expect(nvd.status).toBe(SUMMARY_STATUSES.NO_SUBJECT);
    expect(nvd.skipReason).toBe(SKIP_REASONS.NO_SUBJECT_FOR_PROVIDER);
    expect(nvd.subjects).toEqual([]);
    // AN IP MUST NEVER BECOME AN NVD SUBJECT.
    expect(JSON.stringify(nvd)).not.toContain(INDICATOR);
  });

  it("gives three verified CVEs three NVD sub-rows, never one collapsed subject", async () => {
    const cves = ["CVE-2099-1001", "CVE-2099-1002", "CVE-2099-1003"];
    const summary = await getFindingEnrichmentSummary(1, {
      client: fakeClient({
        cves,
        items: {
          "nvd|CVE-2099-1001": eligibleItem({
            state: JOB_STATES.WAITING_ON_DELEGATE,
            vulnerabilityEnrichmentJob: { status: "COMPLETED" },
          }),
          "nvd|CVE-2099-1002": eligibleItem({
            state: JOB_STATES.WAITING_ON_DELEGATE,
            vulnerabilityEnrichmentJob: { status: "PENDING" },
          }),
        },
      }),
      asOf: ASOF,
    });
    const nvd = summary.providers.find((row) => row.provider === "nvd");

    expect(nvd.subjects.map((subject) => subject.subjectValue)).toEqual(cves);
    expect(nvd.subjects[0].status).toBe(SUMMARY_STATUSES.COMPLETED);
    expect(nvd.subjects[0].source).toBe(SUMMARY_SOURCES.VULNERABILITY_ENRICHMENT);
    expect(nvd.subjects[1].status).toBe(SUMMARY_STATUSES.PENDING);
    // The third was never asked about — and that is a different fact from
    // having no subject.
    expect(nvd.subjects[2].status).toBe(SUMMARY_STATUSES.NOT_REQUESTED);
    // The provider row is not "completed" while one subject is outstanding.
    expect(nvd.status).toBe(SUMMARY_STATUSES.PENDING);
    expect(nvd.evidenceAvailable).toBe(false);
  });

  it("scopes every read to the requested Finding", async () => {
    // findFirst is keyed on findingId by the repository; this asserts the
    // service passes it, so one Finding's item can never answer another's row.
    const seen = [];
    const client = fakeClient({ finding: { id: 42, indicatorValue: INDICATOR } });
    client.findingEnrichmentRunItem.findFirst = async ({ where }) => {
      seen.push(where.findingId);
      return null;
    };
    await getFindingEnrichmentSummary(42, { client, asOf: ASOF });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([42]));
  });
});
