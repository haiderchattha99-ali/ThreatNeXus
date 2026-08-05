import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Phase 6.3 — the ATT&CK catalogue, the navigator, and the explicit
// "no reference applies" determination, over the real HTTP surface.
//
// Same construction as frameworkRouteAuthorization: only Prisma is stubbed, so
// the real routes, the real middleware chain, the real controllers and the real
// services all run. A denied request is proven to have created NO ROW, not
// merely to have answered 403.
//
// The truth assertions are the point of the navigator tests. A dashboard that
// prints a coverage percentage is not a smaller version of an honest one — it
// is a different claim, and the build guard forbids it. So the suite asserts
// the ABSENCE of one, on every shape of response, including the empty one.

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { createWorkflowPrismaFake } = require("../unit/fixtures/workflowPrismaFake");
const {
  pinnedAttackVersion,
  CASE_RESPONSE_EVIDENCE_TEXT,
  evidenceFields,
} = require("../fixtures/frameworkEvidenceFixtures");

// Self-defaulted, never inherited from the shell — an exported JWT_SECRET would
// make the server verify with a different secret than tokenFor() signs with,
// and every request would 401 in a way that reads like an authorization
// regression.
const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  // The shipped default. Every assertion here therefore describes the system as
  // it actually ships, with AI off and no provider key anywhere.
  AI_ENABLED: "false",
  AI_PROVIDER: "null",
};

const ROLES = ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"];
const VERSION = pinnedAttackVersion();

let fake;
let client;
let state;
let app;
let errorSpy;
let ORG_ID;
let CASE_ID;
let FINDING_ID;
const tokens = {};

const prismaProxy = new Proxy(
  {},
  {
    get(_target, property) {
      return client[property];
    },
    has(_target, property) {
      return property in client;
    },
  }
);

beforeAll(() => {
  Object.assign(process.env, BASE_ENV);

  const prismaPath = require.resolve("../../src/config/prisma");
  const marker = `${path.sep}src${path.sep}`;
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(marker)) delete require.cache[key];
  });
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: prismaProxy,
  };

  app = require("../../src/app");

  ROLES.forEach((role, index) => {
    tokens[role] = jwt.sign(
      { id: index + 1, email: `${role.toLowerCase()}@example.test`, role },
      JWT_SECRET
    );
  });
});

afterAll(() => {
  ROLES.forEach((role) => delete tokens[role]);
});

const as = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

const ATTACK_BODY = {
  framework: "MITRE_ATTACK",
  frameworkVersion: VERSION,
  referenceId: "T1021.001",
  referenceTitle: "Remote Desktop Protocol",
  mappingScope: "CASE",
  evidenceBasis: "OBSERVED_BEHAVIOR",
  rationale:
    "The constituent's SOC observed an interactive remote desktop session established by an " +
    "unrecognised account outside business hours and confirmed it in their authentication logs.",
  ...evidenceFields(),
};

async function seed() {
  const organization = await client.organization.create({
    data: { name: "Navigator Co", sector: "FINANCE", contactPerson: "SOC", email: "soc@nav.test" },
  });
  ORG_ID = organization.id;

  ROLES.forEach(() => undefined);
  await client.user.create({
    data: { name: "N. Analyst", email: "analyst@example.test", role: "ANALYST" },
  });

  const finding = await client.finding.create({
    data: {
      indicatorValue: "203.0.113.77",
      port: 3389,
      protocol: "TCP",
      reportType: "ACCESSIBLE_RDP",
      firstSeen: new Date("2026-08-02T00:00:00.000Z"),
      lastSeen: new Date("2026-08-04T00:00:00.000Z"),
      occurrenceCount: 2,
    },
  });
  FINDING_ID = finding.id;

  const record = await client.case.create({
    data: {
      title: "Accessible RDP",
      threatType: "Accessible RDP",
      organization: "Navigator Co",
      analyst: "n.analyst",
      organizationId: ORG_ID,
      lifecycleState: "OPEN",
      caseReference: "TNX-2026-000077",
    },
  });
  CASE_ID = record.id;

  await client.caseFinding.create({
    data: {
      caseId: CASE_ID,
      findingId: FINDING_ID,
      state: "LINKED",
      organizationId: ORG_ID,
      ownershipStatusAtLink: "RESOLVED",
      ownershipConfidenceAtLink: "HIGH",
      effectiveAt: new Date("2026-08-02T00:00:00.000Z"),
      supersededAt: null,
      currentLinkKey: `${CASE_ID}:${FINDING_ID}`,
    },
  });

  await client.caseOrganizationResponse.create({
    data: {
      caseId: CASE_ID,
      responseType: "ACKNOWLEDGED",
      summary: CASE_RESPONSE_EVIDENCE_TEXT,
      occurredAt: new Date("2026-08-03T00:00:00.000Z"),
      recordedByUserId: null,
    },
  });
}

function rowCounts() {
  return {
    mappings: state.caseFrameworkMappings.length,
    assertions: state.caseFrameworkNoMappingAssertions.length,
  };
}

beforeEach(async () => {
  fake = createWorkflowPrismaFake();
  client = fake.client;
  state = fake.state;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await seed();
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("GET /api/attack/catalogue", () => {
  it("serves the pinned catalogue to every authenticated role", async () => {
    for (const role of ROLES) {
      const res = await request(app).get("/api/attack/catalogue").set(as(role));
      expect(res.status).toBe(200);
      expect(res.body.data.catalogue.attackVersion).toBe(VERSION);
      expect(res.body.data.techniques.length).toBeGreaterThan(500);
    }
  });

  it("refuses an unauthenticated request", async () => {
    const res = await request(app).get("/api/attack/catalogue");
    expect(res.status).toBe(401);
  });

  it("omits retired techniques by default and says how many it omitted", async () => {
    const res = await request(app).get("/api/attack/catalogue").set(as("ANALYST"));
    expect(res.status).toBe(200);
    // The picker must not offer a technique the validator will refuse...
    expect(res.body.data.techniques.every((t) => !t.deprecated && !t.revoked)).toBe(true);
    // ...and the omission must be visible rather than silent.
    expect(res.body.data.retiredExcluded).toBeGreaterThan(0);
  });

  it("carries auditable provenance, not just data", async () => {
    const res = await request(app).get("/api/attack/catalogue").set(as("VIEWER"));
    const { catalogue } = res.body.data;
    expect(catalogue.source.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(catalogue.source.upstreamSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(catalogue.attribution).toMatch(/MITRE/);
  });

  it("answers unknown query parameters rather than ignoring them", async () => {
    const res = await request(app)
      .get("/api/attack/catalogue?includeRetired=true&secretFilter=1")
      .set(as("ANALYST"));
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain("secretFilter");
  });
});

describe("GET /api/attack/navigator", () => {
  it("reports an empty matrix honestly, with no coverage percentage", async () => {
    const res = await request(app).get("/api/attack/navigator").set(as("ANALYST"));
    expect(res.status).toBe(200);

    const { data } = res.body;
    expect(data.availability).toBe("AVAILABLE");
    expect(data.totals.activeMappings).toBe(0);
    expect(data.totals.mappedTechniques).toBe(0);
    // Every tactic is present and EMPTY — not absent, and not a gap.
    expect(data.tactics.length).toBeGreaterThanOrEqual(14);
    expect(data.tactics.every((tactic) => tactic.status === "EMPTY")).toBe(true);

    // The absence that matters most.
    expect(data.coveragePercentage).toBeNull();
    expect(data.coveragePercentageMeaning).toBe("NOT_COMPUTED_NO_HONEST_DENOMINATOR_EXISTS");
    expect(data.countMeaning).toBe("MAPPING_COUNT_NOT_COVERAGE");
  });

  it("emits no percentage, ratio or coverage figure anywhere in the payload", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send(ATTACK_BODY)
      .expect(201);

    const res = await request(app).get("/api/attack/navigator").set(as("ANALYST"));
    const blob = JSON.stringify(res.body);

    // No key that would let a UI render "62% covered" without inventing it.
    expect(blob).not.toMatch(/"coverage(Percent|Ratio|Score)"/i);
    expect(blob).not.toMatch(/"percent(age)?Mapped"/i);
    expect(blob).not.toMatch(/"mappedRatio"/i);
    // Every numeric total is a count of rows that exist.
    Object.entries(res.body.data.totals).forEach(([key, value]) => {
      if (typeof value === "number") expect(Number.isInteger(value)).toBe(true);
      expect(key).not.toMatch(/percent|ratio|coverage/i);
    });
  });

  it("counts a real mapping into its technique and its tactic", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send(ATTACK_BODY)
      .expect(201);

    const res = await request(app).get("/api/attack/navigator").set(as("ANALYST"));
    const { data } = res.body;

    const technique = data.techniques.find((t) => t.id === "T1021.001");
    expect(technique.mappingCount).toBe(1);
    expect(technique.caseCount).toBe(1);
    expect(technique.status).toBe("MAPPED");
    expect(technique.verifiedCount).toBe(1);
    expect(technique.legacyCount).toBe(0);

    const lateral = data.tactics.find((t) => t.shortName === "lateral-movement");
    expect(lateral.status).toBe("PRESENT_IN_EVIDENCE");
    expect(lateral.mappedTechniqueCount).toBe(1);

    expect(data.totals.activeMappings).toBe(1);
    expect(data.totals.casesWithMappings).toBe(1);
  });

  it("flags a legacy row for review instead of hiding or retro-verifying it", async () => {
    await client.caseFrameworkMapping.create({
      data: {
        caseId: CASE_ID,
        organizationId: ORG_ID,
        framework: "MITRE_ATTACK",
        frameworkVersion: "17.1",
        referenceId: "T1133",
        referenceTitle: "External Remote Services",
        mappingScope: "CASE",
        evidenceBasis: "OBSERVED_BEHAVIOR",
        rationale: "Recorded before the Phase 6.3 obligations existed.",
        state: "ACTIVE",
        source: "MANUAL",
        effectiveAt: new Date("2026-07-01T00:00:00.000Z"),
        supersededAt: null,
        currentMappingKey: `${CASE_ID}:MITRE_ATTACK:CASE:T1133`,
      },
    });

    const res = await request(app).get("/api/attack/navigator").set(as("REVIEWER"));
    const { data } = res.body;

    const technique = data.techniques.find((t) => t.id === "T1133");
    expect(technique.mappingCount).toBe(1);
    expect(technique.legacyCount).toBe(1);
    expect(technique.verifiedCount).toBe(0);
    expect(technique.needsReviewCount).toBe(1);

    const flagged = data.needsReview.find((m) => m.referenceId === "T1133");
    expect(flagged.reviewReasons).toContain("LEGACY_UNVERIFIED");
    expect(flagged.referenceValidated).toBe(false);
    expect(data.totals.legacyUnverified).toBe(1);
  });

  it("narrows to one constituent when asked, and rejects a bad filter", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send(ATTACK_BODY)
      .expect(201);

    const scoped = await request(app)
      .get(`/api/attack/navigator?organizationId=${ORG_ID}`)
      .set(as("ANALYST"));
    expect(scoped.body.data.totals.activeMappings).toBe(1);

    const other = await request(app)
      .get(`/api/attack/navigator?organizationId=${ORG_ID + 999}`)
      .set(as("ANALYST"));
    expect(other.body.data.totals.activeMappings).toBe(0);

    const bad = await request(app)
      .get("/api/attack/navigator?organizationId=not-a-number")
      .set(as("ANALYST"));
    expect(bad.status).toBe(400);
  });

  it("refuses an unauthenticated request", async () => {
    expect((await request(app).get("/api/attack/navigator")).status).toBe(401);
  });
});

describe("the catalogue gate over HTTP", () => {
  it("refuses a technique that does not exist, with its closed code, and writes nothing", async () => {
    const before = rowCounts();
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({ ...ATTACK_BODY, referenceId: "T9999", referenceTitle: "Invented Technique" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ATTACK_TECHNIQUE_NOT_IN_CATALOGUE");
    expect(rowCounts()).toEqual(before);
  });

  it("refuses a title that names a different technique", async () => {
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({ ...ATTACK_BODY, referenceTitle: "SQL Injection" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ATTACK_TITLE_MISMATCH");
  });

  it("refuses a version other than the pinned catalogue's", async () => {
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({ ...ATTACK_BODY, frameworkVersion: "17.1" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ATTACK_VERSION_NOT_PINNED_CATALOGUE");
  });

  it("refuses a quote that is not verbatim in the cited record, as a 409", async () => {
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send({ ...ATTACK_BODY, evidenceQuote: "the analyst is fairly sure this happened" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVIDENCE_QUOTE_NOT_VERBATIM");
  });

  it("refuses a caller trying to set a server-derived verification field", async () => {
    const forged = [
      "catalogueVerified",
      "catalogueVersion",
      "catalogueChecksum",
      "evidenceQuoteLocator",
    ];
    for (const field of forged) {
      const res = await request(app)
        .post(`/api/cases/${CASE_ID}/framework-mappings`)
        .set(as("ANALYST"))
        .send({ ...ATTACK_BODY, [field]: "forged" });
      expect(res.status).toBe(400);
      expect(res.body.fields).toContain(field);
    }
  });

  it("stores the server-derived verification, not anything the caller sent", async () => {
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send(ATTACK_BODY)
      .expect(201);

    expect(res.body.data.mapping.referenceValidated).toBe(true);
    expect(res.body.data.mapping.catalogueVersion).toBe(VERSION);
    expect(res.body.data.mapping.legacyUnverified).toBe(false);
    // Canonical MITRE spelling, adopted only after the supplied title matched.
    expect(res.body.data.mapping.referenceTitle).toBe(
      "Remote Services: Remote Desktop Protocol"
    );
    expect(res.body.data.mapping.evidenceQuoteLocator).toMatch(/^CASE_RESPONSE:\d+:summary$/);
    expect(res.body.data.mapping.confidenceMeaning).toBe(
      "EVIDENCE_AND_MAPPING_CONFIDENCE_ARE_SEPARATE_NEVER_COMBINED"
    );
  });
});

describe("no applicable mapping", () => {
  const NO_MAPPING_BODY = {
    framework: "MITRE_ATTACK",
    rationale:
      "The evidence is an exposed RDP service and nothing more. No adversary behaviour was " +
      "observed or reported, so no ATT&CK technique applies to this case.",
  };

  it("is writable only by a role that could write a mapping by hand", async () => {
    for (const role of ["REVIEWER", "VIEWER"]) {
      const before = rowCounts();
      const res = await request(app)
        .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
        .set(as(role))
        .send(NO_MAPPING_BODY);
      expect(res.status).toBe(403);
      // Denied at the middleware — no row, not even an audit-only attempt.
      expect(rowCounts()).toEqual(before);
    }

    for (const role of ["ADMIN", "ANALYST"]) {
      fake = createWorkflowPrismaFake();
      client = fake.client;
      state = fake.state;
      await seed();
      const res = await request(app)
        .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
        .set(as(role))
        .send(NO_MAPPING_BODY);
      expect(res.status).toBe(201);
    }
  });

  it("is readable by every role, because it is part of the case's framework position", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY)
      .expect(201);

    for (const role of ROLES) {
      const res = await request(app)
        .get(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
        .set(as(role));
      expect(res.status).toBe(200);
      expect(res.body.data.standing).toHaveLength(1);
      expect(res.body.data.standing[0].framework).toBe("MITRE_ATTACK");
    }
  });

  it("requires a rationale — an unexplained determination is unreviewable", async () => {
    const res = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send({ framework: "MITRE_ATTACK", rationale: "nope" });
    expect(res.status).toBe(400);
  });

  it("is mutually exclusive with an active mapping, in BOTH directions", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send(ATTACK_BODY)
      .expect(201);

    const blocked = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("NO_APPLICABLE_CONFLICTS_WITH_ACTIVE_MAPPING");

    // And the reverse: withdraw the mapping, assert, then try to map again.
    const mappingId = state.caseFrameworkMappings.find((row) => row.state === "ACTIVE").id;
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/${mappingId}/remove`)
      .set(as("ANALYST"))
      .send({ reason: "Reclassified after review; no adversary behaviour was observed." })
      .expect(200);

    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY)
      .expect(201);

    const refused = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send(ATTACK_BODY);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("MAPPING_CONFLICTS_WITH_NO_APPLICABLE_ASSERTION");
  });

  it("is append-only: withdrawing appends a row and deletes nothing", async () => {
    const created = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY)
      .expect(201);

    const assertionId = created.body.data.assertion.id;

    const withdrawn = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable/${assertionId}/withdraw`)
      .set(as("ANALYST"))
      .send({ reason: "The constituent later reported observed adversary behaviour." })
      .expect(200);

    expect(withdrawn.body.data.assertion.state).toBe("WITHDRAWN");
    expect(state.caseFrameworkNoMappingAssertions).toHaveLength(2);
    // The original row survives, superseded but unrewritten.
    const original = state.caseFrameworkNoMappingAssertions.find((r) => r.id === assertionId);
    expect(original.state).toBe("ASSERTED");
    expect(original.supersededAt).not.toBeNull();
  });

  it("writes nothing when the same determination is repeated", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY)
      .expect(201);

    const repeat = await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY);

    expect(repeat.status).toBe(200);
    expect(repeat.body.data.changed).toBe(false);
    expect(repeat.body.data.outcome).toBe("UNCHANGED");
    expect(state.caseFrameworkNoMappingAssertions).toHaveLength(1);
  });

  it("audits the determination", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY)
      .expect(201);

    const events = state.auditLogs.map((row) => row.action);
    expect(events).toContain("framework.no_mapping.asserted");
    // The rationale TEXT is not copied into the audit trail.
    const audited = state.auditLogs.find((row) => row.action === "framework.no_mapping.asserted");
    expect(JSON.stringify(audited)).not.toContain("No adversary behaviour was");
  });

  it("appears on the case mapping read, distinct from the mappings themselves", async () => {
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings/no-applicable`)
      .set(as("ANALYST"))
      .send(NO_MAPPING_BODY)
      .expect(201);

    const res = await request(app)
      .get(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("VIEWER"));

    expect(res.body.data.activeCount).toBe(0);
    expect(res.body.data.noApplicableDeterminations).toHaveLength(1);
    // "nobody looked" and "we looked and nothing applies" must never be the
    // same shape of answer.
    expect(res.body.data.noApplicableDeterminations[0].rationale).toMatch(/no ATT&CK technique/i);
  });
});

describe("AI stays off, and no provider key is anywhere near this", () => {
  it("serves the whole ATT&CK surface with AI_ENABLED=false", async () => {
    expect(process.env.AI_ENABLED).toBe("false");

    await request(app).get("/api/attack/catalogue").set(as("ANALYST")).expect(200);
    await request(app).get("/api/attack/navigator").set(as("ANALYST")).expect(200);
    await request(app)
      .post(`/api/cases/${CASE_ID}/framework-mappings`)
      .set(as("ANALYST"))
      .send(ATTACK_BODY)
      .expect(201);
  });

  it("emits no credential-shaped value on any ATT&CK response", async () => {
    const responses = await Promise.all([
      request(app).get("/api/attack/catalogue").set(as("ANALYST")),
      request(app).get("/api/attack/navigator").set(as("ANALYST")),
    ]);

    // Checked against KEY NAMES, not against the whole blob. A substring scan
    // would trip on legitimate MITRE technique names — "Unsecured Credentials",
    // "Cloud Secrets Management Stores", "Steal Application Access Token" — and
    // a test that fails on real catalogue content teaches the next person to
    // weaken it rather than to look.
    const credentialKey = /^(api[_-]?key|secret|client[_-]?secret|token|password|authorization|bearer)$/i;

    const collectKeys = (value, keys = []) => {
      if (Array.isArray(value)) value.forEach((entry) => collectKeys(entry, keys));
      else if (value && typeof value === "object") {
        Object.keys(value).forEach((key) => {
          keys.push(key);
          collectKeys(value[key], keys);
        });
      }
      return keys;
    };

    responses.forEach((res) => {
      collectKeys(res.body).forEach((key) => expect(key).not.toMatch(credentialKey));
      // And no value that looks like a bearer token or a long opaque key.
      const blob = JSON.stringify(res.body);
      expect(blob).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{20,}/);
      expect(blob).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/);
    });
  });
});
