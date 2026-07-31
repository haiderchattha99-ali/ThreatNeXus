"use strict";

// ===========================================================================
// Mutation gate for the combined Phase 2 evaluator's ownership rules.
//
// A passing gate proves nothing on its own. `eval:phase2` reports 22 scenarios
// green — but a gate that asserted too little, or compared a value against
// itself, would report exactly the same thing. This harness answers the only
// question that makes the combined gate meaningful:
//
//     WOULD IT ACTUALLY FAIL IF AN OWNERSHIP RULE BROKE?
//
// For each load-bearing ownership rule it:
//   1. re-runs the REAL combined gate in a child process,
//   2. with PHASE2_GATE_MUTATION set so exactly ONE rule is broken,
//   3. requires the gate to exit non-zero, and
//   4. requires the reported failure to name the specific scenario that guards
//      that rule.
//
// A mutation that still passes, or that fails for an unrelated reason, is
// itself reported as a failure here — the first means the rule is unguarded,
// the second means the guard is not the one we think it is.
//
// Safety: no production file is modified. Mutations exist only as a documented
// seam inside run_phase2_gate.js, applied in a child process from an
// environment variable, and are never active during a normal `eval:phase2`
// run. The same EVAL_DATABASE_URL rules apply, and the child cleans up its own
// rows whether it passed or failed.
// ===========================================================================

const path = require("path");
const { spawnSync } = require("child_process");

const GATE_PATH = path.join(__dirname, "run_phase2_gate.js");

// Each mutation names the scenario whose failure proves the rule is guarded.
// Matching on the scenario id (not merely "something failed") is what stops a
// mutation from passing this harness for an unrelated reason.
const MUTATIONS = Object.freeze([
  {
    id: "M01_exact_ip_precedence",
    rule: "an exact-IP mapping outranks any CIDR mapping",
    expectFailureIn: "04_exact_ip_resolves",
  },
  {
    id: "M02_longest_cidr_precedence",
    rule: "the longest matching CIDR prefix wins; shorter prefixes never break the tie",
    expectFailureIn: "05_longest_prefix_wins",
  },
  {
    id: "M03_tied_specificity_ambiguity",
    rule: "equally specific mappings for different organizations stay AMBIGUOUS, never silently resolved",
    expectFailureIn: "06_tied_specificity_ambiguous",
  },
  {
    id: "M04_override_preservation",
    rule: "an explicit analyst override survives automatic re-resolution",
    expectFailureIn: "11_override_preserved",
  },
  {
    id: "M05_sector_applicability_gate",
    rule: "sectorCriticality applies only when ownership is strong enough to attribute",
    expectFailureIn: "12_sector_gate_follows_ownership",
  },
  {
    // Guarded by scenario 08, not 09, and the difference matters. 08 asserts
    // WHICH Findings were selected as candidates (candidateCount), which this
    // mutation breaks immediately. 09 asserts an unrelated Finding's ownership
    // row was not REWRITTEN — and it correctly still passes under this
    // mutation, because re-resolving an unrelated Finding with a still-correct
    // resolver reaches the same answer and writes nothing. Selecting too much
    // work and corrupting an unrelated row are two different failures with two
    // different guards.
    id: "M06_unaffected_finding_exclusion",
    rule: "a mapping change selects only the Findings it can affect as candidates",
    expectFailureIn: "08_mapping_change_affects_only_targets",
  },
]);

function runGate(mutationId) {
  const result = spawnSync(process.execPath, [GATE_PATH], {
    env: { ...process.env, PHASE2_GATE_MUTATION: mutationId || "" },
    encoding: "utf8",
    // Generous: the child runs the full 22-scenario gate against a real database.
    timeout: 300000,
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function main() {
  if (!process.env.EVAL_DATABASE_URL || process.env.EVAL_DATABASE_URL.trim() === "") {
    console.error(
      "EVAL_DATABASE_URL is required. Refusing to run without an explicit, dedicated evaluation database."
    );
    process.exitCode = 1;
    return;
  }

  // 1. The unmutated gate must pass. Without this, a mutation "failing" would
  //    prove nothing — the gate might be failing for an unrelated reason.
  console.log("Baseline (no mutation):");
  const baseline = runGate(null);
  if (baseline.status !== 0) {
    console.log("FAIL — the unmutated combined gate does not pass; fix that before reading below.");
    console.log(baseline.stdout.split("\n").slice(-15).join("\n"));
    console.log(baseline.stderr.slice(0, 2000));
    process.exitCode = 1;
    return;
  }
  console.log("  PASS — baseline eval:phase2 is green\n");

  // 2. Every mutation must be detected, by the right scenario.
  const failures = [];
  MUTATIONS.forEach((mutation) => {
    const run = runGate(mutation.id);

    if (run.status === 0) {
      failures.push(`${mutation.id} was NOT detected — the gate still passed. Rule is unguarded: ${mutation.rule}`);
      console.log(`  UNDETECTED  ${mutation.id}`);
      return;
    }

    const failedScenario = run.stdout.includes(`FAIL  ${mutation.expectFailureIn}`);
    if (!failedScenario) {
      failures.push(
        `${mutation.id} failed the gate, but NOT in ${mutation.expectFailureIn} — the guard is not the expected one.`
      );
      console.log(`  WRONG-GUARD ${mutation.id} (expected ${mutation.expectFailureIn})`);
      return;
    }

    console.log(`  ${mutation.id} detected by: ${mutation.expectFailureIn}`);
  });

  console.log("\nFinal:");
  if (failures.length === 0) {
    console.log(
      `PASS — the baseline evaluator passes and all ${MUTATIONS.length} ownership rule mutations are detected by a named scenario`
    );
  } else {
    failures.forEach((line) => console.log(`  ${line}`));
    console.log(`FAIL — ${failures.length} of ${MUTATIONS.length} ownership mutations were not properly detected`);
    process.exitCode = 1;
  }
}

main();
