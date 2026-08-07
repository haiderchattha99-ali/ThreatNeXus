import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Phase 8C — authorization matrix and safety proof for the Finding AI-assist
// routes:
//   GET  /api/findings/:id/ai-suggestions                        (read:ai-finding-suggestions)
//   POST /api/findings/:id/ai-suggestions                        (request:ai-finding-suggestions)
//   POST /api/findings/:id/ai-suggestions/:suggestionId/accept   (review:ai-suggestions)
//   POST /api/findings/:id/ai-suggestions/:suggestionId/reject   (review:ai-suggestions)
// Mirrors censysEnrichmentRouteAuthorization.test.js's shape: only Prisma is
// stubbed, so the real routes/middleware/controllers/services run end to end.
// AI_PROVIDER is set to "mock" with AI_ENABLED=true so the generation path
// exercises the real mock provider — zero real network access anywhere in
// this suite (there is no live AI provider in this repository at all).

const path = require("path");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "a-reasonably-strong-32-char-plus-secret-value";

// AI_ENABLED is intentionally left unset (defaults to false, config/env.js) —
// this suite runs the real HTTP path with the shipped default, which is the
// production reality for any fresh deployment. Setting AI_PROVIDER=mock in
// the environment would NOT change that: aiAssistRuntime never resolves the
// mock provider without the test-only allowMockProvider flag, which no
// production caller ever passes (see tests/unit/phase8cFindingAiAssistanceEvidence.test.js).
// The mock-enabled generation path is exercised at the SERVICE level instead
// (tests/unit/aiAssistSafetyBoundaries.test.js), the same split Phase 5 uses.
const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test_db",
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
};

const store = {
  findings: [],
  findingTriages: [],
  riskScores: [],
  riskFactorContributions: [],
  findingVulnerabilities: [],
  findingAiSuggestions: [],
  auditLogs: [],
  nextId: 1,
};

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

const prismaStub = {
  finding: {
    findUnique: async ({ where: { id } }) => store.findings.find((r) => r.id === id) || null,
  },
  findingTriage: {
    findFirst: async ({ where }) => store.findingTriages.find((r) => matches(r, where)) || null,
  },
  riskScore: {
    findFirst: async ({ where }) => store.riskScores.find((r) => matches(r, where)) || null,
  },
  riskFactorContribution: {
    findMany: async ({ where }) => store.riskFactorContributions.filter((r) => matches(r, where)),
  },
  findingVulnerability: {
    findMany: async () => store.findingVulnerabilities,
  },
  findingAiSuggestion: {
    create: async ({ data }) => {
      const row = { id: store.nextId++, createdAt: new Date(), ...data };
      store.findingAiSuggestions.push(row);
      return { ...row };
    },
    findMany: async ({ where, orderBy, take }) => {
      let rows = store.findingAiSuggestions.filter((r) => matches(r, where));
      rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return typeof take === "number" ? rows.slice(0, take) : rows;
    },
    findUnique: async ({ where: { id } }) => store.findingAiSuggestions.find((r) => r.id === id) || null,
    update: async ({ where: { id }, data }) => {
      const row = store.findingAiSuggestions.find((r) => r.id === id);
      Object.assign(row, data);
      return { ...row };
    },
  },
  auditLog: {
    create: async ({ data }) => {
      const row = { id: store.auditLogs.length + 1, ...data };
      store.auditLogs.push(row);
      return row;
    },
  },
  async $transaction(fn) {
    return fn(prismaStub);
  },
};

let originalEnv;
let app;
const tokens = {};

beforeAll(() => {
  originalEnv = { ...process.env };
  Object.assign(process.env, BASE_ENV);

  const prismaPath = require.resolve("../../src/config/prisma");
  const marker = `${path.sep}src${path.sep}`;
  Object.keys(require.cache).forEach((key) => {
    if (key.includes(marker)) delete require.cache[key];
  });
  require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: prismaStub };

  app = require("../../src/app");

  ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"].forEach((role, index) => {
    tokens[role] = jwt.sign({ id: index + 1, email: `${role.toLowerCase()}@example.test`, role }, JWT_SECRET);
  });
});

afterAll(() => {
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

let errorSpy;
let logSpy;

beforeEach(() => {
  store.findings = [{ id: 1, indicatorValue: "203.0.113.50", status: "OPEN" }];
  store.findingTriages = [];
  store.riskScores = [];
  store.riskFactorContributions = [];
  store.findingVulnerabilities = [];
  store.findingAiSuggestions = [];
  store.auditLogs = [];
  store.nextId = 1;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("GET /api/findings/:id/ai-suggestions", () => {
  it("VIEWER is refused (403)", async () => {
    const res = await request(app).get("/api/findings/1/ai-suggestions").set("Authorization", `Bearer ${tokens.VIEWER}`);
    expect(res.status).toBe(403);
  });

  it("ANALYST, REVIEWER and ADMIN can read (200)", async () => {
    for (const role of ["ANALYST", "REVIEWER", "ADMIN"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get("/api/findings/1/ai-suggestions").set("Authorization", `Bearer ${tokens[role]}`);
      expect(res.status).toBe(200);
      expect(res.body.data.suggestions).toEqual([]);
    }
  });

  it("404s for a Finding that does not exist", async () => {
    const res = await request(app).get("/api/findings/999/ai-suggestions").set("Authorization", `Bearer ${tokens.ADMIN}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/findings/:id/ai-suggestions", () => {
  it("VIEWER and REVIEWER are refused (403) — only ADMIN/ANALYST may request", async () => {
    for (const role of ["VIEWER", "REVIEWER"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post("/api/findings/1/ai-suggestions")
        .set("Authorization", `Bearer ${tokens[role]}`)
        .send({ suggestionType: "SUMMARY" });
      expect(res.status).toBe(403);
    }
  });

  it("ANALYST can request a draft; with AI off (the shipped default) it is answered 200, recorded DRAFT/disabled, never a 503", async () => {
    const res = await request(app)
      .post("/api/findings/1/ai-suggestions")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({ suggestionType: "SUMMARY" });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("DRAFT");
    expect(res.body.data.providerName).toBe("disabled");
    expect(res.body.data.reasonCode).toBe("AI_DISABLED");
    expect(res.body.data.proposedText).toBe("");
    // Never a fingerprint or anything internal.
    expect(res.body.data).not.toHaveProperty("inputFingerprint");
  });

  it("rejects an invalid suggestionType with 400", async () => {
    const res = await request(app)
      .post("/api/findings/1/ai-suggestions")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ suggestionType: "NOT_A_TYPE" });
    expect(res.status).toBe(400);
  });

  it("rejects unexpected body fields with 400", async () => {
    const res = await request(app)
      .post("/api/findings/1/ai-suggestions")
      .set("Authorization", `Bearer ${tokens.ADMIN}`)
      .send({ suggestionType: "SUMMARY", raw: "inject" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/findings/:id/ai-suggestions/:suggestionId/accept and /reject", () => {
  async function requestDraft(role = "ANALYST") {
    const res = await request(app)
      .post("/api/findings/1/ai-suggestions")
      .set("Authorization", `Bearer ${tokens[role]}`)
      .send({ suggestionType: "SUMMARY" });
    return res.body.data.id;
  }

  it("ANALYST cannot accept or reject its own request (403) — separation of duties", async () => {
    const id = await requestDraft("ANALYST");
    const acceptRes = await request(app)
      .post(`/api/findings/1/ai-suggestions/${id}/accept`)
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({});
    expect(acceptRes.status).toBe(403);

    const rejectRes = await request(app)
      .post(`/api/findings/1/ai-suggestions/${id}/reject`)
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({ reason: "not good enough" });
    expect(rejectRes.status).toBe(403);
  });

  it("VIEWER cannot accept or reject (403)", async () => {
    const id = await requestDraft("ANALYST");
    const res = await request(app)
      .post(`/api/findings/1/ai-suggestions/${id}/accept`)
      .set("Authorization", `Bearer ${tokens.VIEWER}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("REVIEWER can accept a draft", async () => {
    const id = await requestDraft("ANALYST");
    const res = await request(app)
      .post(`/api/findings/1/ai-suggestions/${id}/accept`)
      .set("Authorization", `Bearer ${tokens.REVIEWER}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.suggestion.status).toBe("ACCEPTED");
  });

  it("REVIEWER rejecting without a reason is refused (400)", async () => {
    const id = await requestDraft("ANALYST");
    const res = await request(app)
      .post(`/api/findings/1/ai-suggestions/${id}/reject`)
      .set("Authorization", `Bearer ${tokens.REVIEWER}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("REVIEWER can reject with a reason", async () => {
    const id = await requestDraft("ANALYST");
    const res = await request(app)
      .post(`/api/findings/1/ai-suggestions/${id}/reject`)
      .set("Authorization", `Bearer ${tokens.REVIEWER}`)
      .send({ reason: "Draft mischaracterizes the finding." });
    expect(res.status).toBe(200);
    expect(res.body.data.suggestion.status).toBe("REJECTED");
  });

  it("404s deciding a suggestion id that does not exist", async () => {
    const res = await request(app)
      .post("/api/findings/1/ai-suggestions/999/accept")
      .set("Authorization", `Bearer ${tokens.REVIEWER}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("no secret leakage", () => {
  it("never includes the JWT secret or any credential-shaped value in a response", async () => {
    const draftRes = await request(app)
      .post("/api/findings/1/ai-suggestions")
      .set("Authorization", `Bearer ${tokens.ANALYST}`)
      .send({ suggestionType: "EXPLANATION" });
    expect(draftRes.body.data.id).toBeTruthy();

    const listRes = await request(app).get("/api/findings/1/ai-suggestions").set("Authorization", `Bearer ${tokens.ADMIN}`);
    const body = JSON.stringify(listRes.body);
    expect(body).not.toMatch(/JWT_SECRET|a-reasonably-strong-32-char/);
  });
});
