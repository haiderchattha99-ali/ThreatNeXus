import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// Phase 5 invariants against a REAL PostgreSQL engine.
//
// The unit suites prove the logic against an in-memory fake. This file proves
// the two things a fake cannot: that PostgreSQL's own constraints hold under
// genuine concurrency, and that the distinct-NULLs current-row mechanism
// behaves the way the design assumes.
//
// ---------------------------------------------------------------------------
// Separate, pre-connected PrismaClients — not Promise.all on one client
// ---------------------------------------------------------------------------
// DURABLE TRAP, measured directly in this repository during Phase 2: Promise.all
// over ONE shared PrismaClient does NOT prove a database concurrency invariant.
// Its connection pool serialises enough of the work to hide the race, so the
// test passes against an implementation with no invariant at all. Every racing
// test below uses SEPARATE clients, $connect()ed up front.
//
// Self-skips without TEST_DATABASE_URL so a bare checkout stays green.

const { PrismaClient } = require("@prisma/client");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

// config/env validates at require time even though every call below passes an
// explicit {client}. Staged only for variables not already set.
process.env.DATABASE_URL = process.env.DATABASE_URL || TEST_DATABASE_URL || "postgresql://u:p@localhost:5432/unused";
process.env.JWT_SECRET = process.env.JWT_SECRET || "a-reasonably-strong-32-char-plus-secret-value";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const mappingService = require("../../src/services/framework/frameworkMappingService");
const aiService = require("../../src/services/ai/aiSuggestionService");
const decisionService = require("../../src/services/ai/aiSuggestionDecisionService");
const { buildAiRuntime } = require("../../src/services/ai/aiRuntime");
const { MOCK_SCENARIOS } = require("../../src/services/ai/mockAiMappingProvider");
const { DECISION_OUTCOME_CODES } = require("../../src/services/ai/aiSuggestionRules");

// RFC 2544 benchmarking range, second octet 25 — distinct from 198.18/19
// (phase2), 198.20/21 (enrichment), 198.22 (phase3), 198.23 (phase4) and every
// RFC 5737 range already claimed, so a shared test database can never let this
// suite's cleanup collide with another's rows.
const MARKER = "p5-concurrency";
const NET = "198.25";
const RACERS = 6;

const T = (hour) => new Date(`2026-08-05T${String(hour).padStart(2, "0")}:00:00.000Z`);

const OBSERVED_BEHAVIOUR_RATIONALE =
  "The constituent supplied Windows security event logs showing repeated failed interactive logon " +
  "attempts from one external source, followed by a successful authentication and an established " +
  "remote session outside business hours that the account owner did not perform.";

const NIST = {
  framework: "NIST_CSF",
  frameworkVersion: "2.0",
  referenceId: "PR.AA-01",
  referenceTitle: "Identities and credentials are managed",
  mappingScope: "CASE",
  evidenceBasis: "CONTROL_GAP",
  rationale:
    "Administrative remote access is reachable from any network, indicating access permissions " +
    "are not constrained to authorised sources.",
};

let prisma;
let racers = [];
let ORG_ID;
let ACTOR_ID;

function newClient() {
  return new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
}

async function cleanup(client) {
  const cases = await client.case.findMany({
    where: { organization: { startsWith: MARKER } },
    select: { id: true },
  });
  const caseIds = cases.map((row) => row.id);
  const findings = await client.finding.findMany({
    where: { indicatorValue: { startsWith: `${NET}.` } },
    select: { id: true },
  });
  const findingIds = findings.map((row) => row.id);

  const suggestions = await client.aiFrameworkMappingSuggestion.findMany({
    where: { caseId: { in: caseIds } },
    select: { id: true },
  });
  const suggestionIds = suggestions.map((row) => row.id);

  await client.aiSuggestionDecision.deleteMany({ where: { suggestionId: { in: suggestionIds } } });
  // promotedMappingId is Restrict onto the mapping, so it is released before
  // the mappings themselves are removed — the same ordering the Phase 4 gate
  // uses for the approval projection.
  await client.aiFrameworkMappingSuggestion.updateMany({
    where: { id: { in: suggestionIds } },
    data: { promotedMappingId: null },
  });
  await client.aiFrameworkMappingSuggestion.deleteMany({ where: { id: { in: suggestionIds } } });
  await client.aiSuggestionRun.deleteMany({ where: { caseId: { in: caseIds } } });
  await client.caseFrameworkMapping.deleteMany({ where: { caseId: { in: caseIds } } });

  await client.caseLifecycleEvent.deleteMany({ where: { caseId: { in: caseIds } } });
  await client.caseFinding.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await client.findingTriage.deleteMany({
    where: { OR: [{ caseId: { in: caseIds } }, { findingId: { in: findingIds } }] },
  });
  await client.case.deleteMany({ where: { id: { in: caseIds } } });
  await client.findingOwnership.deleteMany({ where: { findingId: { in: findingIds } } });
  await client.finding.deleteMany({ where: { id: { in: findingIds } } });
  await client.organization.deleteMany({ where: { name: { startsWith: MARKER } } });
  await client.user.deleteMany({ where: { email: { startsWith: MARKER } } });
}

// One organization-bound case with one linked Finding.
async function makeCase(label, octet) {
  const finding = await prisma.finding.create({
    data: {
      indicatorValue: `${NET}.0.${octet}`,
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      status: "OPEN",
      firstSeen: T(1),
      lastSeen: T(1),
      occurrenceCount: 2,
      recurrenceCount: 0,
    },
  });

  const record = await prisma.case.create({
    data: {
      title: `${MARKER} accessible RDP ${label}`,
      threatType: "Accessible RDP",
      organization: `${MARKER}-org`,
      analyst: `${MARKER}-analyst`,
      organizationId: ORG_ID,
      lifecycleState: "OPEN",
      caseReference: `TNX-2026-96${String(octet).padStart(4, "0")}`,
      createdAt: T(1),
    },
  });

  await prisma.caseFinding.create({
    data: {
      caseId: record.id,
      findingId: finding.id,
      state: "LINKED",
      organizationId: ORG_ID,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: T(1),
      supersededAt: null,
      currentLinkKey: `${record.id}:${finding.id}`,
    },
  });

  return { caseRecord: record, finding };
}

const mockRuntime = (scenario) =>
  buildAiRuntime({
    env: { AI_ENABLED: true, AI_PROVIDER: "mock" },
    allowMockProvider: true,
    providerConfig: { scenario },
  });

describeIfDb("Phase 5 framework mapping against real PostgreSQL", () => {
  beforeAll(async () => {
    prisma = newClient();
    await prisma.$connect();
    racers = Array.from({ length: RACERS }, () => newClient());
    await Promise.all(racers.map((client) => client.$connect()));
    await cleanup(prisma);

    const organization = await prisma.organization.create({
      data: {
        name: `${MARKER}-org`,
        industry: "synthetic",
        location: "synthetic",
        contactPerson: "Synthetic Contact",
        email: `${MARKER}-org@example.test`,
        sector: "FINANCE",
      },
    });
    ORG_ID = organization.id;

    const actor = await prisma.user.create({
      data: {
        name: `${MARKER}-analyst`,
        email: `${MARKER}-analyst@example.test`,
        password: "$2b$10$synthetic.test.placeholder.hash.not.a.real.secret",
        role: "ANALYST",
      },
    });
    ACTOR_ID = actor.id;
  }, 60000);

  afterAll(async () => {
    if (!prisma) return;
    await cleanup(prisma).catch(() => {});
    await Promise.all(racers.map((client) => client.$disconnect().catch(() => {})));
    await prisma.$disconnect();
  }, 60000);

  // Mappings cannot be removed while a suggestion still points at one:
  // AiFrameworkMappingSuggestion.promotedMappingId is Restrict, deliberately,
  // so the record of "this human promoted that suggestion into that mapping"
  // cannot be silently orphaned. The per-test reset therefore releases the
  // link and removes the suggestion side FIRST, in the same order cleanup()
  // uses. (Getting this wrong is how this comment came to exist — the FK
  // refused the delete, which is exactly what it is for.)
  beforeEach(async () => {
    const caseIds = (
      await prisma.case.findMany({
        where: { organization: { startsWith: MARKER } },
        select: { id: true },
      })
    ).map((row) => row.id);
    if (caseIds.length === 0) return;

    const suggestionIds = (
      await prisma.aiFrameworkMappingSuggestion.findMany({
        where: { caseId: { in: caseIds } },
        select: { id: true },
      })
    ).map((row) => row.id);

    await prisma.aiSuggestionDecision.deleteMany({
      where: { suggestionId: { in: suggestionIds } },
    });
    await prisma.aiFrameworkMappingSuggestion.updateMany({
      where: { id: { in: suggestionIds } },
      data: { promotedMappingId: null },
    });
    await prisma.aiFrameworkMappingSuggestion.deleteMany({ where: { id: { in: suggestionIds } } });
    await prisma.aiSuggestionRun.deleteMany({ where: { caseId: { in: caseIds } } });
    await prisma.caseFrameworkMapping.deleteMany({ where: { caseId: { in: caseIds } } });
  });

  it("1. holds exactly one current row per (case, framework, scope, reference)", async () => {
    const { caseRecord } = await makeCase("one-current", 11);

    await mappingService.createManualMapping(caseRecord.id, NIST, {
      client: prisma,
      actorUserId: ACTOR_ID,
      effectiveAt: T(2),
    });
    const created = await prisma.caseFrameworkMapping.findFirst({
      where: { caseId: caseRecord.id },
    });

    await mappingService.removeMapping(caseRecord.id, created.id, {
      client: prisma,
      actorUserId: ACTOR_ID,
      effectiveAt: T(3),
      reason: "withdrawn pending reassessment",
    });
    await mappingService.createManualMapping(caseRecord.id, NIST, {
      client: prisma,
      actorUserId: ACTOR_ID,
      effectiveAt: T(4),
    });

    const rows = await prisma.caseFrameworkMapping.findMany({
      where: { caseId: caseRecord.id },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.state)).toEqual(["ACTIVE", "REMOVED", "ACTIVE"]);
    expect(rows.filter((row) => row.currentMappingKey !== null)).toHaveLength(1);
    // The superseded rows keep their own content; only the two supersession
    // columns changed.
    expect(rows[0].rationale).toBe(NIST.rationale);
    expect(rows[0].supersededAt).not.toBeNull();
  });

  // The distinct-NULLs mechanism is what makes unlimited history coexist with
  // one current row, with no partial index and no raw SQL.
  it("2. lets unlimited superseded rows coexist under one unique column", async () => {
    const { caseRecord } = await makeCase("many-history", 12);

    for (let round = 0; round < 5; round += 1) {
      // eslint-disable-next-line no-await-in-loop
      await mappingService.createManualMapping(caseRecord.id, NIST, {
        client: prisma,
        actorUserId: ACTOR_ID,
        effectiveAt: T(2 + round * 2),
      });
      // eslint-disable-next-line no-await-in-loop
      const current = await prisma.caseFrameworkMapping.findFirst({
        where: { caseId: caseRecord.id, currentMappingKey: { not: null } },
      });
      // eslint-disable-next-line no-await-in-loop
      await mappingService.removeMapping(caseRecord.id, current.id, {
        client: prisma,
        actorUserId: ACTOR_ID,
        effectiveAt: T(3 + round * 2),
        reason: `withdrawn round ${round}`,
      });
    }

    const rows = await prisma.caseFrameworkMapping.findMany({ where: { caseId: caseRecord.id } });
    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.currentMappingKey !== null)).toHaveLength(1);
    expect(rows.filter((row) => row.currentMappingKey === null)).toHaveLength(9);
  });

  it(
    "3. keeps exactly one current row when six separate clients create the same mapping at once",
    async () => {
      const { caseRecord } = await makeCase("racing-create", 13);

      const results = await Promise.allSettled(
        racers.map((client) =>
          mappingService.createManualMapping(caseRecord.id, NIST, {
            client,
            actorUserId: ACTOR_ID,
            effectiveAt: T(2),
          })
        )
      );

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThan(0);

      const rows = await prisma.caseFrameworkMapping.findMany({
        where: { caseId: caseRecord.id },
      });
      // Exactly one ACTIVE row survives as current, whatever the interleaving.
      expect(rows.filter((row) => row.currentMappingKey !== null)).toHaveLength(1);
      // And the winners that reported UNCHANGED wrote nothing at all.
      const changed = fulfilled.filter((result) => result.value.changed);
      expect(rows).toHaveLength(changed.length);
      expect(changed.length).toBeGreaterThanOrEqual(1);
    },
    60000
  );

  it(
    "4. never promotes one suggestion into two mappings under concurrent approval",
    async () => {
      const { caseRecord } = await makeCase("racing-approve", 14);

      const { suggestions } = await aiService.requestMappingSuggestions(caseRecord.id, {
        client: prisma,
        actorUserId: ACTOR_ID,
        runtime: mockRuntime(MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS),
        requestedAt: T(5),
      });
      expect(suggestions.length).toBeGreaterThan(0);
      const target = suggestions[0];

      const results = await Promise.allSettled(
        racers.map((client) =>
          decisionService.approveSuggestion(caseRecord.id, target.id, {
            client,
            actorUserId: ACTOR_ID,
            decidedAt: T(6),
          })
        )
      );

      const fulfilled = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      const promoted = fulfilled.filter(
        (value) => value.outcome === DECISION_OUTCOME_CODES.APPROVED_AND_PROMOTED
      );

      // At most ONE racer may promote. The rest see ALREADY_DECIDED_UNCHANGED.
      expect(promoted.length).toBeLessThanOrEqual(1);

      const mappings = await prisma.caseFrameworkMapping.findMany({
        where: { caseId: caseRecord.id, source: "AI_SUGGESTION_PROMOTED" },
      });
      expect(mappings).toHaveLength(1);

      const stored = await prisma.aiFrameworkMappingSuggestion.findUnique({
        where: { id: target.id },
      });
      expect(stored.state).toBe("APPROVED");
      expect(stored.promotedMappingId).toBe(mappings[0].id);
      // The human is recorded, never a provider.
      expect(mappings[0].actorUserId).toBe(ACTOR_ID);
    },
    60000
  );

  it(
    "5. records every decision attempt while creating only one mapping",
    async () => {
      const { caseRecord } = await makeCase("decision-ledger", 15);

      const { suggestions } = await aiService.requestMappingSuggestions(caseRecord.id, {
        client: prisma,
        actorUserId: ACTOR_ID,
        runtime: mockRuntime(MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS),
        requestedAt: T(5),
      });
      const target = suggestions[0];

      await decisionService.approveSuggestion(caseRecord.id, target.id, {
        client: prisma,
        actorUserId: ACTOR_ID,
        decidedAt: T(6),
      });
      await decisionService.approveSuggestion(caseRecord.id, target.id, {
        client: prisma,
        actorUserId: ACTOR_ID,
        decidedAt: T(7),
      });
      await decisionService.approveSuggestion(caseRecord.id, target.id, {
        client: prisma,
        actorUserId: ACTOR_ID,
        decidedAt: T(8),
      });

      const decisions = await prisma.aiSuggestionDecision.findMany({
        where: { suggestionId: target.id },
        orderBy: { id: "asc" },
      });
      // Three attempts, three ledger rows, one mapping.
      expect(decisions).toHaveLength(3);
      expect(decisions[0].outcomeCode).toBe(DECISION_OUTCOME_CODES.APPROVED_AND_PROMOTED);
      expect(decisions[1].outcomeCode).toBe(DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED);
      expect(decisions[2].outcomeCode).toBe(DECISION_OUTCOME_CODES.ALREADY_DECIDED_UNCHANGED);

      const mappings = await prisma.caseFrameworkMapping.findMany({
        where: { caseId: caseRecord.id, source: "AI_SUGGESTION_PROMOTED" },
      });
      expect(mappings).toHaveLength(1);
    },
    60000
  );

  it("6. enforces Restrict on cited Finding evidence", async () => {
    const { caseRecord, finding } = await makeCase("restrict-evidence", 16);

    await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "CIS_CONTROLS",
        frameworkVersion: "v8",
        referenceId: "4.6",
        referenceTitle: "Securely Manage Enterprise Assets and Software",
        mappingScope: "FINDING",
        evidenceBasis: "REMEDIATION_ALIGNMENT",
        rationale: "Remediation places remote management behind a VPN, aligning with 4.6.",
        evidenceFindingId: finding.id,
      },
      { client: prisma, actorUserId: ACTOR_ID, effectiveAt: T(2) }
    );

    // A mapping's cited evidence must never be orphaned by deleting the
    // Finding it rests on.
    await expect(prisma.finding.delete({ where: { id: finding.id } })).rejects.toThrow();
  });

  it("7. enforces Restrict on the organization a mapping was made against", async () => {
    const { caseRecord } = await makeCase("restrict-org", 17);
    await mappingService.createManualMapping(caseRecord.id, NIST, {
      client: prisma,
      actorUserId: ACTOR_ID,
      effectiveAt: T(2),
    });

    await expect(prisma.organization.delete({ where: { id: ORG_ID } })).rejects.toThrow();
  });

  it("8. nulls the actor rather than destroying history when a user is deleted", async () => {
    const { caseRecord } = await makeCase("setnull-actor", 18);

    const temporary = await prisma.user.create({
      data: {
        name: `${MARKER}-temp`,
        email: `${MARKER}-temp@example.test`,
        password: "$2b$10$synthetic.test.placeholder.hash.not.a.real.secret",
        role: "ANALYST",
      },
    });

    await mappingService.createManualMapping(caseRecord.id, NIST, {
      client: prisma,
      actorUserId: temporary.id,
      effectiveAt: T(2),
    });

    await prisma.user.delete({ where: { id: temporary.id } });

    const row = await prisma.caseFrameworkMapping.findFirst({ where: { caseId: caseRecord.id } });
    expect(row).not.toBeNull();
    expect(row.actorUserId).toBeNull();
    // The mapping itself survives intact — only the attribution is nulled.
    expect(row.state).toBe("ACTIVE");
    expect(row.rationale).toBe(NIST.rationale);
  });

  it(
    "9. refuses a stale approval after real evidence changes, and writes nothing",
    async () => {
      const { caseRecord } = await makeCase("stale-approval", 19);

      const { suggestions } = await aiService.requestMappingSuggestions(caseRecord.id, {
        client: prisma,
        actorUserId: ACTOR_ID,
        runtime: mockRuntime(MOCK_SCENARIOS.VALID_ATTACK_MAPPING),
        requestedAt: T(5),
      });
      const target = suggestions[0];

      // A real evidence change: a new mapping enters the bounded snapshot.
      await mappingService.createManualMapping(caseRecord.id, NIST, {
        client: prisma,
        actorUserId: ACTOR_ID,
        effectiveAt: T(6),
      });

      let thrown;
      try {
        await decisionService.approveSuggestion(caseRecord.id, target.id, {
          client: prisma,
          actorUserId: ACTOR_ID,
          decidedAt: T(7),
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeDefined();
      expect(thrown.code).toBe("SUGGESTION_STALE");

      const promoted = await prisma.caseFrameworkMapping.findMany({
        where: { caseId: caseRecord.id, source: "AI_SUGGESTION_PROMOTED" },
      });
      expect(promoted).toHaveLength(0);
      const stored = await prisma.aiFrameworkMappingSuggestion.findUnique({
        where: { id: target.id },
      });
      expect(stored.state).toBe("PENDING");
    },
    60000
  );

  it("10. writes no suggestion row at all when AI is disabled", async () => {
    const { caseRecord } = await makeCase("disabled", 20);

    const { run } = await aiService.requestMappingSuggestions(caseRecord.id, {
      client: prisma,
      actorUserId: ACTOR_ID,
      runtime: buildAiRuntime({ env: { AI_ENABLED: false, AI_PROVIDER: "null" } }),
      requestedAt: T(5),
    });

    expect(run.status).toBe("DISABLED");
    expect(run.reasonCode).toBe("AI_DISABLED");

    const suggestions = await prisma.aiFrameworkMappingSuggestion.findMany({
      where: { caseId: caseRecord.id },
    });
    expect(suggestions).toHaveLength(0);
    // The run itself IS durable — "we asked and it was off" stays answerable.
    const runs = await prisma.aiSuggestionRun.findMany({ where: { caseId: caseRecord.id } });
    expect(runs).toHaveLength(1);
  });

  it("11. never persists a rejected candidate", async () => {
    const { caseRecord } = await makeCase("all-invalid", 21);

    const { run } = await aiService.requestMappingSuggestions(caseRecord.id, {
      client: prisma,
      actorUserId: ACTOR_ID,
      runtime: mockRuntime(MOCK_SCENARIOS.ALL_INVALID),
      requestedAt: T(5),
    });

    expect(run.status).toBe("COMPLETED");
    expect(run.suggestionCount).toBe(0);
    expect(run.rejectedCount).toBeGreaterThan(0);
    expect(run.reasonCode).toBe("ALL_CANDIDATES_REJECTED");

    const suggestions = await prisma.aiFrameworkMappingSuggestion.findMany({
      where: { caseId: caseRecord.id },
    });
    expect(suggestions).toHaveLength(0);
  });

  it("12. leaves Risk v1 rows untouched across a full generate-and-approve cycle", async () => {
    const { caseRecord, finding } = await makeCase("risk-untouched", 22);

    const score = await prisma.riskScore.create({
      data: {
        findingId: finding.id,
        algorithmVersion: "risk-additive-bucketed-v1",
        configurationVersion: "v1.0.0",
        configurationFingerprint: `${MARKER}-cfg`,
        inputFingerprint: `${MARKER}-input`,
        scoreBasisPoints: 6100,
        riskBand: "HIGH",
        asOf: T(1),
        calculatedAt: T(1),
        trigger: "INGESTION",
        currentForFindingId: finding.id,
      },
    });

    const { suggestions } = await aiService.requestMappingSuggestions(caseRecord.id, {
      client: prisma,
      actorUserId: ACTOR_ID,
      runtime: mockRuntime(MOCK_SCENARIOS.VALID_CONTROL_MAPPINGS),
      requestedAt: T(5),
    });
    await decisionService.approveSuggestion(caseRecord.id, suggestions[0].id, {
      client: prisma,
      actorUserId: ACTOR_ID,
      decidedAt: T(6),
    });

    const after = await prisma.riskScore.findUnique({ where: { id: score.id } });
    expect(after.scoreBasisPoints).toBe(6100);
    expect(after.riskBand).toBe("HIGH");
    expect(after.supersededAt).toBeNull();
    expect(after.currentForFindingId).toBe(finding.id);

    const allScores = await prisma.riskScore.findMany({ where: { findingId: finding.id } });
    expect(allScores).toHaveLength(1);

    await prisma.riskScore.delete({ where: { id: score.id } });
  });

  it("13. accepts a genuine ATT&CK observed-behaviour mapping and stores it verbatim", async () => {
    const { caseRecord, finding } = await makeCase("attack-accepted", 23);

    const outcome = await mappingService.createManualMapping(
      caseRecord.id,
      {
        framework: "MITRE_ATTACK",
        frameworkVersion: "v17.1",
        referenceId: "T1110.001",
        referenceTitle: "Brute Force: Password Guessing",
        mappingScope: "FINDING",
        evidenceBasis: "OBSERVED_BEHAVIOR",
        rationale: OBSERVED_BEHAVIOUR_RATIONALE,
        evidenceFindingId: finding.id,
      },
      { client: prisma, actorUserId: ACTOR_ID, effectiveAt: T(2) }
    );

    expect(outcome.outcome).toBe("CREATED");
    const row = await prisma.caseFrameworkMapping.findUnique({
      where: { id: outcome.mapping.id },
    });
    expect(row.framework).toBe("MITRE_ATTACK");
    expect(row.evidenceBasis).toBe("OBSERVED_BEHAVIOR");
    expect(row.rationale).toBe(OBSERVED_BEHAVIOUR_RATIONALE);
    expect(row.evidenceFindingId).toBe(finding.id);
  });

  it("14. refuses an exposure-only ATT&CK mapping and writes nothing", async () => {
    const { caseRecord } = await makeCase("attack-refused", 24);

    await expect(
      mappingService.createManualMapping(
        caseRecord.id,
        {
          framework: "MITRE_ATTACK",
          frameworkVersion: "v17.1",
          referenceId: "T1021.001",
          referenceTitle: "Remote Services: Remote Desktop Protocol",
          mappingScope: "CASE",
          evidenceBasis: "OBSERVED_BEHAVIOR",
          rationale:
            "Port 3389 is exposed, CVE-2019-0708 applies, KEV lists it, the EPSS score is high " +
            "and the AbuseIPDB reputation score is elevated for this sector.",
        },
        { client: prisma, actorUserId: ACTOR_ID, effectiveAt: T(2) }
      )
    ).rejects.toThrow();

    const rows = await prisma.caseFrameworkMapping.findMany({ where: { caseId: caseRecord.id } });
    expect(rows).toHaveLength(0);
  });
});
