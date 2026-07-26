"use strict";

// Evaluation-only Finding closure setup for the Phase 1 gate's
// "05_closed_boundary" / "06_recurrence" scenarios (eval/run_phase1_gate.js).
//
// ============================================================================
// THIS IS NOT A PRODUCTION CLOSE ENDPOINT AND MUST NEVER BE TREATED AS ONE.
// ============================================================================
// There is no analyst-facing "close a Finding" workflow anywhere in this
// repository yet (see STATUS.md — the manual-close endpoint is explicitly
// future work, out of scope for P1-GATE). The only way to exercise the
// CLOSED-boundary and recurrence lifecycle rules already implemented in
// dedupService.js is to put a Finding into a CLOSED state directly, by hand,
// for evaluation purposes only. This module does exactly that and nothing
// more:
//   - it is not mounted as an HTTP route
//   - it is not imported by any src/ production code path
//   - every record it touches is clearly marked as evaluation-owned via the
//     closureReason text, so a CLOSED Finding produced by this fixture can
//     never be mistaken for a genuine analyst closure if this database were
//     ever inspected directly
//   - it honestly uses the schema's existing closure fields (closedAt,
//     closedByUserId, closureReason, closedThroughObservedAt) rather than
//     inventing new ones — closedByUserId is left null since the schema does
//     not require an actor for a closed Finding to be valid, and creating a
//     dedicated evaluation User row is not required to represent this
//     truthfully.

const EVAL_CLOSURE_MARKER = "EVALUATION_FIXTURE_CLOSURE";

/**
 * Directly closes an existing Finding for evaluation purposes only. Throws
 * if the Finding does not already exist — this fixture only ever transitions
 * a Finding a prior scenario already created, never creates one itself.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{indicatorValue:string, port:number, protocol:string, reportType:string}} identity
 * @param {{closedThroughObservedAt:string|Date, closureReason:string}} closure
 * @returns {Promise<object>} the updated Finding row
 */
async function applyEvalClosureFixture(prisma, identity, closure) {
  if (!prisma || typeof prisma.finding?.findUnique !== "function") {
    throw new TypeError("applyEvalClosureFixture: prisma must be a Prisma client");
  }
  if (!identity || typeof identity.indicatorValue !== "string") {
    throw new TypeError("applyEvalClosureFixture: identity must be a Finding identity tuple");
  }
  if (!closure || !closure.closedThroughObservedAt || typeof closure.closureReason !== "string") {
    throw new TypeError(
      "applyEvalClosureFixture: closure must include closedThroughObservedAt and closureReason"
    );
  }
  if (!closure.closureReason.includes(EVAL_CLOSURE_MARKER)) {
    // Fails closed rather than silently mislabeling a closure as
    // evaluation-owned when the caller forgot the marker.
    throw new Error(
      `applyEvalClosureFixture: closureReason must clearly include "${EVAL_CLOSURE_MARKER}"`
    );
  }

  const existing = await prisma.finding.findUnique({
    where: {
      finding_identity: {
        indicatorValue: identity.indicatorValue,
        port: identity.port,
        protocol: identity.protocol,
        reportType: identity.reportType,
      },
    },
  });
  if (!existing) {
    throw new Error(
      `applyEvalClosureFixture: no existing Finding for identity ${JSON.stringify(identity)} — ` +
        "this fixture only transitions a Finding a prior scenario already created"
    );
  }

  const closedThroughObservedAt =
    closure.closedThroughObservedAt instanceof Date
      ? closure.closedThroughObservedAt
      : new Date(closure.closedThroughObservedAt);

  return prisma.finding.update({
    where: { id: existing.id },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      closedByUserId: null,
      closureReason: closure.closureReason,
      closedThroughObservedAt,
    },
  });
}

module.exports = { EVAL_CLOSURE_MARKER, applyEvalClosureFixture };
