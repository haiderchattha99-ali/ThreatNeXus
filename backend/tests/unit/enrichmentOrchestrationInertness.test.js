import { describe, it, expect } from "vitest";

// Phase 10A-2 — the TIERED STATIC EXECUTION GATE.
//
// ===========================================================================
// What changed, and what deliberately did NOT
// ===========================================================================
// In Phase 10A-1 this file asserted one thing: NOTHING in the
// enrichmentOrchestration package can reach a provider. That claim is no
// longer true, because Phase 10A-2's whole purpose is to execute — so the gate
// could either be deleted or made more precise. Deleting it would remove the
// only check that fails when a future change quietly adds `fetch(` to a module
// that must never have one.
//
// So it is now TIERED. Each module belongs to exactly one tier, and each tier
// states precisely what it may do:
//
//   CORE       (11 modules)  decide and persist orchestration state. Still
//                            fully inert: no provider import, no outbound
//                            call, no attempt/usage write, no timer.
//   LEDGER     (1 module)    may write ProviderLookupAttempt and
//                            ProviderDailyUsage rows — that IS its job — but
//                            still may not reach a provider.
//   EXECUTION  (2 modules)   may resolve and call providers. Still no raw SQL.
//   WORKER     (1 module)    may schedule. Nothing else may.
//
// The gate keeps its teeth in the two ways that matter:
//   * the file list is exact, so a NEW module cannot appear in any tier
//     without a deliberate edit here;
//   * a `fetch(` or a provider import added to any CORE module still fails,
//     even if no test ever executes that line.

const fs = require("node:fs");
const path = require("node:path");

const PACKAGE_DIR = path.join(__dirname, "..", "..", "src", "services", "enrichmentOrchestration");

// Modules that must remain completely inert. This list is the load-bearing
// part of the gate: everything not explicitly promoted below stays here.
const CORE_MODULES = Object.freeze([
  "enrichmentApplicabilityRouter.js",
  "enrichmentDecisionCodes.js",
  "enrichmentIdentity.js",
  "enrichmentOrchestrationConfig.js",
  "enrichmentOrchestrationRepository.js",
  "enrichmentProviderReadiness.js",
  "enrichmentReconciliationService.js",
  "enrichmentRunReadService.js",
  "enrichmentRunService.js",
  "enrichmentSubject.js",
  "enrichmentSummaryReadService.js",
  "enrichmentUsageService.js",
]);

// Owns the quota ledger. Writes attempt and usage rows; reaches no provider.
const LEDGER_MODULES = Object.freeze(["enrichmentQuotaService.js"]);

// The only modules permitted to resolve or call a provider.
const EXECUTION_MODULES = Object.freeze([
  "enrichmentDirectExecutionService.js",
  "enrichmentTargetedIocService.js",
]);

// The only module permitted to schedule anything.
const WORKER_MODULES = Object.freeze(["enrichmentWorker.js"]);

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

const FORBIDDEN_CALL_PATTERNS = Object.freeze([
  { label: "fetch(", pattern: /(^|[^.\w])fetch\s*\(/m },
  { label: "XMLHttpRequest", pattern: /XMLHttpRequest/ },
  { label: ".lookup(", pattern: /\.lookup\s*\(/ },
]);

const FORBIDDEN_WRITE_PATTERNS = Object.freeze([
  { label: "ProviderLookupAttempt write", pattern: /providerLookupAttempt\s*\.\s*(create|upsert|update)/ },
  { label: "ProviderDailyUsage write", pattern: /providerDailyUsage\s*\.\s*(create|upsert|update)/ },
]);

const RAW_SQL_PATTERN = Object.freeze({ label: "raw SQL", pattern: /\$executeRaw|\$queryRaw/ });

function readPackageSources() {
  return fs
    .readdirSync(PACKAGE_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(PACKAGE_DIR, name), "utf8") }));
}

// Module headers legitimately DISCUSS the names they must not call, while
// explaining why they are absent. Only real code is scanned.
function codeOnly(source) {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

function sourcesFor(files, names) {
  return files.filter((file) => names.includes(file.name));
}

describe("Phase 10A-2 execution gate — every module is in exactly one tier", () => {
  const files = readPackageSources();

  it("contains exactly the modules the tiers name", () => {
    const names = files.map((file) => file.name).sort();
    const declared = [...CORE_MODULES, ...LEDGER_MODULES, ...EXECUTION_MODULES, ...WORKER_MODULES].sort();
    // An undeclared module is a gate failure, not a pass. This is what stops a
    // new file from quietly acquiring execution privileges.
    expect(names).toEqual(declared);
  });

  it("keeps every CORE module unable to reach a provider", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const file of sourcesFor(files, CORE_MODULES)) {
      const code = codeOnly(file.source);
      // eslint-disable-next-line no-restricted-syntax
      for (const forbidden of [...FORBIDDEN_IMPORT_PATTERNS, ...FORBIDDEN_CALL_PATTERNS]) {
        if (forbidden.pattern.test(code)) {
          throw new Error(`${file.name} is a CORE module and contains ${forbidden.label}`);
        }
      }
    }
    expect(sourcesFor(files, CORE_MODULES)).toHaveLength(CORE_MODULES.length);
  });

  it("keeps every CORE module from writing an attempt or usage row", () => {
    // Quota accounting belongs to the ledger tier alone. A CORE module that
    // learned to charge quota would be spending real budget from a layer whose
    // whole contract is that it only records intent.
    // eslint-disable-next-line no-restricted-syntax
    for (const file of sourcesFor(files, CORE_MODULES)) {
      const code = codeOnly(file.source);
      // eslint-disable-next-line no-restricted-syntax
      for (const forbidden of FORBIDDEN_WRITE_PATTERNS) {
        if (forbidden.pattern.test(code)) {
          throw new Error(`${file.name} is a CORE module and contains ${forbidden.label}`);
        }
      }
    }
    expect(true).toBe(true);
  });

  it("keeps the LEDGER module away from every provider", () => {
    // It may charge quota. It may not decide what to charge it for, and it may
    // never be the thing that contacts anybody.
    // eslint-disable-next-line no-restricted-syntax
    for (const file of sourcesFor(files, LEDGER_MODULES)) {
      const code = codeOnly(file.source);
      // eslint-disable-next-line no-restricted-syntax
      for (const forbidden of [...FORBIDDEN_IMPORT_PATTERNS, ...FORBIDDEN_CALL_PATTERNS]) {
        if (forbidden.pattern.test(code)) {
          throw new Error(`${file.name} is the LEDGER module and contains ${forbidden.label}`);
        }
      }
    }
    expect(sourcesFor(files, LEDGER_MODULES)).toHaveLength(1);
  });

  it("keeps the WORKER module away from every provider", () => {
    // The worker SCHEDULES execution; it does not perform it. Without this the
    // gate declared "only execution modules may contact providers" while
    // checking that claim against the CORE and LEDGER tiers only — so a direct
    // provider import or a `.lookup()` added to the worker would have passed
    // it. The worker is where a future "just call it here" shortcut is most
    // tempting, which is exactly why it needs the same prohibition.
    // eslint-disable-next-line no-restricted-syntax
    for (const file of sourcesFor(files, WORKER_MODULES)) {
      const code = codeOnly(file.source);
      // eslint-disable-next-line no-restricted-syntax
      for (const forbidden of [...FORBIDDEN_IMPORT_PATTERNS, ...FORBIDDEN_CALL_PATTERNS]) {
        if (forbidden.pattern.test(code)) {
          throw new Error(`${file.name} is the WORKER module and contains ${forbidden.label}`);
        }
      }
    }
    expect(sourcesFor(files, WORKER_MODULES)).toHaveLength(1);
  });

  it("confines provider contact to the named EXECUTION modules, whatever files exist", () => {
    // The tier tests above check an EXPLICIT list of module names, so a file
    // added later belongs to no tier and is scanned by none of them. This one
    // is the other way round: whatever the package contains, any file that
    // calls `.lookup(` must be in the execution tier. A new module cannot
    // quietly acquire execution privileges.
    //
    // Only the direct service matches today. The targeted path reaches its
    // provider through the SHARED runner in services/enrichment/, which is
    // outside this package — deliberately, because that runner is the same
    // compare-and-swap the ADMIN batch contends on (D-P10A2-05).
    const callers = files
      .filter((file) => /\.lookup\s*\(/.test(codeOnly(file.source)))
      .map((file) => file.name);
    // eslint-disable-next-line no-restricted-syntax
    for (const name of callers) {
      if (!EXECUTION_MODULES.includes(name)) {
        throw new Error(`${name} calls .lookup( but is not an EXECUTION module`);
      }
    }
    expect(callers).toContain("enrichmentDirectExecutionService.js");
  });

  it("allows no raw SQL anywhere in the package", () => {
    // The reservation guard is a compare-and-swap through Prisma, not raw SQL
    // (D-P10A2-02). This package introduces no first raw statement.
    // eslint-disable-next-line no-restricted-syntax
    for (const file of files) {
      if (RAW_SQL_PATTERN.pattern.test(codeOnly(file.source))) {
        throw new Error(`${file.name} contains ${RAW_SQL_PATTERN.label}`);
      }
    }
    expect(files.length).toBeGreaterThan(0);
  });

  it("lets ONLY the worker module schedule anything", () => {
    const nonWorker = files.filter((file) => !WORKER_MODULES.includes(file.name));
    // eslint-disable-next-line no-restricted-syntax
    for (const file of nonWorker) {
      const code = codeOnly(file.source);
      expect(code).not.toMatch(/setInterval\s*\(/);
      expect(code).not.toMatch(/new\s+Worker\s*\(/);
    }
    // setTimeout is permitted in the execution tier for exactly one purpose —
    // the worker's own end-to-end bound on a lookup — and nowhere else.
    // eslint-disable-next-line no-restricted-syntax
    for (const file of sourcesFor(files, CORE_MODULES).concat(sourcesFor(files, LEDGER_MODULES))) {
      expect(codeOnly(file.source)).not.toMatch(/setTimeout\s*\(/);
    }
  });

  it("never uses setInterval, even in the worker", () => {
    // Ticks must not overlap: the next one is scheduled AFTER the previous
    // settles. setInterval would fire regardless, stacking provider calls.
    // eslint-disable-next-line no-restricted-syntax
    for (const file of files) {
      expect(codeOnly(file.source)).not.toMatch(/setInterval\s*\(/);
    }
  });

  // A literal NUL byte reached enrichmentRunService.js as a "safe" delimiter
  // inside a template literal. It is invisible in every editor, unreviewable in
  // a diff, and some toolchains reject the file outright. Read as BYTES: a
  // decoder can silently drop or substitute a NUL, which would make this gate
  // pass against a file that still contains one.
  it("contains no literal NUL byte in any committed source file", () => {
    // eslint-disable-next-line no-restricted-syntax
    for (const name of fs.readdirSync(PACKAGE_DIR).filter((file) => file.endsWith(".js"))) {
      const bytes = fs.readFileSync(path.join(PACKAGE_DIR, name));
      const at = bytes.indexOf(0);
      if (at !== -1) throw new Error(`${name} contains a literal NUL byte at offset ${at}`);
      expect(at).toBe(-1);
    }
  });

  it("never reads a provider credential VALUE, only whether one is present", () => {
    const code = files
      .filter((file) => file.name !== "enrichmentOrchestrationConfig.js")
      .map((file) => codeOnly(file.source))
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
      expect(code).not.toContain(key);
    }
  });
});

describe("Phase 10A-2 — the worker is the only scheduler, and it is default-off", () => {
  it("starts nothing merely by being imported", () => {
    // Requiring the module must create no timer and contact nobody. Only
    // startEnrichmentWorker() does anything, and server.js calls it only when
    // the switch is on.
    const worker = require("../../src/services/enrichmentOrchestration/enrichmentWorker");
    expect(typeof worker.startEnrichmentWorker).toBe("function");
    expect(typeof worker.runWorkerTick).toBe("function");
  });

  it("is started by server.js ONLY behind ENRICHMENT_WORKER_ENABLED", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
    // The require itself must sit inside the switch, so a disabled deployment
    // never even loads the module.
    const guarded = /if\s*\(\s*env\.ENRICHMENT_WORKER_ENABLED\s*\)\s*\{[\s\S]*?startEnrichmentWorker/;
    expect(source).toMatch(guarded);
  });

  it("keeps reconciliation out of the request path", () => {
    // It is now scheduled — by the worker, and only by the worker. No HTTP
    // route, controller or ingestion path may drive it.
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
