import { describe, it, expect } from "vitest";

// Phase 10A-1 — the STATIC INERTNESS GATE.
//
// ===========================================================================
// What this file is for
// ===========================================================================
// The central claim of this milestone is that it performs ZERO provider calls.
// Behavioural tests can only show that no call happened along the paths they
// exercised. This gate is stronger and cheaper: it reads the source of every
// module in the enrichmentOrchestration package and fails if any of them so
// much as IMPORTS something capable of making one.
//
// It has teeth in the way that matters — it fails the moment a future change
// adds `require("./censysProvider")` or a `fetch(` to this package, even if no
// test ever calls that code path.
//
// It is deliberately a source scan rather than a runtime spy: a runtime spy
// proves only what ran, and the thing being asserted is about what CANNOT run.

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_DIR = path.join(__dirname, "..", "..", "src", "services", "enrichmentOrchestration");

// Everything that could reach a third party, directly or by delegation.
const FORBIDDEN_IMPORT_PATTERNS = Object.freeze([
  { label: "provider registry/factory", pattern: /require\([^)]*providerRegistry/ },
  { label: "AbuseIPDB provider", pattern: /require\([^)]*abuseIpdbProvider/i },
  { label: "Censys provider", pattern: /require\([^)]*censysProvider/i },
  { label: "GreyNoise provider", pattern: /require\([^)]*greyNoiseProvider/i },
  { label: "Shodan provider", pattern: /require\([^)]*shodanProvider/i },
  { label: "Netlas provider", pattern: /require\([^)]*netlasProvider/i },
  { label: "NVD provider", pattern: /require\([^)]*nvdCveProvider/i },
  { label: "IOC enrichment runner", pattern: /require\([^)]*enrichmentRunner/ },
  { label: "vulnerability runner", pattern: /require\([^)]*vulnerabilityRunner/ },
  { label: "enrichment execution service", pattern: /require\([^)]*enrichmentExecutionService/ },
  { label: "vulnerability batch execution", pattern: /require\([^)]*vulnerabilityBatchExecution/ },
  { label: "vulnerability HTTP client", pattern: /require\([^)]*vulnerabilityHttp/ },
  { label: "axios", pattern: /require\(\s*["']axios["']\s*\)/ },
  { label: "node http", pattern: /require\(\s*["']node:https?["']\s*\)/ },
  { label: "undici", pattern: /require\(\s*["']undici["']\s*\)/ },
]);

// Direct outbound-call syntax.
const FORBIDDEN_CALL_PATTERNS = Object.freeze([
  { label: "fetch(", pattern: /(^|[^.\w])fetch\s*\(/m },
  { label: "XMLHttpRequest", pattern: /XMLHttpRequest/ },
  { label: ".lookup(", pattern: /\.lookup\s*\(/ },
]);

// Writes that would mean quota was reserved or an attempt was made. Phase
// 10A-1 must create NEITHER kind of row anywhere in this package.
const FORBIDDEN_WRITE_PATTERNS = Object.freeze([
  { label: "ProviderLookupAttempt write", pattern: /providerLookupAttempt\s*\.\s*(create|upsert|update)/ },
  { label: "ProviderDailyUsage write", pattern: /providerDailyUsage\s*\.\s*(create|upsert|update)/ },
  { label: "raw quota reservation SQL", pattern: /\$executeRaw|\$queryRaw/ },
]);

function readPackageSources() {
  return fs
    .readdirSync(PACKAGE_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(PACKAGE_DIR, name), "utf8") }));
}

describe("Phase 10A-1 inertness — the orchestration package cannot reach a provider", () => {
  const files = readPackageSources();

  it("contains the modules this milestone is supposed to contain", () => {
    const names = files.map((file) => file.name).sort();
    expect(names).toEqual([
      "enrichmentApplicabilityRouter.js",
      "enrichmentDecisionCodes.js",
      "enrichmentIdentity.js",
      "enrichmentOrchestrationConfig.js",
      "enrichmentOrchestrationRepository.js",
      "enrichmentReconciliationService.js",
      "enrichmentRunReadService.js",
      "enrichmentRunService.js",
      "enrichmentSubject.js",
      "enrichmentSummaryReadService.js",
      "enrichmentUsageService.js",
    ]);
    // No worker, by name or by existence.
    expect(names).not.toContain("worker.js");
    expect(names.some((name) => /worker/i.test(name))).toBe(false);
    expect(names.some((name) => /executor/i.test(name))).toBe(false);
  });

  it("imports nothing capable of contacting a third party", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const file of files) {
      // eslint-disable-next-line no-restricted-syntax
      for (const forbidden of FORBIDDEN_IMPORT_PATTERNS) {
        const matched = forbidden.pattern.test(file.source);
        if (matched) {
          throw new Error(
            `${file.name} imports ${forbidden.label} — Phase 10A-1 must contact no provider`
          );
        }
        expect(matched).toBe(false);
      }
    }
  });

  it("makes no direct outbound call", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const file of files) {
      // eslint-disable-next-line no-restricted-syntax
      for (const forbidden of FORBIDDEN_CALL_PATTERNS) {
        // Strip comments first: the module headers legitimately DISCUSS these
        // names while explaining why they are absent from the code.
        const code = file.source
          .split("\n")
          .filter((line) => !line.trim().startsWith("//"))
          .join("\n");
        if (forbidden.pattern.test(code)) {
          throw new Error(`${file.name} contains ${forbidden.label} — no outbound call is allowed`);
        }
      }
    }
    expect(files.length).toBeGreaterThan(0);
  });

  it("writes no attempt row, no usage row and no raw SQL", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const file of files) {
      const code = file.source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      // eslint-disable-next-line no-restricted-syntax
      for (const forbidden of FORBIDDEN_WRITE_PATTERNS) {
        if (forbidden.pattern.test(code)) {
          throw new Error(`${file.name} contains ${forbidden.label} — forbidden in Phase 10A-1`);
        }
      }
    }
    expect(files.length).toBe(11);
  });

  // A literal NUL byte reached enrichmentRunService.js as a "safe" delimiter
  // inside a template literal. It is invisible in every editor, unreviewable in
  // a diff, breaks text tooling, and some toolchains reject the file outright.
  // Read as BYTES rather than as decoded text: a decoder can silently drop or
  // substitute a NUL, which would make this gate pass against a file that still
  // contains one.
  it("contains no literal NUL byte in any committed source file", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const name of fs.readdirSync(PACKAGE_DIR).filter((file) => file.endsWith(".js"))) {
      const bytes = fs.readFileSync(path.join(PACKAGE_DIR, name));
      const at = bytes.indexOf(0);
      if (at !== -1) {
        throw new Error(`${name} contains a literal NUL byte at offset ${at}`);
      }
      expect(at).toBe(-1);
    }
  });

  it("never reads a provider credential VALUE, only whether one is present", () => {
    // isProviderCredentialConfigured coerces to Boolean and returns that. No
    // module may return, log or interpolate the key itself.
    const code = files
      .filter((file) => file.name !== "enrichmentOrchestrationConfig.js")
      .map((file) => file.source)
      .join("\n");
    // eslint-disable-next-line no-restricted-syntax
    for (const key of [
      "ABUSEIPDB_API_KEY",
      "CENSYS_PAT",
      "GREYNOISE_API_KEY",
      "SHODAN_API_KEY",
      "NETLAS_API_KEY",
      "NVD_API_KEY",
    ]) {
      const codeOnly = code
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(codeOnly).not.toContain(key);
    }
  });
});

describe("Phase 10A-1 inertness — no scheduler is started anywhere", () => {
  it("starts no timer, interval or worker loop in the package", () => {
    const files = readPackageSources();
    // eslint-disable-next-line no-restricted-syntax
    for (const file of files) {
      const code = file.source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      expect(code).not.toMatch(/setInterval\s*\(/);
      expect(code).not.toMatch(/setTimeout\s*\(/);
      expect(code).not.toMatch(/new\s+Worker\s*\(/);
    }
  });

  it("leaves the reconciliation service callable but unscheduled", () => {
    // It must exist and be exported...
    const service = require("../../src/services/enrichmentOrchestration/enrichmentReconciliationService");
    expect(typeof service.reconcileDelegatedJobs).toBe("function");

    // ...and nothing in the application may CALL it. A scheduled
    // reconciliation pass is 10A-2 work.
    const appSources = [
      "src/app.js",
      "src/services/ingestion/reportIngestionService.js",
      "src/controllers/enrichmentOrchestrationController.js",
    ];
    // eslint-disable-next-line no-restricted-syntax
    for (const relative of appSources) {
      const source = fs.readFileSync(path.join(__dirname, "..", "..", relative), "utf8");
      expect(source).not.toContain("reconcileDelegatedJobs");
    }
  });
});
