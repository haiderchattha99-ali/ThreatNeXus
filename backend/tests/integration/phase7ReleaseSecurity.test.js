import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Phase 7 — release security assertions.
//
// This file covers the items in the Phase 7 brief that were NOT already pinned
// by an existing suite. It deliberately does not restate what is proven
// elsewhere:
//
//   * JWT missing/malformed/wrong-secret/expired  -> tests/unit/authMiddleware.test.js
//   * role supplied in a register body is ignored -> tests/integration/auth.test.js
//   * password/hash never in a response or audit  -> tests/integration/auth.test.js
//   * CORS allowlist, never a wildcard            -> tests/integration/appHardening.test.js
//   * header injection into the export artifact   -> tests/unit/notificationArtifactBuilder.test.js
//   * per-route capability matrices               -> tests/integration/*RouteAuthorization.test.js
//   * every mounted route is guarded              -> tests/integration/phase7RouteCensus.test.js
//   * auth/upload/provider rate limits            -> tests/integration/phase7RateLimiting.test.js

const path = require("path");
const fs = require("fs");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "phase7-release-security-secret-value-32-plus";
const ABUSEIPDB_API_KEY = "phase7-fake-abuseipdb-key-never-real-0000";
const NVD_API_KEY = "phase7-fake-nvd-key-never-real-0000";
const DATABASE_URL = "postgresql://tnx_user:tnx_password@localhost:5432/tnx_db";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL,
  JWT_SECRET,
  CORS_ORIGIN: "http://localhost:5173",
  // Deliberately non-empty so the hygiene sweep has something real to look for.
  // These are disposable literals defined in this file; no live key is read.
  ABUSEIPDB_API_KEY,
  NVD_API_KEY,
  IOC_ENRICHMENT_PROVIDER: "mock",
  AI_ENABLED: "false",
};

const prismaStub = {
  threat: {
    count: async () => 0,
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
  },
  user: { findUnique: async () => null, findFirst: async () => null },
  auditLog: { create: async () => ({ id: 1 }) },
};

let app;
let originalEnv;
const tokens = {};

beforeAll(() => {
  originalEnv = { ...process.env };
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
    exports: prismaStub,
  };

  app = require("../../src/app");

  ["ADMIN", "ANALYST", "REVIEWER", "VIEWER"].forEach((role, index) => {
    tokens[role] = jwt.sign(
      { id: index + 1, email: `${role.toLowerCase()}@example.test`, role },
      JWT_SECRET
    );
  });
});

afterAll(() => {
  process.env = originalEnv;
});

const auth = (role) => ({ Authorization: `Bearer ${tokens[role]}` });

// ---------------------------------------------------------------------------

describe("Phase 7 — token forgery beyond the signature check", () => {
  function unsignedToken(payload) {
    const encode = (object) =>
      Buffer.from(JSON.stringify(object)).toString("base64url");
    // alg:none with an empty signature — the classic "the library trusted the
    // header" bypass.
    return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
  }

  it("rejects an alg:none token claiming ADMIN", async () => {
    const forged = unsignedToken({ id: 1, email: "attacker@example.test", role: "ADMIN" });

    const res = await request(app).get("/api/profile").set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it("rejects a token whose payload was edited after signing", async () => {
    // Take a legitimate VIEWER token, swap the role to ADMIN, keep the original
    // signature. The signature no longer covers the payload.
    const [header, , signature] = tokens.VIEWER.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ id: 4, email: "viewer@example.test", role: "ADMIN" })
    ).toString("base64url");

    const res = await request(app)
      .get("/api/profile")
      .set("Authorization", `Bearer ${header}.${tamperedPayload}.${signature}`);

    expect(res.status).toBe(401);
  });

  it("rejects a token signed with a valid algorithm but the wrong key", async () => {
    const foreign = jwt.sign(
      { id: 1, email: "attacker@example.test", role: "ADMIN" },
      "a-different-secret-that-is-also-32-characters-long"
    );

    const res = await request(app).get("/api/profile").set("Authorization", `Bearer ${foreign}`);

    expect(res.status).toBe(401);
  });

  it("gives an unknown role no capability at all rather than falling back to VIEWER", async () => {
    const ghost = jwt.sign({ id: 9, email: "ghost@example.test", role: "superuser" }, JWT_SECRET);

    const res = await request(app).get("/api/threats").set("Authorization", `Bearer ${ghost}`);

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe("Phase 7 — secret hygiene across the HTTP surface", () => {
  const SECRETS = [
    ["JWT secret", JWT_SECRET],
    ["AbuseIPDB key", ABUSEIPDB_API_KEY],
    ["NVD key", NVD_API_KEY],
    ["database URL", DATABASE_URL],
    ["database password", "tnx_password"],
  ];

  // A spread of shapes: success, 401, 403, 404, and a validation failure. Error
  // paths are where configuration detail escapes, so they matter more than the
  // happy path.
  const PROBES = [
    ["GET /", () => request(app).get("/")],
    ["GET /api/profile (ok)", () => request(app).get("/api/profile").set(auth("ADMIN"))],
    ["GET /api/profile (401)", () => request(app).get("/api/profile")],
    // A real 403: VIEWER holds read:findings but no delete:records.
    ["DELETE /api/threats/1 (403)", () => request(app).delete("/api/threats/1").set(auth("VIEWER"))],
    ["GET /api/nope (404)", () => request(app).get("/api/nope")],
    [
      "POST /api/auth/login (400)",
      () => request(app).post("/api/auth/login").send({ email: "not-an-email" }),
    ],
    [
      "GET /api/findings?riskBand=SEVERE (validation)",
      () => request(app).get("/api/findings?riskBand=SEVERE").set(auth("ANALYST")),
    ],
  ];

  for (const [probeName, probe] of PROBES) {
    it(`returns no configured secret from ${probeName}`, async () => {
      const res = await probe();
      const serialized = JSON.stringify(res.body || {}) + JSON.stringify(res.headers || {}) + (res.text || "");

      for (const [secretName, secretValue] of SECRETS) {
        expect(serialized, `${probeName} leaked the ${secretName}`).not.toContain(secretValue);
      }
    });
  }

  it("does not echo a provider base URL or raw provider error to the client", async () => {
    const res = await request(app).get("/api/findings/1/enrichments").set(auth("ANALYST"));
    const serialized = JSON.stringify(res.body || {}) + (res.text || "");

    expect(serialized).not.toContain("api.abuseipdb.com");
    expect(serialized).not.toContain("services.nvd.nist.gov");
    expect(serialized).not.toContain("first.org");
  });
});

// ---------------------------------------------------------------------------

describe("Phase 7 — export surface and CSV formula injection", () => {
  // The brief requires that CSV formula injection (leading =, +, -, @) be
  // neutralized in exports. The honest state of this system is that it has no
  // CSV export to neutralize: the only artifact it produces is a notification
  // in RFC-5322 (.eml) or plain text (.txt), and neither is evaluated by a
  // spreadsheet.
  //
  // Inventing a CSV exporter in a release-hardening phase so that a sanitizer
  // would have something to sanitize would be adding a product feature, which
  // this phase forbids. So the control is enforced as a FORWARD GUARD: these
  // tests fail the moment a CSV-emitting surface appears, at which point the
  // neutralization must be written along with it.

  const exportFormats = () => require("../../src/services/notification/notificationRules").EXPORT_FORMATS;

  it("offers exactly two export formats, neither of which is a spreadsheet", () => {
    expect(exportFormats()).toEqual({ EML: "EML", TXT: "TXT" });
  });

  it("emits no text/csv content type anywhere in the application source", () => {
    // The guard. If a findings/case/audit CSV export is added later, this fails
    // and the person adding it has to come back to this file and implement the
    // leading =, +, -, @ neutralization for the cells.
    const srcRoot = path.join(__dirname, "..", "..", "src");
    const offenders = [];

    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        const contents = fs.readFileSync(full, "utf8");
        // The ingestion parser legitimately READS text/csv uploads. Only an
        // outbound content type or attachment disposition is a CSV export.
        if (/Content-Type[^\n]*text\/csv|contentType[^\n]*text\/csv|CONTENT_TYPES[^\n]*text\/csv/i.test(contents)) {
          offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);

    expect(
      offenders,
      "A CSV export surface appeared. Implement leading =, +, -, @ cell " +
        "neutralization for it and replace this forward guard with a real test."
    ).toEqual([]);
  });

  it("carries a formula-shaped value through the artifact as inert text", () => {
    // A hostile cell can reach the system through an ingested report and end up
    // quoted in a notification body. In .eml/.txt it is inert — nothing
    // evaluates it — and the assertion that matters is that it stays EXACTLY as
    // written, so an analyst reviewing the artifact sees the hostile string
    // rather than a silently rewritten one.
    const { buildArtifact } = require("../../src/services/notification/notificationArtifactBuilder");
    const hostile = "=cmd|'/c calc'!A1";

    const artifact = buildArtifact({
      revision: {
        revisionNumber: 1,
        subject: "Accessible RDP exposure",
        body: `Observed indicator: ${hostile}`,
        recipientName: "Network Operations",
        recipientEmail: "noc@example.test",
      },
      notificationReference: "TNX-N-0001",
      exportedAt: new Date("2026-08-05T00:00:00.000Z"),
      format: "TXT",
    });

    const text = artifact.bytes.toString("utf8");
    expect(text).toContain(hostile);
    expect(artifact.contentType).toBe("text/plain; charset=utf-8");
    expect(artifact.contentType).not.toContain("csv");
  });

  it("refuses, rather than silently strips, a CRLF injected into a header field", () => {
    const { buildArtifact } = require("../../src/services/notification/notificationArtifactBuilder");

    expect(() =>
      buildArtifact({
        revision: {
          revisionNumber: 1,
          subject: "Exposure\r\nBcc: attacker@example.test",
          body: "body",
          recipientName: "Network Operations",
          recipientEmail: "noc@example.test",
        },
        notificationReference: "TNX-N-0001",
        exportedAt: new Date("2026-08-05T00:00:00.000Z"),
        format: "EML",
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("Phase 7 — no transport exists", () => {
  it("ships no SMTP, webhook or messaging client", () => {
    // "Export is not delivery" is a locked product semantic. The strongest form
    // of that claim is that there is nothing in the dependency tree that COULD
    // deliver.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
    );
    const dependencies = Object.keys(manifest.dependencies || {});

    const transports = ["nodemailer", "smtp", "sendgrid", "mailgun", "postmark", "ses", "twilio", "axios", "node-fetch", "got", "superagent"];
    const found = dependencies.filter((name) =>
      transports.some((transport) => name.toLowerCase().includes(transport))
    );

    expect(found, `Unexpected transport-capable dependency: ${found.join(", ")}`).toEqual([]);
  });
});
