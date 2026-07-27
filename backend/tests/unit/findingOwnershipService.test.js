import { describe, it, expect } from "vitest";

const {
  FindingOwnershipNotFoundError,
  FindingOwnershipValidationError,
  FindingOwnershipOverrideStateError,
  MAX_JUSTIFICATION_LENGTH,
  resolveOneFinding,
  reResolveFindingsForMapping,
  applyOverride,
  clearOverride,
  getFindingOwnership,
  calculateCoverage,
} = require("../../src/services/ownership/findingOwnershipService");
const { ipv4ToInt, cidrToRange } = require("../../src/services/ownership/ipv4Cidr");

// SCOPE NOTE, mirroring dedupService.test.js: unit tests against an
// in-memory fake Prisma client. They prove the service's decision logic
// (supersede-then-insert, dedupe-on-unchanged, override precedence,
// coverage aggregation) — not PostgreSQL transaction/concurrency semantics.
// That is covered by the real-database suite.

function createFakeClient() {
  let nextFindingOwnershipId = 1;

  const findings = new Map();
  const organizations = new Map();
  const assetMappings = new Map();
  const findingOwnerships = new Map();

  function matches(row, where = {}) {
    return Object.entries(where).every(([key, condition]) => {
      if (condition && typeof condition === "object" && !Array.isArray(condition)) {
        if ("not" in condition) return row[key] !== condition.not;
        if ("lte" in condition) return row[key] <= condition.lte;
        if ("gte" in condition) return row[key] >= condition.gte;
        return true;
      }
      return row[key] === condition;
    });
  }

  function matchesOr(row, orConditions) {
    return orConditions.some((cond) => matches(row, cond));
  }

  const client = {
    finding: {
      async findUnique({ where: { id } }) {
        return findings.has(id) ? { ...findings.get(id) } : null;
      },
      async findMany() {
        return [...findings.values()].map((r) => ({ ...r }));
      },
      async count() {
        return findings.size;
      },
    },
    organization: {
      async findUnique({ where: { id } }) {
        return organizations.has(id) ? { ...organizations.get(id) } : null;
      },
    },
    assetMapping: {
      async findMany({ where = {} }) {
        return [...assetMappings.values()]
          .filter((r) => {
            if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
            if (where.mappingConfirmed !== undefined && r.mappingConfirmed !== where.mappingConfirmed)
              return false;
            if (where.OR && !matchesOr(r, where.OR)) return false;
            return true;
          })
          .map((r) => ({ ...r }));
      },
      async count({ where = {} }) {
        return (await client.assetMapping.findMany({ where })).length;
      },
    },
    findingOwnership: {
      async findUnique({ where }) {
        const key = Object.keys(where)[0];
        const value = where[key];
        const row = [...findingOwnerships.values()].find((r) => r[key] === value);
        return row ? { ...row } : null;
      },
      async findMany({ where = {}, orderBy } = {}) {
        let rows = [...findingOwnerships.values()].filter((r) => matches(r, where));
        if (Array.isArray(orderBy)) {
          rows = rows.sort((a, b) => {
            // eslint-disable-next-line no-restricted-syntax
            for (const clause of orderBy) {
              const [field, dir] = Object.entries(clause)[0];
              const av = a[field] instanceof Date ? a[field].getTime() : a[field];
              const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
              if (av !== bv) return dir === "desc" ? bv - av : av - bv;
            }
            return 0;
          });
        }
        return rows.map((r) => ({ ...r }));
      },
      async create({ data }) {
        const id = nextFindingOwnershipId++;
        const row = { id, resolvedAt: new Date(), createdAt: new Date(), supersededAt: null, ...data };
        findingOwnerships.set(id, row);
        return { ...row };
      },
      async update({ where: { id }, data }) {
        const row = findingOwnerships.get(id);
        Object.assign(row, data);
        return { ...row };
      },
      async groupBy({ by, where = {}, _count }) {
        const rows = [...findingOwnerships.values()].filter((r) => matches(r, where));
        const groups = new Map();
        rows.forEach((row) => {
          const key = by.map((field) => String(row[field])).join("::");
          if (!groups.has(key)) {
            const shape = {};
            by.forEach((field) => {
              shape[field] = row[field];
            });
            groups.set(key, { ...shape, _count: { _all: 0 } });
          }
          groups.get(key)._count._all += 1;
        });
        return [...groups.values()];
      },
    },
    async $transaction(fn) {
      return fn(client);
    },
    _stores: { findings, organizations, assetMappings, findingOwnerships },
  };

  return client;
}

function seedFinding(client, id, indicatorValue) {
  client._stores.findings.set(id, { id, indicatorValue, status: "OPEN" });
}
function seedOrganization(client, id, name = `Org ${id}`) {
  client._stores.organizations.set(id, { id, name });
}
let nextMappingId = 1;
function seedExactIpMapping(client, organizationId, ip, overrides = {}) {
  const ipInt = ipv4ToInt(ip);
  const id = nextMappingId++;
  const row = {
    id,
    organizationId,
    mappingType: "EXACT_IP",
    ipStart: ipInt,
    ipEnd: ipInt,
    prefixLength: null,
    asn: null,
    enabled: true,
    mappingConfirmed: false,
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
  client._stores.assetMappings.set(id, row);
  return row;
}
function seedCidrMapping(client, organizationId, cidr, overrides = {}) {
  const range = cidrToRange(cidr);
  const id = nextMappingId++;
  const row = {
    id,
    organizationId,
    mappingType: "CIDR",
    ipStart: range.ipStart,
    ipEnd: range.ipEnd,
    prefixLength: range.prefixLength,
    asn: null,
    enabled: true,
    mappingConfirmed: false,
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
  client._stores.assetMappings.set(id, row);
  return row;
}

const ASOF = new Date("2026-06-01T00:00:00Z");

describe("resolveOneFinding", () => {
  it("throws FindingOwnershipNotFoundError for a nonexistent finding", async () => {
    const client = createFakeClient();
    await expect(resolveOneFinding(999, { client, asOf: ASOF })).rejects.toThrow(
      FindingOwnershipNotFoundError
    );
  });

  it("creates the first history row on initial resolution", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedExactIpMapping(client, 1, "203.0.113.10");

    const outcome = await resolveOneFinding(1, { client, asOf: ASOF });
    expect(outcome.changed).toBe(true);
    expect(outcome.current.status).toBe("RESOLVED");
    expect(outcome.current.organizationId).toBe(1);
    expect(outcome.current.currentForFindingId).toBe(1);
  });

  it("persists UNRESOLVED explicitly when nothing matches", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");

    const outcome = await resolveOneFinding(1, { client, asOf: ASOF });
    expect(outcome.changed).toBe(true);
    expect(outcome.current.status).toBe("UNRESOLVED");
  });

  it("re-resolving to the identical outcome creates no new row (idempotent replay)", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedExactIpMapping(client, 1, "203.0.113.10");

    const first = await resolveOneFinding(1, { client, asOf: ASOF });
    const second = await resolveOneFinding(1, { client, asOf: new Date("2026-06-02T00:00:00Z") });

    expect(second.changed).toBe(false);
    expect(second.current.id).toBe(first.current.id);
    const history = await client.findingOwnership.findMany({ where: { findingId: 1 } });
    expect(history).toHaveLength(1);
  });

  it("re-resolution after a mapping change supersedes the prior row and inserts a new one", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedOrganization(client, 2);
    seedExactIpMapping(client, 1, "203.0.113.10");

    const first = await resolveOneFinding(1, { client, asOf: ASOF });
    expect(first.current.organizationId).toBe(1);

    // Simulate a mapping change: disable org 1's mapping, add org 2's.
    client._stores.assetMappings.forEach((m) => {
      m.enabled = false;
    });
    seedExactIpMapping(client, 2, "203.0.113.10");

    const second = await resolveOneFinding(1, { client, asOf: new Date("2026-06-02T00:00:00Z") });
    expect(second.changed).toBe(true);
    expect(second.current.organizationId).toBe(2);

    const superseded = await client.findingOwnership.findMany({ where: { id: first.current.id } });
    expect(superseded[0].currentForFindingId).toBeNull();
    expect(superseded[0].supersededAt).not.toBeNull();

    const history = await client.findingOwnership.findMany({ where: { findingId: 1 } });
    expect(history).toHaveLength(2);
  });

  it("persists AMBIGUOUS with a null organizationId", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedOrganization(client, 2);
    seedExactIpMapping(client, 1, "203.0.113.10");
    seedExactIpMapping(client, 2, "203.0.113.10");

    const outcome = await resolveOneFinding(1, { client, asOf: ASOF });
    expect(outcome.current.status).toBe("AMBIGUOUS");
    expect(outcome.current.organizationId).toBeNull();
  });

  it("an active override is not disturbed by an automatic re-resolution", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedOrganization(client, 99);
    seedExactIpMapping(client, 1, "203.0.113.10");

    await applyOverride(1, 99, "manual correction", { client, actorUserId: 5, asOf: ASOF });
    const outcome = await resolveOneFinding(1, { client, asOf: new Date("2026-06-02T00:00:00Z") });

    expect(outcome.changed).toBe(false);
    expect(outcome.current.status).toBe("OVERRIDDEN");
    expect(outcome.current.organizationId).toBe(99);
  });
});

describe("applyOverride", () => {
  it("supersedes the current row and records actor + justification", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedOrganization(client, 2);
    seedExactIpMapping(client, 1, "203.0.113.10");
    await resolveOneFinding(1, { client, asOf: ASOF });

    const outcome = await applyOverride(1, 2, "confirmed by registrar lookup", {
      client,
      actorUserId: 7,
      asOf: new Date("2026-06-02T00:00:00Z"),
    });

    expect(outcome.current.status).toBe("OVERRIDDEN");
    expect(outcome.current.organizationId).toBe(2);
    expect(outcome.current.overrideActorUserId).toBe(7);
    expect(outcome.current.overrideJustification).toBe("confirmed by registrar lookup");
  });

  it("always inserts a new row even when re-applying the same organization", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 2);

    await applyOverride(1, 2, "first pass", { client, asOf: ASOF });
    await applyOverride(1, 2, "re-confirmed", { client, asOf: new Date("2026-06-02T00:00:00Z") });

    const history = await client.findingOwnership.findMany({ where: { findingId: 1 } });
    expect(history).toHaveLength(2);
  });

  it("rejects a missing/invalid organizationId, findingId or justification", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 2);

    await expect(applyOverride(1, 2, "", { client })).rejects.toThrow(FindingOwnershipValidationError);
    await expect(applyOverride(1, 2, "x".repeat(MAX_JUSTIFICATION_LENGTH + 1), { client })).rejects.toThrow(
      FindingOwnershipValidationError
    );
    await expect(applyOverride(1, 0, "reason", { client })).rejects.toThrow(
      FindingOwnershipValidationError
    );
    await expect(applyOverride(0, 2, "reason", { client })).rejects.toThrow(
      FindingOwnershipValidationError
    );
  });

  it("rejects an override for a nonexistent finding or organization", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 2);

    await expect(applyOverride(999, 2, "reason", { client })).rejects.toThrow(
      FindingOwnershipNotFoundError
    );
    await expect(applyOverride(1, 999, "reason", { client })).rejects.toThrow(
      FindingOwnershipValidationError
    );
  });
});

describe("clearOverride", () => {
  it("reverts to the current automatic resolution, not to UNRESOLVED unconditionally", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedOrganization(client, 99);
    seedExactIpMapping(client, 1, "203.0.113.10");

    await applyOverride(1, 99, "override for testing", { client, asOf: ASOF });
    const outcome = await clearOverride(1, { client, asOf: new Date("2026-06-02T00:00:00Z") });

    expect(outcome.current.status).toBe("RESOLVED");
    expect(outcome.current.organizationId).toBe(1);
  });

  it("throws FindingOwnershipOverrideStateError when there is nothing to clear", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");

    await expect(clearOverride(1, { client })).rejects.toThrow(FindingOwnershipOverrideStateError);
  });

  it("throws FindingOwnershipNotFoundError for a nonexistent finding", async () => {
    const client = createFakeClient();
    await expect(clearOverride(999, { client })).rejects.toThrow(FindingOwnershipNotFoundError);
  });
});

describe("getFindingOwnership", () => {
  it("returns current and full history in deterministic order", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedOrganization(client, 1);
    seedOrganization(client, 2);
    seedExactIpMapping(client, 1, "203.0.113.10");

    await resolveOneFinding(1, { client, asOf: new Date("2026-01-01T00:00:00Z") });
    await applyOverride(1, 2, "correction", { client, asOf: new Date("2026-02-01T00:00:00Z") });

    const { current, history } = await getFindingOwnership(1, { client });
    expect(current.status).toBe("OVERRIDDEN");
    expect(history).toHaveLength(2);
    expect(history[0].resolvedAt.getTime()).toBeGreaterThanOrEqual(history[1].resolvedAt.getTime());
  });

  it("throws FindingOwnershipNotFoundError for a nonexistent finding", async () => {
    const client = createFakeClient();
    await expect(getFindingOwnership(999, { client })).rejects.toThrow(FindingOwnershipNotFoundError);
  });
});

describe("reResolveFindingsForMapping", () => {
  it("re-resolves only findings whose indicator falls in the mapping's range", async () => {
    const client = createFakeClient();
    seedFinding(client, 1, "203.0.113.10");
    seedFinding(client, 2, "198.51.100.5");
    seedOrganization(client, 1);
    await resolveOneFinding(1, { client, asOf: ASOF });
    await resolveOneFinding(2, { client, asOf: ASOF });

    const mapping = seedCidrMapping(client, 1, "203.0.113.0/24");
    const result = await reResolveFindingsForMapping(mapping, { client, asOf: new Date("2026-06-02T00:00:00Z") });

    expect(result.skipped).toBe(false);
    expect(result.reResolved.map((r) => r.findingId)).toEqual([1]);
    expect(result.reResolved[0].changed).toBe(true);
  });

  it("skips ASN-type mappings with an explicit reason", async () => {
    const client = createFakeClient();
    const mapping = { mappingType: "ASN", asn: 64500 };
    const result = await reResolveFindingsForMapping(mapping, { client });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("ASN_NOT_PERSISTED_ON_FINDING");
  });
});

describe("calculateCoverage", () => {
  it("reports every category separately, never a single collapsed percentage", async () => {
    const client = createFakeClient();

    seedFinding(client, 1, "203.0.113.10"); // exact IP
    seedFinding(client, 2, "203.0.114.10"); // CIDR
    seedFinding(client, 3, "203.0.115.10"); // ASN (ISP attribution)
    seedFinding(client, 4, "203.0.116.10"); // ambiguous
    seedFinding(client, 5, "203.0.117.10"); // unresolved
    seedFinding(client, 6, "203.0.118.10"); // override

    seedOrganization(client, 1);
    seedOrganization(client, 2);
    seedOrganization(client, 3);

    seedExactIpMapping(client, 1, "203.0.113.10", { mappingConfirmed: true });
    seedCidrMapping(client, 2, "203.0.114.0/24");
    const asnMapping = {
      id: nextMappingId++,
      organizationId: 3,
      mappingType: "ASN",
      ipStart: null,
      ipEnd: null,
      prefixLength: null,
      asn: 64500,
      enabled: true,
      mappingConfirmed: false,
      validFrom: null,
      validUntil: null,
    };
    client._stores.assetMappings.set(asnMapping.id, asnMapping);
    seedExactIpMapping(client, 1, "203.0.116.10");
    seedExactIpMapping(client, 2, "203.0.116.10"); // ambiguous with the above

    await resolveOneFinding(1, { client, asOf: ASOF });
    await resolveOneFinding(2, { client, asOf: ASOF });
    await resolveOneFinding(3, { client, asn: 64500, asOf: ASOF });
    await resolveOneFinding(4, { client, asOf: ASOF });
    await resolveOneFinding(5, { client, asOf: ASOF });
    await resolveOneFinding(6, { client, asOf: ASOF });
    await applyOverride(6, 3, "override for coverage test", { client, asOf: ASOF });

    const coverage = await calculateCoverage({ client });

    expect(coverage.totalFindings).toBe(6);
    expect(coverage.resolvedExactIp).toBe(1);
    expect(coverage.resolvedCidr).toBe(1);
    expect(coverage.ispAttribution).toBe(1);
    expect(coverage.ambiguous).toBe(1);
    expect(coverage.unresolved).toBe(1);
    expect(coverage.resolvedOverride).toBe(1);
    expect(coverage.mappingRegistry.enabledMappings).toBeGreaterThan(0);
    expect(coverage.mappingRegistry.confirmedMappingShare).toBeGreaterThan(0);
    expect(coverage.mappingRegistry.confirmedMappingShare).toBeLessThanOrEqual(1);
  });

  it("reports null confirmedMappingShare when there are no enabled mappings", async () => {
    const client = createFakeClient();
    const coverage = await calculateCoverage({ client });
    expect(coverage.mappingRegistry.confirmedMappingShare).toBeNull();
    expect(coverage.totalFindings).toBe(0);
  });

  it("classifies a conflicting-ASN AMBIGUOUS resolution as ambiguous, never as settled ISP attribution (P2-H1 regression)", async () => {
    const client = createFakeClient();

    seedFinding(client, 1, "203.0.119.10");
    seedOrganization(client, 1);
    seedOrganization(client, 2);

    // Two distinct organizations mapped to the SAME ASN: resolveOwnership's
    // ASN tier (ownershipResolver.js decideAtTier) produces AMBIGUOUS with
    // isIspAttribution still true — the exact state calculateCoverage must
    // not miscount as a settled ISP/ASN attribution.
    const asnMappingA = {
      id: nextMappingId++,
      organizationId: 1,
      mappingType: "ASN",
      ipStart: null,
      ipEnd: null,
      prefixLength: null,
      asn: 64999,
      enabled: true,
      mappingConfirmed: false,
      validFrom: null,
      validUntil: null,
    };
    const asnMappingB = { ...asnMappingA, id: nextMappingId++, organizationId: 2 };
    client._stores.assetMappings.set(asnMappingA.id, asnMappingA);
    client._stores.assetMappings.set(asnMappingB.id, asnMappingB);

    const outcome = await resolveOneFinding(1, { client, asn: 64999, asOf: ASOF });
    expect(outcome.current.status).toBe("AMBIGUOUS");
    expect(outcome.current.isIspAttribution).toBe(true);
    expect(outcome.current.candidateCount).toBe(2);

    const coverage = await calculateCoverage({ client });

    expect(coverage.ambiguous).toBe(1);
    expect(coverage.ispAttribution).toBe(0);
    expect(coverage.unknown).toBe(0);
    expect(coverage.findingsWithResolution).toBe(1);
  });
});
