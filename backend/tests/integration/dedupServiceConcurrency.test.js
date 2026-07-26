import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";

// Real-PostgreSQL concurrency tests for the P1-T4 dedup service.
//
// These exist because a stubbed/in-memory Prisma client CANNOT model the two
// behaviours that matter most here:
//   1. a constraint violation aborts the surrounding PostgreSQL transaction
//      (SQLSTATE 25P02), so catching it and re-querying the same interactive
//      transaction is not a valid recovery mechanism; and
//   2. SERIALIZABLE conflict detection, which is what makes a plain
//      read-modify-write safe and keeps recurrenceCount at one increment per
//      real CLOSED -> OPEN transition.
//
// The suite self-skips unless TEST_DATABASE_URL is set, so the default
// `vitest run` stays green with no database and no backend/.env. Run it with a
// disposable database only, e.g.:
//   TEST_DATABASE_URL="postgresql://<user>:<pw>@localhost:5432/threatnexus_test?schema=public" npx vitest run tests/integration/dedupServiceConcurrency.test.js
//
// The URL is supplied by the environment and is never written to the
// repository or echoed by these tests.

const { PrismaClient } = require("@prisma/client");
const {
  recordFindingObservation,
} = require("../../src/services/normalization/dedupService");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Marker used to scope every row these tests create, so cleanup can never
// touch anything else in the database.
const MARKER = "p1t4-concurrency";
// TEST-NET-2 (RFC 5737) documentation addresses — one identity per scenario so
// scenarios cannot interfere with each other.
const IP = Object.freeze({
  newRace: "198.51.100.11",
  recurrence: "198.51.100.12",
  sameReport: "198.51.100.13",
  rollback: "198.51.100.14",
  outOfOrder: "198.51.100.15",
});
const ALL_IPS = Object.freeze(Object.values(IP));

const REPORT_TYPE = "ACCESSIBLE_RDP";
const PROTOCOL = "TCP";
const PORT = 3389;

let prisma;

function identityFor(indicatorValue) {
  return { reportType: REPORT_TYPE, indicatorValue, port: PORT, protocol: PROTOCOL };
}

async function makeRawReport(label, observationDate) {
  return prisma.rawReport.create({
    data: {
      reportType: REPORT_TYPE,
      schemaVersion: "accessible-rdp.synthetic.v1",
      sourceFileName: `${MARKER}-${label}.csv`,
      sourceFileSha256: crypto.createHash("sha256").update(`${MARKER}-${label}`).digest("hex"),
      fileSizeBytes: 1,
      contentType: "text/csv",
      rawContent: Buffer.from("synthetic", "utf8"),
      observationDate,
    },
  });
}

// Deterministic, marker-scoped cleanup. Order respects the Restrict FKs:
// occurrences (children) -> findings -> raw reports.
async function cleanup() {
  await prisma.findingOccurrence.deleteMany({
    where: { rawReport: { sourceFileName: { startsWith: MARKER } } },
  });
  await prisma.finding.deleteMany({ where: { indicatorValue: { in: ALL_IPS } } });
  await prisma.rawReport.deleteMany({ where: { sourceFileName: { startsWith: MARKER } } });
}

async function findingFor(indicatorValue) {
  return prisma.finding.findUnique({
    where: { finding_identity: identityFor(indicatorValue) },
  });
}

async function occurrencesFor(findingId) {
  return prisma.findingOccurrence.findMany({
    where: { findingId },
    orderBy: { id: "asc" },
  });
}

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

describeDb("dedupService — real PostgreSQL concurrency", () => {
  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (prisma) {
      await cleanup();
      await prisma.$disconnect();
    }
  });

  it("1. concurrent new-Finding race: one Finding, two occurrences, occurrenceCount = 2, no aborted-transaction error", async () => {
    const t1 = new Date("2026-03-01T00:00:00.000Z");
    const t2 = new Date("2026-03-02T00:00:00.000Z");
    const [reportA, reportB] = await Promise.all([
      makeRawReport("it1-a", t1),
      makeRawReport("it1-b", t2),
    ]);

    // Both callers race to create the same brand-new identity.
    const results = await Promise.all([
      recordFindingObservation(
        { ...identityFor(IP.newRace), rawReportId: reportA.id, observedAt: t1 },
        { client: prisma }
      ),
      recordFindingObservation(
        { ...identityFor(IP.newRace), rawReportId: reportB.id, observedAt: t2 },
        { client: prisma }
      ),
    ]);

    const findings = await prisma.finding.findMany({ where: { indicatorValue: IP.newRace } });
    expect(findings).toHaveLength(1);

    const occurrences = await occurrencesFor(findings[0].id);
    expect(occurrences).toHaveLength(2);
    expect(new Set(occurrences.map((o) => o.rawReportId))).toEqual(
      new Set([reportA.id, reportB.id])
    );

    expect(findings[0].occurrenceCount).toBe(2);
    expect(findings[0].recurrenceCount).toBe(0);
    expect(findings[0].status).toBe("OPEN");
    expect(findings[0].firstSeen).toEqual(t1);
    expect(findings[0].lastSeen).toEqual(t2);

    // Exactly one caller created the Finding; actions are consistent with the
    // order that actually committed.
    expect(results.filter((r) => r.findingCreated)).toHaveLength(1);
    const actions = results.map((r) => r.action).sort();
    expect(actions).toContain("CREATED");
    expect(actions.filter((a) => a === "CREATED")).toHaveLength(1);
    actions
      .filter((a) => a !== "CREATED")
      .forEach((a) => expect(["PERSISTED", "HISTORICAL"]).toContain(a));
  }, 60000);

  it("2. concurrent recurrence race: recurrenceCount = 1, never two RECURRED rows for one reopening", async () => {
    const seed = new Date("2026-03-01T00:00:00.000Z");
    const closedThrough = new Date("2026-03-05T00:00:00.000Z");
    const t1 = new Date("2026-03-10T00:00:00.000Z");
    const t2 = new Date("2026-03-11T00:00:00.000Z");

    const seedReport = await makeRawReport("it2-seed", seed);
    const created = await recordFindingObservation(
      { ...identityFor(IP.recurrence), rawReportId: seedReport.id, observedAt: seed },
      { client: prisma }
    );
    expect(created.action).toBe("CREATED");

    // Simulate a completed manual closure (no close endpoint exists yet).
    await prisma.finding.update({
      where: { id: created.finding.id },
      data: {
        status: "CLOSED",
        closedAt: new Date("2026-03-06T00:00:00.000Z"),
        closureReason: "remediated",
        closedThroughObservedAt: closedThrough,
        recurrenceCount: 0,
      },
    });

    const [reportA, reportB] = await Promise.all([
      makeRawReport("it2-a", t1),
      makeRawReport("it2-b", t2),
    ]);

    // Both observations post-date closedThroughObservedAt, so both would
    // classify RECURRED against the CLOSED snapshot.
    await Promise.all([
      recordFindingObservation(
        { ...identityFor(IP.recurrence), rawReportId: reportA.id, observedAt: t1 },
        { client: prisma }
      ),
      recordFindingObservation(
        { ...identityFor(IP.recurrence), rawReportId: reportB.id, observedAt: t2 },
        { client: prisma }
      ),
    ]);

    const finding = await findingFor(IP.recurrence);
    expect(finding.status).toBe("OPEN");
    // The core invariant: one real CLOSED -> OPEN transition, one increment.
    expect(finding.recurrenceCount).toBe(1);
    expect(finding.occurrenceCount).toBe(3); // seed + two new reports
    expect(finding.closedAt).toBeNull();
    expect(finding.closureReason).toBeNull();
    expect(finding.closedThroughObservedAt).toBeNull();

    const occurrences = await occurrencesFor(finding.id);
    expect(occurrences).toHaveLength(3);
    const recurred = occurrences.filter((o) => o.action === "RECURRED");
    expect(recurred).toHaveLength(1);
    // The loser was re-classified from fresh (now OPEN) state.
    const others = occurrences.filter((o) => o.action !== "RECURRED" && o.action !== "CREATED");
    expect(others).toHaveLength(1);
    expect(["PERSISTED", "HISTORICAL"]).toContain(others[0].action);
  }, 60000);

  it("3. same-report occurrence race: one occurrence, one increment, one idempotent caller", async () => {
    const t = new Date("2026-03-15T00:00:00.000Z");
    const report = await makeRawReport("it3", t);
    const input = { ...identityFor(IP.sameReport), rawReportId: report.id, observedAt: t };

    const results = await Promise.all([
      recordFindingObservation(input, { client: prisma }),
      recordFindingObservation(input, { client: prisma }),
    ]);

    const finding = await findingFor(IP.sameReport);
    const occurrences = await occurrencesFor(finding.id);

    expect(occurrences).toHaveLength(1);
    expect(finding.occurrenceCount).toBe(1);
    expect(finding.recurrenceCount).toBe(0);
    // Exactly one caller did the work; the other resolved idempotently.
    expect(results.filter((r) => r.idempotent)).toHaveLength(1);
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    // Both callers agree on the same occurrence row.
    expect(results[0].occurrence.id).toBe(results[1].occurrence.id);
  }, 60000);

  it("4. rollback integrity: a failure after occurrence creation leaves no occurrence and an unchanged projection", async () => {
    const seed = new Date("2026-03-20T00:00:00.000Z");
    const later = new Date("2026-03-21T00:00:00.000Z");

    const seedReport = await makeRawReport("it4-seed", seed);
    const created = await recordFindingObservation(
      { ...identityFor(IP.rollback), rawReportId: seedReport.id, observedAt: seed },
      { client: prisma }
    );
    const before = await findingFor(IP.rollback);

    const failingReport = await makeRawReport("it4-fail", later);
    const injected = new Error("injected failure after occurrence create");

    // Real Prisma transaction, but the projection update throws — so the
    // occurrence INSERT that already succeeded must be rolled back by the
    // database. Only the model methods the service actually uses are exposed.
    const failingClient = {
      $transaction: (fn, options) =>
        prisma.$transaction((tx) => {
          const proxiedTx = {
            finding: {
              findUnique: (args) => tx.finding.findUnique(args),
              create: (args) => tx.finding.create(args),
              update: () => {
                throw injected;
              },
            },
            findingOccurrence: {
              findUnique: (args) => tx.findingOccurrence.findUnique(args),
              create: (args) => tx.findingOccurrence.create(args),
            },
          };
          return fn(proxiedTx);
        }, options),
    };

    await expect(
      recordFindingObservation(
        { ...identityFor(IP.rollback), rawReportId: failingReport.id, observedAt: later },
        { client: failingClient }
      )
    ).rejects.toThrow("injected failure after occurrence create");

    // No partially committed lifecycle evidence.
    const orphan = await prisma.findingOccurrence.findUnique({
      where: {
        findingId_rawReportId: { findingId: created.finding.id, rawReportId: failingReport.id },
      },
    });
    expect(orphan).toBeNull();

    const after = await findingFor(IP.rollback);
    expect(after.occurrenceCount).toBe(before.occurrenceCount);
    expect(after.firstSeen).toEqual(before.firstSeen);
    expect(after.lastSeen).toEqual(before.lastSeen);
    expect(after.recurrenceCount).toBe(before.recurrenceCount);
    expect(after.status).toBe(before.status);
    expect(await occurrencesFor(created.finding.id)).toHaveLength(1);
  }, 60000);

  it("5. out-of-order concurrency: firstSeen is the true MIN, lastSeen the true MAX, no false recurrence", async () => {
    const middle = new Date("2026-04-10T00:00:00.000Z");
    const earliest = new Date("2026-04-01T00:00:00.000Z");
    const latest = new Date("2026-04-20T00:00:00.000Z");

    const [rMid, rEarly, rLate] = await Promise.all([
      makeRawReport("it5-mid", middle),
      makeRawReport("it5-early", earliest),
      makeRawReport("it5-late", latest),
    ]);

    // Fired concurrently and deliberately not in timestamp order.
    await Promise.all([
      recordFindingObservation(
        { ...identityFor(IP.outOfOrder), rawReportId: rMid.id, observedAt: middle },
        { client: prisma }
      ),
      recordFindingObservation(
        { ...identityFor(IP.outOfOrder), rawReportId: rEarly.id, observedAt: earliest },
        { client: prisma }
      ),
      recordFindingObservation(
        { ...identityFor(IP.outOfOrder), rawReportId: rLate.id, observedAt: latest },
        { client: prisma }
      ),
    ]);

    const finding = await findingFor(IP.outOfOrder);
    const occurrences = await occurrencesFor(finding.id);

    expect(occurrences).toHaveLength(3);
    expect(finding.firstSeen).toEqual(earliest);
    expect(finding.lastSeen).toEqual(latest);
    // Counters match the number of distinct occurrence rows.
    expect(finding.occurrenceCount).toBe(occurrences.length);
    // An out-of-order (earlier) report must never look like a recurrence.
    expect(finding.recurrenceCount).toBe(0);
    expect(finding.status).toBe("OPEN");
    expect(occurrences.filter((o) => o.action === "RECURRED")).toHaveLength(0);
  }, 60000);
});
