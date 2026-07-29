import { describe, it, expect } from "vitest";

// P2-T3 — normalized risk input snapshot.
//
// SCOPE NOTE, mirroring findingOwnershipService.test.js: an in-memory fake
// Prisma client. These prove the snapshot's normalization decisions — the
// current-episode rule, the ownership applicability gate, enrichment
// freshness/priority, and fingerprint determinism — not PostgreSQL semantics.
//
// The wall clock is never read here, exactly as in the module under test:
// every case supplies its own explicit asOf.

const {
  RiskInputValidationError,
  RiskFindingNotFoundError,
  elapsedWholeDays,
  buildInputFingerprint,
  loadRiskInputSnapshot,
} = require("../../src/services/risk/riskInputSnapshot");

const ASOF = new Date("2026-07-01T00:00:00Z");
const DAY = 86400000;

function daysBefore(date, days) {
  return new Date(date.getTime() - days * DAY);
}

function createFakeClient() {
  const findings = new Map();
  const occurrences = [];
  const ownerships = new Map(); // currentForFindingId -> row
  const organizations = new Map();
  const iocEnrichments = [];

  const client = {
    finding: {
      async findUnique({ where: { id } }) {
        return findings.has(id) ? { ...findings.get(id) } : null;
      },
    },
    findingOccurrence: {
      async findMany({ where = {} } = {}) {
        return occurrences
          .filter((row) => row.findingId === where.findingId)
          .filter((row) => (where.observedAt ? row.observedAt <= where.observedAt.lte : true))
          .sort((a, b) => a.observedAt - b.observedAt || a.id - b.id)
          .map((row) => ({ ...row }));
      },
    },
    findingOwnership: {
      async findUnique({ where }) {
        const row = ownerships.get(where.currentForFindingId);
        return row ? { ...row } : null;
      },
    },
    organization: {
      async findUnique({ where: { id } }) {
        const row = organizations.get(id);
        return row ? { ...row } : null;
      },
    },
    iocEnrichment: {
      async findMany({ where = {}, orderBy = [], take } = {}) {
        let rows = iocEnrichments.filter(
          (row) =>
            row.provider === where.provider &&
            row.indicatorType === where.indicatorType &&
            row.indicator === where.indicator
        );
        if (where.status && where.status.in) {
          rows = rows.filter((row) => where.status.in.includes(row.status));
        }
        if (where.queriedAt && where.queriedAt.not === null) {
          rows = rows.filter((row) => row.queriedAt !== null && row.queriedAt !== undefined);
        }
        rows = [...rows].sort((a, b) => {
          for (const clause of orderBy) {
            const [field, dir] = Object.entries(clause)[0];
            const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? -Infinity;
            const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? -Infinity;
            if (av !== bv) return dir === "desc" ? bv - av : av - bv;
          }
          return 0;
        });
        return rows.slice(0, take).map((row) => ({ ...row }));
      },
    },
  };

  let nextOccurrenceId = 1;
  let nextEnrichmentId = 1;

  return {
    client,
    seedFinding(overrides = {}) {
      const row = {
        id: 1,
        indicatorValue: "203.0.113.10",
        port: 3389,
        protocol: "TCP",
        reportType: "ACCESSIBLE_RDP",
        status: "OPEN",
        firstSeen: daysBefore(ASOF, 3),
        lastSeen: ASOF,
        ...overrides,
      };
      findings.set(row.id, row);
      return row;
    },
    seedOccurrence(overrides = {}) {
      const row = {
        id: nextOccurrenceId++,
        findingId: 1,
        action: "CREATED",
        observedAt: daysBefore(ASOF, 3),
        ...overrides,
      };
      occurrences.push(row);
      return row;
    },
    seedOwnership(overrides = {}) {
      const row = {
        id: 1,
        findingId: 1,
        currentForFindingId: 1,
        status: "RESOLVED",
        confidence: "HIGH",
        isIspAttribution: false,
        organizationId: 10,
        ...overrides,
      };
      ownerships.set(row.currentForFindingId, row);
      return row;
    },
    seedOrganization(overrides = {}) {
      const row = { id: 10, sector: "HEALTHCARE", ...overrides };
      organizations.set(row.id, row);
      return row;
    },
    seedEnrichment(overrides = {}) {
      const row = {
        id: nextEnrichmentId++,
        provider: "abuseipdb",
        indicatorType: "IPV4",
        indicator: "203.0.113.10",
        status: "SUCCESS",
        requestedAt: daysBefore(ASOF, 1),
        queriedAt: daysBefore(ASOF, 1),
        expiresAt: new Date(ASOF.getTime() + DAY),
        abuseConfidenceScore: 42,
        ...overrides,
      };
      iocEnrichments.push(row);
      return row;
    },
  };
}

async function load(fake, options = {}) {
  return loadRiskInputSnapshot(1, { client: fake.client, asOf: ASOF, ...options });
}

describe("input validation", () => {
  it("rejects a non-positive or non-integer findingId", async () => {
    const fake = createFakeClient();
    await expect(
      loadRiskInputSnapshot(0, { client: fake.client, asOf: ASOF })
    ).rejects.toBeInstanceOf(RiskInputValidationError);
    await expect(
      loadRiskInputSnapshot(1.5, { client: fake.client, asOf: ASOF })
    ).rejects.toBeInstanceOf(RiskInputValidationError);
  });

  it("requires an explicit valid asOf — the module never reads a clock", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    await expect(loadRiskInputSnapshot(1, { client: fake.client })).rejects.toBeInstanceOf(
      RiskInputValidationError
    );
    await expect(
      loadRiskInputSnapshot(1, { client: fake.client, asOf: new Date("nope") })
    ).rejects.toBeInstanceOf(RiskInputValidationError);
    await expect(
      loadRiskInputSnapshot(1, { client: fake.client, asOf: "2026-07-01T00:00:00Z" })
    ).rejects.toBeInstanceOf(RiskInputValidationError);
  });

  it("throws RiskFindingNotFoundError for an unknown Finding", async () => {
    const fake = createFakeClient();
    await expect(load(fake)).rejects.toBeInstanceOf(RiskFindingNotFoundError);
  });

  it("copies asOf rather than aliasing the caller's Date", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOccurrence();
    const asOf = new Date(ASOF.getTime());
    const snapshot = await loadRiskInputSnapshot(1, { client: fake.client, asOf });
    expect(snapshot.asOf.getTime()).toBe(asOf.getTime());
    expect(snapshot.asOf).not.toBe(asOf);
  });
});

describe("elapsedWholeDays", () => {
  it("floors whole days using integer arithmetic", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(elapsedWholeDays(from, new Date("2026-01-01T00:00:00Z"))).toBe(0);
    expect(elapsedWholeDays(from, new Date("2026-01-01T23:59:59Z"))).toBe(0);
    expect(elapsedWholeDays(from, new Date("2026-01-02T00:00:00Z"))).toBe(1);
    expect(elapsedWholeDays(from, new Date("2026-01-08T12:00:00Z"))).toBe(7);
  });

  it("fails closed (null) for a backwards interval rather than clamping to 0", () => {
    expect(
      elapsedWholeDays(new Date("2026-01-02T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))
    ).toBeNull();
  });

  it("fails closed for a missing or invalid instant", () => {
    expect(elapsedWholeDays(null, ASOF)).toBeNull();
    expect(elapsedWholeDays(ASOF, null)).toBeNull();
    expect(elapsedWholeDays(new Date("nope"), ASOF)).toBeNull();
    expect(elapsedWholeDays("2026-01-01", ASOF)).toBeNull();
  });

  it("clamps the normalized value at 3650 days (G7)", () => {
    const from = new Date(ASOF.getTime() - 5000 * DAY);
    expect(elapsedWholeDays(from, ASOF)).toBe(3650);
  });
});

describe("occurrence evidence (G3/G5)", () => {
  it("counts every occurrence action as one accepted report observation", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOccurrence({ action: "CREATED", observedAt: daysBefore(ASOF, 10) });
    fake.seedOccurrence({ action: "PERSISTED", observedAt: daysBefore(ASOF, 8) });
    fake.seedOccurrence({ action: "HISTORICAL", observedAt: daysBefore(ASOF, 6) });
    fake.seedOccurrence({ action: "RECURRED", observedAt: daysBefore(ASOF, 4) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.observationCount).toBe(4);
    expect(snapshot.inputs.recurredCount).toBe(1);
  });

  it("counts only occurrences at or before asOf", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOccurrence({ observedAt: daysBefore(ASOF, 2) });
    fake.seedOccurrence({ observedAt: new Date(ASOF.getTime() + DAY) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.observationCount).toBe(1);
  });

  it("counts recurrences only from RECURRED rows, never from persistence", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOccurrence({ action: "PERSISTED", observedAt: daysBefore(ASOF, 5) });
    fake.seedOccurrence({ action: "PERSISTED", observedAt: daysBefore(ASOF, 4) });
    fake.seedOccurrence({ action: "RECURRED", observedAt: daysBefore(ASOF, 3) });
    fake.seedOccurrence({ action: "RECURRED", observedAt: daysBefore(ASOF, 2) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.observationCount).toBe(4);
    expect(snapshot.inputs.recurredCount).toBe(2);
  });
});

describe("amendment 3 — the current unresolved episode", () => {
  it("measures from firstSeen when the finding has never recurred", async () => {
    const fake = createFakeClient();
    fake.seedFinding({ firstSeen: daysBefore(ASOF, 45) });
    fake.seedOccurrence({ action: "CREATED", observedAt: daysBefore(ASOF, 45) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.daysUnresolved).toBe(45);
  });

  it("restarts the clock at the latest RECURRED observation, not firstSeen", async () => {
    const fake = createFakeClient();
    fake.seedFinding({ firstSeen: daysBefore(ASOF, 400) });
    fake.seedOccurrence({ action: "CREATED", observedAt: daysBefore(ASOF, 400) });
    fake.seedOccurrence({ action: "RECURRED", observedAt: daysBefore(ASOF, 120) });
    fake.seedOccurrence({ action: "RECURRED", observedAt: daysBefore(ASOF, 10) });

    const snapshot = await load(fake);
    // 10, not 400: time spent CLOSED between episodes is never counted.
    expect(snapshot.inputs.daysUnresolved).toBe(10);
    expect(snapshot.inputs.recurredCount).toBe(2);
  });

  it("ignores a RECURRED occurrence that happens after asOf", async () => {
    const fake = createFakeClient();
    fake.seedFinding({ firstSeen: daysBefore(ASOF, 60) });
    fake.seedOccurrence({ action: "CREATED", observedAt: daysBefore(ASOF, 60) });
    fake.seedOccurrence({ action: "RECURRED", observedAt: new Date(ASOF.getTime() + 5 * DAY) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.daysUnresolved).toBe(60);
    expect(snapshot.inputs.recurredCount).toBe(0);
  });

  it("reports null days for a CLOSED finding, whatever its timestamps say", async () => {
    const fake = createFakeClient();
    fake.seedFinding({ status: "CLOSED", firstSeen: daysBefore(ASOF, 300) });
    fake.seedOccurrence({ observedAt: daysBefore(ASOF, 300) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.findingStatus).toBe("CLOSED");
    expect(snapshot.inputs.daysUnresolved).toBeNull();
  });

  it("reports null days when the episode start is in the future (invalid timestamp)", async () => {
    const fake = createFakeClient();
    fake.seedFinding({ firstSeen: new Date(ASOF.getTime() + 10 * DAY) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.daysUnresolved).toBeNull();
  });

  it("clamps a very old episode at 3650 days", async () => {
    const fake = createFakeClient();
    fake.seedFinding({ firstSeen: new Date(ASOF.getTime() - 9000 * DAY) });

    const snapshot = await load(fake);
    expect(snapshot.inputs.daysUnresolved).toBe(3650);
  });
});

describe("amendment 2 — ownership as a sector applicability gate only", () => {
  it("marks NO_OWNERSHIP when there is no current ownership row", async () => {
    const fake = createFakeClient();
    fake.seedFinding();

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe("NO_OWNERSHIP");
    expect(snapshot.inputs.sector).toBeNull();
    expect(snapshot.inputs.ownershipStatus).toBeNull();
  });

  it("attributes an OVERRIDDEN row with an organization and no ISP flag (path A)", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "OVERRIDDEN", confidence: "CONFIRMED" });
    fake.seedOrganization({ sector: "GOVERNMENT" });

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(true);
    expect(snapshot.inputs.sector).toBe("GOVERNMENT");
    expect(snapshot.inputs.sectorNonAttributableReason).toBeNull();
  });

  it.each(["HIGH", "MEDIUM"])(
    "attributes a RESOLVED row at %s confidence (path B)",
    async (confidence) => {
      const fake = createFakeClient();
      fake.seedFinding();
      fake.seedOwnership({ status: "RESOLVED", confidence });
      fake.seedOrganization({ sector: "FINANCE" });

      const snapshot = await load(fake);
      expect(snapshot.inputs.sectorAttributable).toBe(true);
      expect(snapshot.inputs.sector).toBe("FINANCE");
    }
  );

  it("refuses a RESOLVED row at LOW confidence with the dedicated reason", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "RESOLVED", confidence: "LOW" });
    fake.seedOrganization({ sector: "FINANCE" });

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe("LOW_CONFIDENCE");
    expect(snapshot.inputs.sector).toBeNull();
    // Confidence is still recorded as context — it just scores nothing.
    expect(snapshot.inputs.ownershipConfidence).toBe("LOW");
  });

  it("refuses a RESOLVED row at CONFIRMED confidence — path B only unlocks at HIGH/MEDIUM", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "RESOLVED", confidence: "CONFIRMED" });
    fake.seedOrganization({ sector: "FINANCE" });

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe("LOW_CONFIDENCE");
    expect(snapshot.inputs.sector).toBeNull();
    expect(snapshot.inputs.ownershipConfidence).toBe("CONFIRMED");
  });

  it.each(["AMBIGUOUS", "UNRESOLVED"])("refuses a %s row", async (status) => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status, confidence: "HIGH" });
    fake.seedOrganization();

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe(status);
  });

  it("refuses an ISP attribution even when it resolved an organization", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "RESOLVED", confidence: "HIGH", isIspAttribution: true });
    fake.seedOrganization({ sector: "TELECOM" });

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe("ISP_ATTRIBUTION");
    expect(snapshot.inputs.ownershipIsIspAttribution).toBe(true);
  });

  it("refuses a row with no organizationId", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "RESOLVED", confidence: "HIGH", organizationId: null });

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe("NO_ORGANIZATION");
  });

  it("refuses an UNKNOWN sector — missing context is never the least risky sector", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "RESOLVED", confidence: "HIGH" });
    fake.seedOrganization({ sector: "UNKNOWN" });

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe("UNKNOWN_SECTOR");
    expect(snapshot.inputs.sector).toBeNull();
  });

  it("refuses when the organization row itself has vanished", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "RESOLVED", confidence: "HIGH", organizationId: 999 });

    const snapshot = await load(fake);
    expect(snapshot.inputs.sectorAttributable).toBe(false);
    expect(snapshot.inputs.sectorNonAttributableReason).toBe("UNKNOWN_SECTOR");
  });
});

describe("enrichment context", () => {
  it("uses a fresh SUCCESS row and preserves an abuseConfidenceScore of 0", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedEnrichment({ status: "SUCCESS", abuseConfidenceScore: 0 });

    const snapshot = await load(fake);
    expect(snapshot.inputs.enrichmentPresent).toBe(true);
    expect(snapshot.inputs.enrichmentStatus).toBe("SUCCESS");
    expect(snapshot.inputs.enrichmentFresh).toBe(true);
    expect(snapshot.inputs.abuseConfidenceScore).toBe(0);
  });

  it("treats the freshness window as half-open [queriedAt, expiresAt)", async () => {
    const expiredExactly = createFakeClient();
    expiredExactly.seedFinding();
    expiredExactly.seedEnrichment({ queriedAt: daysBefore(ASOF, 1), expiresAt: ASOF });
    const expiredSnapshot = await load(expiredExactly);
    expect(expiredSnapshot.inputs.enrichmentFresh).toBe(false);

    const stillFresh = createFakeClient();
    stillFresh.seedFinding();
    stillFresh.seedEnrichment({
      queriedAt: daysBefore(ASOF, 1),
      expiresAt: new Date(ASOF.getTime() + 1),
    });
    const freshSnapshot = await load(stillFresh);
    expect(freshSnapshot.inputs.enrichmentFresh).toBe(true);
  });

  it("drops the score when the reputation row has expired, keeping the status honest", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedEnrichment({
      status: "SUCCESS",
      abuseConfidenceScore: 95,
      queriedAt: daysBefore(ASOF, 10),
      expiresAt: daysBefore(ASOF, 9),
    });

    const snapshot = await load(fake);
    expect(snapshot.inputs.enrichmentPresent).toBe(true);
    expect(snapshot.inputs.enrichmentFresh).toBe(false);
    expect(snapshot.inputs.abuseConfidenceScore).toBeNull();
  });

  it("prefers the newest reputation-bearing row over a later failure row", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedEnrichment({
      status: "SUCCESS",
      abuseConfidenceScore: 80,
      queriedAt: daysBefore(ASOF, 1),
      expiresAt: new Date(ASOF.getTime() + DAY),
    });
    fake.seedEnrichment({
      status: "RATE_LIMITED",
      requestedAt: ASOF,
      queriedAt: null,
      expiresAt: null,
      abuseConfidenceScore: null,
    });

    const snapshot = await load(fake);
    expect(snapshot.inputs.enrichmentStatus).toBe("SUCCESS");
    expect(snapshot.inputs.abuseConfidenceScore).toBe(80);
  });

  it("falls back to the newest row of any status so the failure can be named exactly", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedEnrichment({
      status: "DEAD_LETTER",
      requestedAt: daysBefore(ASOF, 2),
      queriedAt: null,
      expiresAt: null,
      abuseConfidenceScore: null,
    });

    const snapshot = await load(fake);
    expect(snapshot.inputs.enrichmentPresent).toBe(true);
    expect(snapshot.inputs.enrichmentStatus).toBe("DEAD_LETTER");
    expect(snapshot.inputs.enrichmentFresh).toBe(false);
    expect(snapshot.inputs.abuseConfidenceScore).toBeNull();
  });

  it("reports a complete absence when no row exists for the indicator", async () => {
    const fake = createFakeClient();
    fake.seedFinding();

    const snapshot = await load(fake);
    expect(snapshot.inputs.enrichmentPresent).toBe(false);
    expect(snapshot.inputs.enrichmentStatus).toBeNull();
  });

  it("scopes reads to the Finding's own canonical indicator", async () => {
    const fake = createFakeClient();
    fake.seedFinding({ indicatorValue: "198.51.100.7" });
    fake.seedEnrichment({ indicator: "203.0.113.10", abuseConfidenceScore: 99 });

    const snapshot = await load(fake);
    expect(snapshot.inputs.enrichmentPresent).toBe(false);
  });

  it("never reports a NOT_FOUND row as carrying a score", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedEnrichment({ status: "NOT_FOUND", abuseConfidenceScore: 55 });

    const snapshot = await load(fake);
    expect(snapshot.inputs.enrichmentStatus).toBe("NOT_FOUND");
    expect(snapshot.inputs.enrichmentFresh).toBe(true);
    expect(snapshot.inputs.abuseConfidenceScore).toBeNull();
  });
});

describe("vulnerability context (G4)", () => {
  it("is structurally absent — no CVE is ever inferred from an exposure finding", async () => {
    const fake = createFakeClient();
    fake.seedFinding();

    const snapshot = await load(fake);
    expect(snapshot.inputs.cvePresent).toBe(false);
    expect(snapshot.inputs.kevListed).toBeNull();
    expect(snapshot.inputs.kevLookupAvailable).toBe(false);
    expect(snapshot.inputs.epssBasisPoints).toBeNull();
  });
});

describe("snapshot shape and fingerprint", () => {
  it("carries the locked algorithm/configuration identity and is frozen", async () => {
    const fake = createFakeClient();
    fake.seedFinding();

    const snapshot = await load(fake);
    expect(snapshot.algorithmVersion).toBe("risk-additive-bucketed-v1");
    expect(snapshot.configurationVersion).toBe("v1.0.0");
    expect(snapshot.configurationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.inputs)).toBe(true);
  });

  it("carries only bounded scalars — no row ids, no raw provider payload, no indicator", async () => {
    const fake = createFakeClient();
    fake.seedFinding();
    fake.seedOwnership({ status: "RESOLVED", confidence: "HIGH" });
    fake.seedOrganization({ sector: "HEALTHCARE" });
    fake.seedEnrichment({ abuseConfidenceScore: 42 });

    const snapshot = await load(fake);
    expect(Object.keys(snapshot.inputs).sort()).toEqual(
      [
        "abuseConfidenceScore",
        "cvePresent",
        "daysUnresolved",
        "enrichmentFresh",
        "enrichmentPresent",
        "enrichmentStatus",
        "epssBasisPoints",
        "findingStatus",
        "kevListed",
        "kevLookupAvailable",
        "observationCount",
        "ownershipConfidence",
        "ownershipIsIspAttribution",
        "ownershipStatus",
        "port",
        "protocol",
        "recurredCount",
        "reportType",
        "sector",
        "sectorAttributable",
        "sectorNonAttributableReason",
      ].sort()
    );
    const serialized = JSON.stringify(snapshot.inputs);
    expect(serialized).not.toContain("203.0.113.10");
    expect(serialized).not.toContain("cacheKey");
  });

  it("is deterministic for identical state", async () => {
    const build = () => {
      const fake = createFakeClient();
      fake.seedFinding({ firstSeen: daysBefore(ASOF, 20) });
      fake.seedOccurrence({ observedAt: daysBefore(ASOF, 20) });
      fake.seedEnrichment({ abuseConfidenceScore: 42 });
      return fake;
    };
    const a = await load(build());
    const b = await load(build());
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
  });

  it("changes when any scored input changes", async () => {
    const base = createFakeClient();
    base.seedFinding();
    base.seedOccurrence();
    const baseline = await load(base);

    const changed = createFakeClient();
    changed.seedFinding();
    changed.seedOccurrence();
    changed.seedOccurrence({ action: "PERSISTED", observedAt: daysBefore(ASOF, 1) });
    const withMoreObservations = await load(changed);

    expect(withMoreObservations.inputFingerprint).not.toBe(baseline.inputFingerprint);
  });

  it("does not change merely because asOf moved within the same day bucket", async () => {
    const build = () => {
      const fake = createFakeClient();
      fake.seedFinding({ firstSeen: daysBefore(ASOF, 20) });
      fake.seedOccurrence({ observedAt: daysBefore(ASOF, 20) });
      return fake;
    };
    const earlier = await loadRiskInputSnapshot(1, {
      client: build().client,
      asOf: new Date("2026-07-01T00:00:00Z"),
    });
    const later = await loadRiskInputSnapshot(1, {
      client: build().client,
      asOf: new Date("2026-07-01T06:00:00Z"),
    });
    // Same elapsed-day bucket (20 days), so the same approved input state.
    expect(later.inputs.daysUnresolved).toBe(earlier.inputs.daysUnresolved);
    expect(later.inputFingerprint).toBe(earlier.inputFingerprint);
  });

  it("does change once asOf crosses into the next whole day", async () => {
    const build = () => {
      const fake = createFakeClient();
      fake.seedFinding({ firstSeen: daysBefore(ASOF, 20) });
      fake.seedOccurrence({ observedAt: daysBefore(ASOF, 20) });
      return fake;
    };
    const day20 = await loadRiskInputSnapshot(1, { client: build().client, asOf: ASOF });
    const day21 = await loadRiskInputSnapshot(1, {
      client: build().client,
      asOf: new Date(ASOF.getTime() + DAY),
    });
    expect(day20.inputs.daysUnresolved).toBe(20);
    expect(day21.inputs.daysUnresolved).toBe(21);
    expect(day21.inputFingerprint).not.toBe(day20.inputFingerprint);
  });

  it("buildInputFingerprint is stable and key-order independent", () => {
    const a = buildInputFingerprint({ observationCount: 1, recurredCount: 0 });
    const b = buildInputFingerprint({ recurredCount: 0, observationCount: 1 });
    const c = buildInputFingerprint({ observationCount: 2, recurredCount: 0 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
