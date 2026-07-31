"use strict";

// ===========================================================================
// Phase 2 closing packet — bounded, database-pushed candidate selection for
// mapping-change ownership re-resolution.
//
// WHY THIS MODULE EXISTS
// ----------------------
// findingOwnershipService.reResolveFindingsForMapping used to do this:
//
//     const allFindings = await client.finding.findMany({ ... });   // EVERY row
//     const affected = allFindings.filter(...)                      // in JS
//
// That is an unbounded full-table read whose cost grows with the Finding
// table forever, on an ADMIN HTTP request path. This module replaces it with
// filtering PostgreSQL can actually execute, without raw SQL, without a new
// index, and without a migration (the schema is frozen at 14 migrations for
// this packet).
//
// THE SCHEMA CONSTRAINT THAT SHAPES EVERYTHING HERE
// -------------------------------------------------
// AssetMapping stores ipStart/ipEnd as BigInt, so mapping-vs-mapping range
// work is plain numeric comparison. Finding does NOT: `indicatorValue` is a
// String and there is no integer column and no ASN column on Finding. So
// "which Findings fall inside this CIDR" cannot be expressed as a numeric
// BETWEEN in the database as the schema stands.
//
// A lexical range (indicatorValue gte "10.0.0.0" lte "10.0.0.255") is WRONG:
// string ordering is not address ordering ("10.0.0.9" > "10.0.0.10"), so it
// would silently skip real rows. That is exactly the "no broad prefix
// matching that mistakes textual IPv4 prefixes for CIDRs" trap.
//
// THE NARROWEST SAFE HYBRID
// -------------------------
// A CIDR range is always block-aligned, so it decomposes exactly into whole
// octet-aligned blocks, and each block is expressible as an indexed
// `startsWith` prefix that ends in a dot:
//
//     p >= 24   -> one   "a.b.c."  prefix   (overshoots by at most one /24)
//     16<=p<24  -> 2^(24-p) <= 256 "a.b.c." prefixes   (EXACT)
//      8<=p<16  -> 2^(16-p) <= 256 "a.b."   prefixes   (EXACT)
//        p< 8   -> 2^(8-p)  <= 256 "a."     prefixes   (EXACT)
//
// so the filter is never more than 256 OR'd indexed conditions for ANY prefix
// length including /0, and it is exact for every p <= 24. Only p > 24
// overshoots, and only ever within a single /24 — at most 256 addresses, which
// the caller then narrows with real BigInt containment.
//
// The TRAILING DOT is what makes prefix matching safe: "10.1." cannot match
// "10.10.5.1", because position 4 of that string is "0", not ".". Without the
// dot this would be the textual-prefix bug the packet explicitly forbids.
//
// The Finding table's `finding_identity` unique index is
// (indicatorValue, port, protocol, reportType) — leading with indicatorValue —
// so these prefix predicates are index-supported rather than sequential scans.
// ===========================================================================

const { AssetMappingType } = require("@prisma/client");

const { isValidIpv4, ipv4ToInt, intToIpv4 } = require("./ipv4Cidr");

// A single mapping never expands into more OR'd predicates than this. The
// ladder above guarantees it is reachable for every prefix length 0..32.
const MAX_PREFIX_FILTERS = 256;

// Octet boundaries, finest first. Finest-that-fits is deliberate: it produces
// the TIGHTEST database filter (exact for every prefix length <= 24), which is
// what keeps unrelated Findings from being read at all. Choosing the coarsest
// instead would mean one predicate but a filter overshooting to a whole /16 or
// /8, loading rows this mapping cannot possibly own.
const OCTET_SHIFTS = Object.freeze([8n, 16n, 24n]);

const CANDIDATE_FILTER_KIND = Object.freeze({
  EXACT: "EXACT",
  PREFIX: "PREFIX",
  NONE: "NONE",
});

/**
 * Decomposes an inclusive [ipStart, ipEnd] BigInt range into the tightest set
 * of octet-aligned dotted-quad string filters that PostgreSQL can evaluate
 * against Finding.indicatorValue.
 *
 * Pure: no Prisma, no clock, no I/O. Returns
 *   { kind: "EXACT",  values: ["1.2.3.4"] }            — single address
 *   { kind: "PREFIX", values: ["1.2.3.", "1.2.4."] }   — startsWith prefixes
 *   { kind: "NONE",   values: [] }                     — nothing selectable
 *
 * The returned filter is always a SUPERSET of the range (never a subset), so a
 * caller that re-checks exact containment can rely on it for correctness.
 */
function deriveIndicatorFilters(ipStart, ipEnd) {
  if (typeof ipStart !== "bigint" || typeof ipEnd !== "bigint" || ipEnd < ipStart) {
    return { kind: CANDIDATE_FILTER_KIND.NONE, values: [] };
  }

  if (ipStart === ipEnd) {
    return { kind: CANDIDATE_FILTER_KIND.EXACT, values: [intToIpv4(ipStart)] };
  }

  for (const shift of OCTET_SHIFTS) {
    const firstBlock = ipStart >> shift;
    const lastBlock = ipEnd >> shift;
    const blockCount = lastBlock - firstBlock + 1n;
    if (blockCount > BigInt(MAX_PREFIX_FILTERS)) continue;

    // shift 8n -> 3 leading octets ("a.b.c."), 16n -> 2 ("a.b."), 24n -> 1 ("a.").
    const octetsKept = 4 - Number(shift) / 8;
    const values = [];
    for (let block = firstBlock; block <= lastBlock; block += 1n) {
      const blockBase = block << shift;
      values.push(`${intToIpv4(blockBase).split(".").slice(0, octetsKept).join(".")}.`);
    }
    return { kind: CANDIDATE_FILTER_KIND.PREFIX, values };
  }

  // Unreachable for any 0..32 prefix length (a /0 needs only 256 "a." filters),
  // but returning NONE rather than throwing keeps a corrupt row from taking an
  // ADMIN request down — the caller reports zero candidates instead.
  return { kind: CANDIDATE_FILTER_KIND.NONE, values: [] };
}

// Prisma `where` fragment selecting Findings whose indicatorValue could fall
// inside the mapping's range. Null when the mapping has no usable range (ASN
// mappings, or a row with null ipStart/ipEnd).
function buildRangeWhere(mapping) {
  if (!mapping || typeof mapping.ipStart !== "bigint" || typeof mapping.ipEnd !== "bigint") {
    return null;
  }
  const filter = deriveIndicatorFilters(mapping.ipStart, mapping.ipEnd);
  if (filter.kind === CANDIDATE_FILTER_KIND.EXACT) {
    return { indicatorValue: { in: filter.values } };
  }
  if (filter.kind === CANDIDATE_FILTER_KIND.PREFIX) {
    return { OR: filter.values.map((prefix) => ({ indicatorValue: { startsWith: prefix } })) };
  }
  return null;
}

// True only when the Finding's address really is inside the mapping range.
// Needed because a p > 24 mapping's "a.b.c." prefix filter overshoots to the
// whole /24 — the database narrowed the read, this makes the decision exact.
function findingIsInMappingRange(indicatorValue, mapping) {
  if (!isValidIpv4(indicatorValue)) return false;
  if (typeof mapping.ipStart !== "bigint" || typeof mapping.ipEnd !== "bigint") return false;
  const ip = ipv4ToInt(indicatorValue);
  return ip >= mapping.ipStart && ip <= mapping.ipEnd;
}

/**
 * One bounded, deterministic page of Finding ids affected by a mapping
 * mutation, read straight out of PostgreSQL.
 *
 * Two candidate sources are unioned:
 *
 *   A. RANGE — Findings whose indicatorValue falls inside the mapping's
 *      address range. Covers "this mapping could newly own these". Only
 *      EXACT_IP/CIDR mappings have a range.
 *
 *   B. PRIOR ATTRIBUTION — Findings whose CURRENT ownership row was matched to
 *      this mapping (matchedMappingId). Covers "this mapping used to own
 *      these, and after a disable/organization change they must be re-decided".
 *      This source is what lets a disabled ASN mapping release the Findings it
 *      previously attributed, even though Finding stores no ASN of its own.
 *
 * Both sources are cursor-paginated on the SAME key (Finding id, ascending),
 * each taking `take` rows, then merged/deduped/sliced to `take`. Because each
 * source independently returns its own first `take` ids after the cursor, the
 * merged slice can never skip an id that either source would have produced —
 * and because the cursor only ever moves forward over an immutable key
 * (indicatorValue never changes and Findings are never hard-deleted), no row
 * is processed twice. That is the "no offset race" property: an OFFSET would
 * shift under concurrent ownership writes, a keyset cursor does not.
 *
 * Only `id` and `indicatorValue` are selected — no include tree, no
 * organization or mapping join, so there is no N+1.
 */
async function selectCandidateFindingIdPage(client, mapping, { afterId = 0, take } = {}) {
  const cursorFilter = Number.isInteger(afterId) && afterId > 0 ? { id: { gt: afterId } } : {};
  const pageSize = Number.isInteger(take) && take > 0 ? take : 100;

  const rangeWhere = buildRangeWhere(mapping);

  const [rangeRows, priorRows] = await Promise.all([
    rangeWhere
      ? client.finding.findMany({
          where: { AND: [rangeWhere, cursorFilter] },
          select: { id: true, indicatorValue: true },
          orderBy: { id: "asc" },
          take: pageSize,
        })
      : Promise.resolve([]),
    client.findingOwnership.findMany({
      where: {
        matchedMappingId: mapping.id,
        currentForFindingId: { not: null },
        ...(Number.isInteger(afterId) && afterId > 0 ? { findingId: { gt: afterId } } : {}),
      },
      select: { findingId: true },
      orderBy: { findingId: "asc" },
      take: pageSize,
    }),
  ]);

  const ids = new Set();
  // Range hits are re-checked exactly: the prefix filter may have overshot
  // within one /24 for a mapping finer than /24.
  rangeRows.forEach((row) => {
    if (findingIsInMappingRange(row.indicatorValue, mapping)) ids.add(row.id);
  });
  // Prior-attribution hits need no range check — they are selected by the
  // ownership row that names this mapping, which is authoritative regardless
  // of whether the address still falls in range.
  priorRows.forEach((row) => ids.add(row.findingId));

  const ordered = [...ids].sort((a, b) => a - b);
  const page = ordered.slice(0, pageSize);

  return {
    findingIds: page,
    // More work remains if either source filled its page, or the merge itself
    // overflowed. Never a COUNT(*) over the whole table.
    hasMore:
      ordered.length > pageSize ||
      rangeRows.length === pageSize ||
      priorRows.length === pageSize,
    nextAfterId: page.length > 0 ? page[page.length - 1] : afterId,
  };
}

// An ASN mapping can still release Findings it previously attributed (source B
// above), but it can never newly acquire one, because Finding stores no ASN.
// Callers surface this as an explicit flag rather than silently under-reporting.
function mappingCanAcquireNewFindings(mapping) {
  return Boolean(mapping) && mapping.mappingType !== AssetMappingType.ASN;
}

module.exports = {
  MAX_PREFIX_FILTERS,
  CANDIDATE_FILTER_KIND,
  deriveIndicatorFilters,
  buildRangeWhere,
  findingIsInMappingRange,
  selectCandidateFindingIdPage,
  mappingCanAcquireNewFindings,
};
