"use strict";

// Phase 6 — the Findings read surface.
//
// The properties under test are the ones that make this endpoint safe to expose
// rather than the ones that make it convenient:
//
//   - an invalid filter is REJECTED with the field named, never ignored
//   - pagination is bounded server-side and cannot be talked out of its limit
//   - the risk-band filter matches the CURRENT score only, so a Finding that
//     was once CRITICAL does not keep appearing under CRITICAL forever
//   - the indicator filter is an anchored prefix over a restricted alphabet
//   - the serializer never selects provider/operational fields

import { describe, it, expect, vi } from "vitest";

const {
  parseListQuery,
  listFindings,
  getFindingDetail,
  FindingQueryError,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} = require("../../src/services/findings/findingReadService");

describe("parseListQuery", () => {
  it("defaults to a bounded first page sorted by last observation", () => {
    expect(parseListQuery({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      status: null,
      riskBand: null,
      reportType: null,
      indicator: null,
      sort: "lastSeen",
    });
  });

  it("rejects an unknown status by name instead of ignoring it", () => {
    expect(() => parseListQuery({ status: "MAYBE" })).toThrow(FindingQueryError);
    try {
      parseListQuery({ status: "MAYBE" });
    } catch (error) {
      expect(error.field).toBe("status");
      expect(error.status).toBe(400);
      // The rejected VALUE is never echoed back.
      expect(error.message).not.toContain("MAYBE");
    }
  });

  it("rejects an unknown risk band, report type and sort", () => {
    expect(() => parseListQuery({ riskBand: "SEVERE" })).toThrow(/riskBand must be one of/);
    expect(() => parseListQuery({ reportType: "OPEN_SMB" })).toThrow(/reportType must be one of/);
    expect(() => parseListQuery({ sort: "score" })).toThrow(/sort must be one of/);
  });

  it("refuses to be talked past the server-side page ceiling", () => {
    expect(() => parseListQuery({ pageSize: String(MAX_PAGE_SIZE + 1) })).toThrow(
      new RegExp(`between 1 and ${MAX_PAGE_SIZE}`)
    );
    expect(() => parseListQuery({ pageSize: "0" })).toThrow(FindingQueryError);
    expect(() => parseListQuery({ pageSize: "-5" })).toThrow(FindingQueryError);
    // Not silently clamped — a caller who asked for too much is told.
    expect(parseListQuery({ pageSize: String(MAX_PAGE_SIZE) }).pageSize).toBe(MAX_PAGE_SIZE);
  });

  it("rejects a non-integer or non-positive page", () => {
    expect(() => parseListQuery({ page: "1.5" })).toThrow(FindingQueryError);
    expect(() => parseListQuery({ page: "0" })).toThrow(FindingQueryError);
    expect(() => parseListQuery({ page: "abc" })).toThrow(FindingQueryError);
  });

  it("restricts the indicator filter to an IPv4 alphabet and a bounded length", () => {
    expect(parseListQuery({ indicator: "203.0.113" }).indicator).toBe("203.0.113");

    // Anything that could be a wildcard, an injection attempt or a free-text
    // scan is refused outright rather than sanitized into something else.
    for (const bad of ["203.0.%", "'; DROP TABLE", "*", "example.com", "203.0.113 OR 1=1"]) {
      expect(() => parseListQuery({ indicator: bad })).toThrow(FindingQueryError);
    }
    expect(() => parseListQuery({ indicator: "1".repeat(46) })).toThrow(FindingQueryError);
  });

  it("treats an empty filter as absent rather than as a value to match", () => {
    const parsed = parseListQuery({ status: "", riskBand: "", indicator: "", sort: "" });
    expect(parsed.status).toBeNull();
    expect(parsed.riskBand).toBeNull();
    expect(parsed.indicator).toBeNull();
    expect(parsed.sort).toBe("lastSeen");
  });
});

describe("listFindings — query shape", () => {
  function client(rows = [], total = 0) {
    return {
      finding: {
        count: vi.fn(async () => total),
        findMany: vi.fn(async () => rows),
      },
    };
  }

  it("filters the risk band against the CURRENT score row only", async () => {
    const c = client();
    await listFindings({ riskBand: "CRITICAL" }, { client: c });

    const where = c.finding.findMany.mock.calls[0][0].where;
    expect(where.riskScores.some).toEqual({
      currentForFindingId: { not: null },
      riskBand: "CRITICAL",
    });
    // The count must use the SAME predicate, or the pagination total would
    // describe a different set than the rows.
    expect(c.finding.count.mock.calls[0][0].where).toEqual(where);
  });

  it("applies the indicator filter as an anchored prefix, never a contains scan", async () => {
    const c = client();
    await listFindings({ indicator: "198.51" }, { client: c });
    expect(c.finding.findMany.mock.calls[0][0].where.indicatorValue).toEqual({
      startsWith: "198.51",
    });
  });

  it("bounds every page with skip/take and a stable tiebreaker", async () => {
    const c = client();
    await listFindings({ page: "3", pageSize: "10" }, { client: c });

    const args = c.finding.findMany.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
    // Without the id tiebreaker, two findings sharing a lastSeen could appear
    // on two consecutive pages or on neither.
    expect(args.orderBy).toEqual([{ lastSeen: "desc" }, { id: "desc" }]);
  });

  it("fetches each relation as a single bounded current row, not an N+1", async () => {
    const c = client()
    await listFindings({}, { client: c });
    const select = c.finding.findMany.mock.calls[0][0].select;

    for (const relation of ["ownershipHistory", "riskScores", "triageHistory"]) {
      expect(select[relation].take).toBe(1);
      expect(select[relation].where.currentForFindingId).toEqual({ not: null });
    }
  });

  it("reports the applied filters back so a caller cannot misread the total", async () => {
    const c = client([], 0);
    const result = await listFindings({ status: "OPEN", riskBand: "HIGH" }, { client: c });
    expect(result.appliedFilters).toMatchObject({ status: "OPEN", riskBand: "HIGH" });
    expect(result.totalPages).toBe(1);
  });
});

describe("getFindingDetail — serialization safety", () => {
  const baseFinding = {
    id: 7,
    indicatorValue: "203.0.113.24",
    port: 3389,
    protocol: "TCP",
    reportType: "ACCESSIBLE_RDP",
    status: "OPEN",
    firstSeen: new Date("2026-07-01T00:00:00Z"),
    lastSeen: new Date("2026-08-01T00:00:00Z"),
    occurrenceCount: 3,
    recurrenceCount: 1,
    closedAt: null,
    closureReason: null,
    closedThroughObservedAt: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    ownershipHistory: [],
    triageHistory: [],
    riskScores: [],
    occurrences: [],
    vulnerabilityAssociations: [],
    caseLinks: [],
  };

  it("returns null for an unknown id so the controller can answer 404", async () => {
    const client = {
      finding: { findUnique: vi.fn(async () => null) },
      iocEnrichment: { findFirst: vi.fn() },
    };
    expect(await getFindingDetail(999, { client })).toBeNull();
    // No enrichment lookup is attempted for a Finding that does not exist.
    expect(client.iocEnrichment.findFirst).not.toHaveBeenCalled();
  });

  it("never selects the enrichment columns that carry provider or operational detail", async () => {
    const client = {
      finding: { findUnique: vi.fn(async () => baseFinding) },
      iocEnrichment: { findFirst: vi.fn(async () => null) },
    };
    await getFindingDetail(7, { client });

    const select = client.iocEnrichment.findFirst.mock.calls[0][0].select;
    // IocEnrichment DOES have these columns. The allowlist must keep excluding
    // them: errorMessage and httpStatus are provider/exception text, and
    // claimToken is a queue lease credential.
    for (const forbidden of [
      "errorMessage",
      "httpStatus",
      "errorCode",
      "claimToken",
      "queryParams",
      "retryAfterSeconds",
      "leaseExpiresAt",
    ]) {
      expect(select[forbidden]).toBeUndefined();
    }
    expect(select.status).toBe(true);
    expect(select.queriedAt).toBe(true);
  });

  it("derives displayScore from stored basis points without re-scoring", async () => {
    const client = {
      finding: {
        findUnique: vi.fn(async () => ({
          ...baseFinding,
          riskScores: [
            {
              id: 3,
              scoreBasisPoints: 8271,
              riskBand: "CRITICAL",
              algorithmVersion: "risk-additive-bucketed-v1",
              configurationVersion: "v1.0.0",
              asOf: new Date("2026-08-01T00:00:00Z"),
              calculatedAt: new Date("2026-08-01T00:00:01Z"),
              trigger: "INGESTION",
              contributions: [
                {
                  factorKey: "EXPOSURE_BASE",
                  applicability: "APPLIED",
                  contributionBasisPoints: 3000,
                  maximumContributionBasisPoints: 3000,
                  normalizedInputValue: "1",
                  explanationCode: "EXPOSURE_PRESENT",
                  displayOrder: 1,
                },
              ],
            },
          ],
        })),
      },
      iocEnrichment: { findFirst: vi.fn(async () => null) },
    };

    const detail = await getFindingDetail(7, { client });

    // floor(8271 / 100) — the exact projection Phase 2 defined. Not rounded,
    // not recomputed from the factors.
    expect(detail.risk.displayScore).toBe(82);
    expect(detail.risk.scoreBasisPoints).toBe(8271);
    expect(detail.risk.riskBand).toBe("CRITICAL");
    expect(detail.risk.algorithmVersion).toBe("risk-additive-bucketed-v1");
    expect(detail.risk.contributions).toHaveLength(1);
    expect(detail.risk.contributions[0].applicability).toBe("APPLIED");
  });

  it("requests only ACTIVE current CVE associations and LINKED current case links", async () => {
    const client = {
      finding: { findUnique: vi.fn(async () => baseFinding) },
      iocEnrichment: { findFirst: vi.fn(async () => null) },
    };
    await getFindingDetail(7, { client });
    const select = client.finding.findUnique.mock.calls[0][0].select;

    expect(select.vulnerabilityAssociations.where).toEqual({
      currentAssociationKey: { not: null },
      state: "ACTIVE",
    });
    expect(select.caseLinks.where).toEqual({
      currentLinkKey: { not: null },
      state: "LINKED",
    });
  });
});
