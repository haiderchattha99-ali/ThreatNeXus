"use strict";

// `npm run demo:reset` drops a schema. These are the tests that keep it from
// ever dropping the wrong one.
//
// Every guard is asserted independently, and each is asserted to be the ONLY
// thing standing between a wrong invocation and the destructive step — a guard
// that silently depends on another guard is not a guard.

import { describe, it, expect } from "vitest";

const {
  evaluateResetGuards,
  extractDatabaseName,
  DATABASE_NAME_DEMO_MARKER,
  FORBIDDEN_DATABASE_NAMES,
} = require("../../src/scripts/demoReset");

// The one environment in which the reset is allowed to proceed.
const ALLOWED = Object.freeze({
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@postgres:5432/threatnexus_demo?schema=public",
  DEMO_RESET_CONFIRM: "threatnexus_demo",
  AUTO_ENRICHMENT_ENABLED: "false",
});

function withoutKey(key) {
  const copy = { ...ALLOWED };
  delete copy[key];
  return copy;
}

describe("demoReset — the allowed case", () => {
  it("permits exactly the fully-guarded disposable demo environment", () => {
    const result = evaluateResetGuards(ALLOWED);
    expect(result.refusals).toEqual([]);
    expect(result.allowed).toBe(true);
    expect(result.databaseName).toBe("threatnexus_demo");
  });

  it("treats a blank AUTO_ENRICHMENT_ENABLED as off, not as missing", () => {
    expect(evaluateResetGuards(withoutKey("AUTO_ENRICHMENT_ENABLED")).allowed).toBe(true);
  });
});

describe("demoReset — G1 production", () => {
  it("refuses NODE_ENV=production even when every other guard passes", () => {
    const result = evaluateResetGuards({ ...ALLOWED, NODE_ENV: "production" });
    expect(result.allowed).toBe(false);
    expect(result.refusals.join(" ")).toContain("G1");
  });
});

describe("demoReset — G2 disposable-database marker", () => {
  it("refuses a database name without the demo marker", () => {
    const result = evaluateResetGuards({
      ...ALLOWED,
      DATABASE_URL: "postgresql://u:p@postgres:5432/threatnexus_prod?schema=public",
      DEMO_RESET_CONFIRM: "threatnexus_prod",
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals.join(" ")).toContain("G2");
  });

  it("refuses an unparseable or missing DATABASE_URL rather than defaulting", () => {
    expect(evaluateResetGuards({ ...ALLOWED, DATABASE_URL: "" }).allowed).toBe(false);
    expect(evaluateResetGuards({ ...ALLOWED, DATABASE_URL: "not a url" }).allowed).toBe(false);
    expect(evaluateResetGuards(withoutKey("DATABASE_URL")).allowed).toBe(false);
  });

  it("uses the same marker constant the preflight and runbook document", () => {
    expect(DATABASE_NAME_DEMO_MARKER).toBe("demo");
  });
});

describe("demoReset — G3 reserved names", () => {
  it("refuses every reserved/long-lived name even if the marker is bolted on", () => {
    // `threatnexus` is the name the CONTAMINATED rehearsal stack actually ran
    // on, which is why this guard is independent of the marker check.
    FORBIDDEN_DATABASE_NAMES.forEach((name) => {
      const result = evaluateResetGuards({
        ...ALLOWED,
        DATABASE_URL: `postgresql://u:p@h:5432/${name}?schema=public`,
        DEMO_RESET_CONFIRM: name,
      });
      expect(result.allowed).toBe(false);
      expect(result.refusals.join(" ")).toContain("G3");
    });
  });
});

describe("demoReset — G4 explicit confirmation", () => {
  it("refuses when DEMO_RESET_CONFIRM is absent", () => {
    expect(evaluateResetGuards(withoutKey("DEMO_RESET_CONFIRM")).allowed).toBe(false);
  });

  it("refuses when DEMO_RESET_CONFIRM names a DIFFERENT database", () => {
    const result = evaluateResetGuards({
      ...ALLOWED,
      DEMO_RESET_CONFIRM: "some_other_demo",
    });
    expect(result.allowed).toBe(false);
    expect(result.refusals.join(" ")).toContain("G4");
  });
});

describe("demoReset — G5 automatic enrichment", () => {
  it("refuses while AUTO_ENRICHMENT_ENABLED=true", () => {
    // This is the guard that matters most in practice: seed:demo ingests
    // reports through the real pipeline, and ingestion schedules AUTOMATIC-lane
    // enrichment. Resetting in that posture re-creates, during the seed itself,
    // the very runs the reset exists to clear.
    const result = evaluateResetGuards({ ...ALLOWED, AUTO_ENRICHMENT_ENABLED: "true" });
    expect(result.allowed).toBe(false);
    expect(result.refusals.join(" ")).toContain("G5");
  });

  it("only the exact string 'true' arms it, matching parseDefaultOffSwitch", () => {
    ["TRUE", " true ", "True"].forEach((value) => {
      expect(evaluateResetGuards({ ...ALLOWED, AUTO_ENRICHMENT_ENABLED: value }).allowed).toBe(false);
    });
    ["1", "yes", "on", "false", ""].forEach((value) => {
      expect(evaluateResetGuards({ ...ALLOWED, AUTO_ENRICHMENT_ENABLED: value }).allowed).toBe(true);
    });
  });
});

describe("demoReset — reporting", () => {
  it("reports EVERY refusal at once, not just the first", () => {
    const result = evaluateResetGuards({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://u:p@h:5432/threatnexus?schema=public",
      AUTO_ENRICHMENT_ENABLED: "true",
    });
    const joined = result.refusals.join(" ");
    ["G1", "G2", "G3", "G4", "G5"].forEach((id) => expect(joined).toContain(id));
  });

  it("never echoes credentials embedded in DATABASE_URL", () => {
    const result = evaluateResetGuards({
      ...ALLOWED,
      DATABASE_URL: "postgresql://someuser:sup3rs3cret@postgres:5432/wrongname?schema=public",
      DEMO_RESET_CONFIRM: "wrongname",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sup3rs3cret");
    expect(serialized).not.toContain("someuser");
  });

  it("extractDatabaseName returns the name only, never the credentials", () => {
    expect(extractDatabaseName("postgresql://u:pw@h:5432/threatnexus_demo?schema=public")).toBe(
      "threatnexus_demo"
    );
    expect(extractDatabaseName("postgresql://u:pw@h:5432/")).toBeNull();
    expect(extractDatabaseName("")).toBeNull();
    expect(extractDatabaseName(undefined)).toBeNull();
  });
});

describe("demoReset — no provider contact", () => {
  it("imports no provider, adapter, or execution-service module", () => {
    // The same structural guarantee the canary preflight carries: a reset must
    // never be capable of spending third-party quota.
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "scripts", "demoReset.js"),
      "utf8"
    );
    const requires = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    requires.forEach((specifier) => {
      expect(specifier).not.toMatch(/Provider|provider|ExecutionService|Adapter|axios|node-fetch/);
    });
  });
});
