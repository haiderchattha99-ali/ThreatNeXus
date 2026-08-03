"use strict";

// Shared in-memory Prisma fake for the Phase 3 analyst-workflow unit tests.
//
// Modelled on tests/unit/fixtures/vulnerabilityPrismaFake.js, and deliberately
// honouring the exact PostgreSQL behaviours the Phase 3 design DEPENDS on:
//
//   * the three distinct-NULLs current-row uniques —
//     FindingTriage.currentForFindingId, CaseFinding.currentLinkKey and
//     CaseClosureRequest.activeCaseId — including that multiple NULLs coexist
//     while a duplicate non-null raises P2002
//   * CaseRecurrenceReopen's composite (findingOccurrenceId, caseId) unique,
//     which is THE recurrence idempotency key
//   * the guarded `case.updateMany` compare-and-swap that every lifecycle
//     transition is built on, so a stale `fromState` yields count 0
//   * transaction rollback, so a throw part-way through a link/closure/reopen
//     cannot leave a half-written history behind
//
// Extended in Phase 4 with the notification tables, which depend on the same
// two behaviours plus one more:
//
//   * NotificationRevision.currentForNotificationId — the distinct-NULLs
//     current-row unique again, this time enforcing "exactly one current
//     revision"
//   * NotificationRevision's COMPOSITE (notificationId, revisionNumber)
//     unique, which is what stops two concurrent edits both becoming
//     revision 4
//   * the guarded `notification.updateMany` compare-and-swap behind every
//     lifecycle transition, including the one that clears the approval
//     projection in the same statement
//
// A fake that did not enforce these would let a test pass against an
// implementation with no invariant at all. What it deliberately does NOT model
// is row locking and genuine concurrency — those are proven against a real
// engine in tests/integration/caseWorkflowConcurrency.test.js.

function uniqueViolation(target) {
  const error = new Error(
    `Unique constraint failed on the fields: (\`${target.join("`,`")}\`)`
  );
  error.code = "P2002";
  error.meta = { target };
  return error;
}

function notFound() {
  const error = new Error("Record to update not found.");
  error.code = "P2025";
  return error;
}

/** Evaluates the `where` shapes the Phase 3 services actually issue. */
function matches(row, where = {}) {
  for (const [key, value] of Object.entries(where)) {
    if (key === "AND") {
      if (!value.every((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === "OR") {
      if (!value.some((clause) => matches(row, clause))) return false;
      continue;
    }
    const actual = row[key];
    if (value instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== value.getTime()) return false;
      continue;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if ("in" in value && !value.in.includes(actual)) return false;
      if ("not" in value && actual === value.not) return false;
      if ("lt" in value && !(actual < value.lt)) return false;
      if ("lte" in value && !(actual <= value.lte)) return false;
      if ("gt" in value && !(actual > value.gt)) return false;
      if ("gte" in value && !(actual >= value.gte)) return false;
      if ("startsWith" in value) {
        if (typeof actual !== "string" || !actual.startsWith(value.startsWith)) return false;
      }
      continue;
    }
    if (actual !== value) return false;
  }
  return true;
}

/** Applies Prisma's `{increment}` / `{decrement}` atomic-update shapes. */
function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      if ("increment" in value) {
        row[key] = (row[key] || 0) + value.increment;
        continue;
      }
      if ("decrement" in value) {
        row[key] = (row[key] || 0) - value.decrement;
        continue;
      }
    }
    row[key] = value;
  }
  return row;
}

function orderAndTake(rows, orderBy, take, skip) {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  let out = [...rows];
  if (clauses.length > 0) {
    out.sort((a, b) => {
      for (const clause of clauses) {
        const [field, direction] = Object.entries(clause)[0];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return direction === "desc" ? 1 : -1;
        if (bv === null || bv === undefined) return direction === "desc" ? -1 : 1;
        return direction === "desc" ? (bv > av ? 1 : -1) : av > bv ? 1 : -1;
      }
      return 0;
    });
  }
  // Phase 5 read paths paginate, so `skip` is applied BEFORE `take` — the same
  // order PostgreSQL applies OFFSET before LIMIT. Getting this backwards would
  // make a paginated test pass against an implementation that silently returned
  // the first page every time.
  if (Number.isInteger(skip) && skip > 0) out = out.slice(skip);
  return Number.isInteger(take) && take > 0 ? out.slice(0, take) : out;
}

/**
 * Creates the fake.
 *
 * `state` exposes the raw arrays so a test can seed fixtures and assert on the
 * durable rows directly, which is how the append-only invariants are checked:
 * a test that only read the service's return value could not tell an UPDATE of
 * a prior row from an INSERT of a new one.
 */
function createWorkflowPrismaFake() {
  const state = {
    findings: [],
    organizations: [],
    findingOwnerships: [],
    findingOccurrences: [],
    cases: [],
    findingTriages: [],
    caseFindings: [],
    caseLifecycleEvents: [],
    caseOrganizationResponses: [],
    caseClosureRequests: [],
    caseRecurrenceReopens: [],
    // Phase 4.
    users: [],
    notifications: [],
    notificationRevisions: [],
    notificationLifecycleEvents: [],
    notificationExports: [],
    notificationDeliveryEvents: [],
    // Phase 5. The framework/AI tables, plus the three Phase 1/2 evidence
    // tables the bounded AI snapshot reads (risk scores, their contributions,
    // and analyst-asserted CVE associations).
    caseFrameworkMappings: [],
    aiSuggestionRuns: [],
    aiFrameworkMappingSuggestions: [],
    aiSuggestionDecisions: [],
    riskScores: [],
    riskFactorContributions: [],
    vulnerabilities: [],
    findingVulnerabilities: [],
    auditLogs: [],
    nextId: 1,
  };

  const clone = (row) => (row ? { ...row } : null);

  // Generic table backed by one array, with an optional list of unique
  // constraints. Each constraint is {fields, ignoreNull} — ignoreNull models
  // PostgreSQL's "multiple NULLs are distinct" rule, which is the ENTIRE basis
  // of the current-row mechanism.
  // `relations` maps an `include`/nested-`select` key to the array it resolves
  // against plus the foreign key that points at it. Only the relations the
  // Phase 3 read paths actually request are modelled — an unmodelled include is
  // simply absent, which makes an accidental dependency on one visible rather
  // than silently satisfied.
  function table(key, { uniques = [], defaults = () => ({}), relations = {} } = {}) {
    const rows = () => state[key];

    // `include` and relation-bearing `select` are handled by the same code.
    // Phase 5's snapshot builder reads relations through `select` (e.g.
    // `select: { vulnerability: { select: { cveId: true } } }`), and a fake that
    // silently returned no relation there would make a snapshot test pass
    // against a builder that never loaded the data.
    //
    // Scalar `select` keys are still ignored — the fake returns whole rows,
    // which is strictly more permissive than Prisma and therefore cannot hide a
    // field a service forgot to request.
    function withRelations(row, include, select) {
      const spec = include || (select ? pickRelationKeys(select) : null);
      if (!row || !spec) return row;
      const out = { ...row };
      Object.entries(spec).forEach(([name, spec2]) => {
        const relation = relations[name];
        if (!relation || spec2 === false) return;
        const target = state[relation.table].find((r) => r.id === row[relation.foreignKey]);
        if (!target) {
          out[name] = null;
          return;
        }
        const nestedSelect = spec2 && typeof spec2 === "object" ? spec2.select : null;
        if (!nestedSelect) {
          out[name] = { ...target };
          return;
        }
        const projected = {};
        Object.keys(nestedSelect).forEach((field) => {
          if (nestedSelect[field]) projected[field] = target[field];
        });
        out[name] = projected;
      });
      return out;
    }

    // Only the keys of `select` that name a modelled relation. A scalar key
    // ("id: true") is not a relation and must not be treated as one.
    function pickRelationKeys(select) {
      const out = {};
      Object.keys(select).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(relations, key)) out[key] = select[key];
      });
      return Object.keys(out).length > 0 ? out : null;
    }

    function assertUnique(candidate, excludeId) {
      for (const { fields, ignoreNull } of uniques) {
        if (ignoreNull && fields.some((f) => candidate[f] === null || candidate[f] === undefined)) {
          continue;
        }
        const clash = rows().some(
          (row) => row.id !== excludeId && fields.every((f) => row[f] === candidate[f])
        );
        if (clash) throw uniqueViolation(fields);
      }
    }

    return {
      async create({ data }) {
        const row = { id: state.nextId++, createdAt: new Date(), ...defaults(), ...data };
        assertUnique(row, row.id);
        rows().push(row);
        return clone(row);
      },
      async findUnique({ where, include, select }) {
        // Compound-key form, e.g. { findingOccurrenceId_caseId: {...} }.
        const [firstKey, firstValue] = Object.entries(where)[0];
        const found =
          firstValue !== null && typeof firstValue === "object" && !(firstValue instanceof Date)
            ? rows().find((row) => matches(row, firstValue))
            : rows().find((row) => row[firstKey] === firstValue);
        return found ? withRelations(clone(found), include, select) : null;
      },
      async findFirst({ where, orderBy, include, select } = {}) {
        const found = orderAndTake(
          rows().filter((row) => matches(row, where || {})),
          orderBy
        );
        return found[0] ? withRelations(clone(found[0]), include, select) : null;
      },
      async findMany({ where, orderBy, take, skip, include, select } = {}) {
        return orderAndTake(
          rows().filter((row) => matches(row, where || {})),
          orderBy,
          take,
          skip
        ).map((row) => withRelations(clone(row), include, select));
      },
      async count({ where } = {}) {
        return rows().filter((row) => matches(row, where || {})).length;
      },
      async groupBy({ by, where, _count }) {
        const buckets = new Map();
        rows()
          .filter((row) => matches(row, where || {}))
          .forEach((row) => {
            const bucketKey = by.map((field) => row[field]).join(" ");
            if (!buckets.has(bucketKey)) buckets.set(bucketKey, { rows: [], row });
            buckets.get(bucketKey).rows.push(row);
          });
        return [...buckets.values()].map(({ rows: bucketRows, row }) => {
          const out = {};
          by.forEach((field) => {
            out[field] = row[field];
          });
          if (_count) out._count = { _all: bucketRows.length };
          return out;
        });
      },
      async update({ where, data }) {
        const row = rows().find((r) => r.id === where.id);
        if (!row) throw notFound();
        const candidate = applyData({ ...row }, data);
        assertUnique(candidate, row.id);
        Object.assign(row, candidate);
        return clone(row);
      },
      async updateMany({ where, data }) {
        const targets = rows().filter((row) => matches(row, where || {}));
        targets.forEach((row) => {
          const candidate = applyData({ ...row }, data);
          assertUnique(candidate, row.id);
          Object.assign(row, candidate);
        });
        return { count: targets.length };
      },
      async deleteMany({ where } = {}) {
        const keep = rows().filter((row) => !matches(row, where || {}));
        const removed = rows().length - keep.length;
        state[key] = keep;
        return { count: removed };
      },
    };
  }

  const client = {
    finding: table("findings"),
    organization: table("organizations"),
    findingOccurrence: table("findingOccurrences"),
    findingOwnership: table("findingOwnerships", {
      uniques: [{ fields: ["currentForFindingId"], ignoreNull: true }],
    }),
    case: table("cases", {
      uniques: [{ fields: ["caseReference"], ignoreNull: true }],
      defaults: () => ({
        lifecycleState: "OPEN",
        reopenedCount: 0,
        closedAt: null,
        closureReason: null,
        closedByUserId: null,
        lastReopenedAt: null,
        lastReopenTrigger: null,
        caseReference: null,
        organizationId: null,
      }),
      relations: {
        ownerOrganization: { table: "organizations", foreignKey: "organizationId" },
      },
    }),
    findingTriage: table("findingTriages", {
      uniques: [{ fields: ["currentForFindingId"], ignoreNull: true }],
    }),
    caseFinding: table("caseFindings", {
      uniques: [{ fields: ["currentLinkKey"], ignoreNull: true }],
      relations: { finding: { table: "findings", foreignKey: "findingId" } },
    }),
    caseLifecycleEvent: table("caseLifecycleEvents"),
    caseOrganizationResponse: table("caseOrganizationResponses"),
    caseClosureRequest: table("caseClosureRequests", {
      uniques: [{ fields: ["activeCaseId"], ignoreNull: true }],
      defaults: () => ({ reviewedByUserId: null, reviewedAt: null, reviewNote: null }),
    }),
    caseRecurrenceReopen: table("caseRecurrenceReopens", {
      uniques: [{ fields: ["findingOccurrenceId", "caseId"], ignoreNull: false }],
    }),

    // --- Phase 4 -------------------------------------------------------------
    user: table("users"),
    notification: table("notifications", {
      uniques: [{ fields: ["notificationReference"], ignoreNull: true }],
      defaults: () => ({
        lifecycleState: "DRAFT",
        notificationReference: null,
        caseId: null,
        organizationId: null,
        createdByUserId: null,
        approvedRevisionId: null,
        approvedByUserId: null,
        approvedAt: null,
      }),
      relations: {
        ownerOrganization: { table: "organizations", foreignKey: "organizationId" },
        createdBy: { table: "users", foreignKey: "createdByUserId" },
        approvedBy: { table: "users", foreignKey: "approvedByUserId" },
      },
    }),
    notificationRevision: table("notificationRevisions", {
      uniques: [
        // "Exactly one current revision", the distinct-NULLs mechanism again.
        { fields: ["currentForNotificationId"], ignoreNull: true },
        // "No two revision Ns for one notification" — a genuine composite
        // unique with no NULL exemption, which is what makes two concurrent
        // edits unable to both become revision N+1.
        { fields: ["notificationId", "revisionNumber"], ignoreNull: false },
      ],
      defaults: () => ({
        remediationGuidance: null,
        recipientName: null,
        recipientEmail: null,
        analystNotes: null,
        createdByUserId: null,
        supersededAt: null,
        currentForNotificationId: null,
      }),
      relations: { createdBy: { table: "users", foreignKey: "createdByUserId" } },
    }),
    notificationLifecycleEvent: table("notificationLifecycleEvents", {
      defaults: () => ({ fromState: null, note: null, actorUserId: null }),
      relations: {
        actor: { table: "users", foreignKey: "actorUserId" },
        revision: { table: "notificationRevisions", foreignKey: "revisionId" },
      },
    }),
    notificationExport: table("notificationExports", {
      defaults: () => ({ exportedByUserId: null }),
      relations: {
        exportedBy: { table: "users", foreignKey: "exportedByUserId" },
        revision: { table: "notificationRevisions", foreignKey: "revisionId" },
      },
    }),
    notificationDeliveryEvent: table("notificationDeliveryEvents", {
      defaults: () => ({
        exportId: null,
        revisionId: null,
        reference: null,
        note: null,
        recordedByUserId: null,
        recordedAt: new Date(),
      }),
      relations: {
        recordedBy: { table: "users", foreignKey: "recordedByUserId" },
        revision: { table: "notificationRevisions", foreignKey: "revisionId" },
      },
    }),
    // --- Phase 5 -------------------------------------------------------------
    // currentMappingKey is the distinct-NULLs current-row unique again, this
    // time enforcing "at most one current mapping per (case, framework, scope,
    // reference)". Without it here, an append-only test would pass against a
    // service that had no invariant at all.
    caseFrameworkMapping: table("caseFrameworkMappings", {
      uniques: [{ fields: ["currentMappingKey"], ignoreNull: true }],
      defaults: () => ({
        evidenceFindingId: null,
        actorUserId: null,
        supersededAt: null,
        currentMappingKey: null,
        source: "MANUAL",
      }),
      relations: {
        actor: { table: "users", foreignKey: "actorUserId" },
        evidenceFinding: { table: "findings", foreignKey: "evidenceFindingId" },
      },
    }),
    aiSuggestionRun: table("aiSuggestionRuns", {
      defaults: () => ({
        providerModel: null,
        requestContext: null,
        actorUserId: null,
        completedAt: null,
        suggestionCount: 0,
        rejectedCount: 0,
      }),
      relations: { actor: { table: "users", foreignKey: "actorUserId" } },
    }),
    aiFrameworkMappingSuggestion: table("aiFrameworkMappingSuggestions", {
      // promotedMappingId @unique with NULLs distinct: this is what makes a
      // repeated approval structurally unable to create a second mapping.
      uniques: [{ fields: ["promotedMappingId"], ignoreNull: true }],
      defaults: () => ({
        evidenceFindingId: null,
        providerConfidence: null,
        state: "PENDING",
        decidedAt: null,
        decidedByUserId: null,
        decisionReason: null,
        promotedMappingId: null,
      }),
      relations: {
        decidedBy: { table: "users", foreignKey: "decidedByUserId" },
        evidenceFinding: { table: "findings", foreignKey: "evidenceFindingId" },
        promotedMapping: { table: "caseFrameworkMappings", foreignKey: "promotedMappingId" },
      },
    }),
    aiSuggestionDecision: table("aiSuggestionDecisions", {
      defaults: () => ({ reason: null, actorUserId: null }),
      relations: { actor: { table: "users", foreignKey: "actorUserId" } },
    }),
    riskScore: table("riskScores", {
      uniques: [{ fields: ["currentForFindingId"], ignoreNull: true }],
      defaults: () => ({ supersededAt: null, currentForFindingId: null }),
    }),
    riskFactorContribution: table("riskFactorContributions"),
    vulnerability: table("vulnerabilities"),
    findingVulnerability: table("findingVulnerabilities", {
      uniques: [{ fields: ["currentAssociationKey"], ignoreNull: true }],
      defaults: () => ({ supersededAt: null, currentAssociationKey: null }),
      relations: { vulnerability: { table: "vulnerabilities", foreignKey: "vulnerabilityId" } },
    }),

    auditLog: {
      async create({ data }) {
        const row = { id: state.auditLogs.length + 1, ...data };
        state.auditLogs.push(row);
        return { ...row };
      },
    },

    // Snapshot/restore rollback. Prisma's interactive transaction is
    // all-or-nothing, and several Phase 3 services rely on that: a link that
    // wrote its CaseFinding row and then failed to escalate triage must leave
    // NEITHER behind.
    async $transaction(fn) {
      const snapshot = JSON.parse(
        JSON.stringify(state, (key, value) =>
          value instanceof Date ? { __date: value.toISOString() } : value
        )
      );
      try {
        return await fn(client);
      } catch (error) {
        const revive = (value) => {
          if (Array.isArray(value)) return value.map(revive);
          if (value && typeof value === "object") {
            if (typeof value.__date === "string") return new Date(value.__date);
            const out = {};
            Object.entries(value).forEach(([k, v]) => {
              out[k] = revive(v);
            });
            return out;
          }
          return value;
        };
        Object.keys(snapshot).forEach((key) => {
          state[key] = revive(snapshot[key]);
        });
        throw error;
      }
    },
  };

  return { client, state };
}

module.exports = { matches, applyData, createWorkflowPrismaFake };
