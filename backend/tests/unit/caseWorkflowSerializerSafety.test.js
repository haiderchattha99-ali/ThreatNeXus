import { describe, it, expect } from "vitest";

// The exclusion proof caseWorkflowSerializers.js's header promises.
//
// Every serializer is fed a row carrying EVERY field its real table has, plus
// a few a future migration might plausibly add, each stamped with a
// distinctive marker. The assertions are made against the serialized output as
// a whole, so a field added later that is never named in a serializer cannot
// quietly start being emitted — a delete-based serializer would fail these,
// which is exactly why these construct fresh objects instead.

const {
  serializeOrganizationSummary,
  serializeActor,
  serializeTriageRow,
  serializeCaseSummary,
  serializeLinkRow,
  serializeLifecycleEvent,
  serializeOrganizationResponse,
  serializeClosureRequest,
  serializeRecurrenceReopen,
} = require("../../src/services/workflow/caseWorkflowSerializers");

// Markers for the categories the Phase 3 brief forbids exposing.
const CURRENT_ROW_KEY = "CURRENT-ROW-KEY-MARKER";
const RECURRENCE_KEY_MARKER = 987654;
const CONTACT_MARKER = "contact@private.invalid";
const FINGERPRINT_MARKER = "FINGERPRINT-MARKER";
const AUDIT_MARKER = "AUDIT-ROW-MARKER";
const SECRET_MARKER = "SECRET-MARKER";
const FUTURE_COLUMN_MARKER = "FUTURE-COLUMN-MARKER";

const NOW = new Date("2026-08-01T12:00:00.000Z");

const ALL_MARKERS = [
  CURRENT_ROW_KEY,
  CONTACT_MARKER,
  FINGERPRINT_MARKER,
  AUDIT_MARKER,
  SECRET_MARKER,
  FUTURE_COLUMN_MARKER,
];

/** Fields every serializer must refuse, whatever row it is handed. */
function contaminate(row) {
  return {
    ...row,
    // Internal fingerprints and secrets from neighbouring Phase 1/2 tables.
    inputFingerprint: FINGERPRINT_MARKER,
    configurationFingerprint: FINGERPRINT_MARKER,
    queryParamsHash: FINGERPRINT_MARKER,
    cacheKey: FINGERPRINT_MARKER,
    claimToken: SECRET_MARKER,
    apiKey: SECRET_MARKER,
    // A complete audit row.
    auditLog: { id: 1, reason: AUDIT_MARKER },
    // A column a future migration might add and nobody remembers to filter.
    someFutureColumn: FUTURE_COLUMN_MARKER,
  };
}

function assertNoMarkers(serialized) {
  const text = JSON.stringify(serialized);
  ALL_MARKERS.forEach((marker) => expect(text).not.toContain(marker));
  expect(text).not.toContain(String(RECURRENCE_KEY_MARKER));
}

describe("serializeOrganizationSummary", () => {
  const organization = {
    id: 3,
    name: "Acme Bank",
    sector: "FINANCE",
    // The "unrestricted organization contacts" the brief forbids: a VIEWER
    // reading a case must not thereby obtain a notification recipient list.
    contactPerson: CONTACT_MARKER,
    email: CONTACT_MARKER,
    phone: CONTACT_MARKER,
    industry: CONTACT_MARKER,
    location: CONTACT_MARKER,
    securityScore: 42,
    activeThreats: 7,
  };

  it("emits exactly id, name and sector", () => {
    expect(serializeOrganizationSummary(organization)).toEqual({
      id: 3,
      name: "Acme Bank",
      sector: "FINANCE",
    });
  });

  it("emits no contact detail and no dashboard projection", () => {
    const out = serializeOrganizationSummary(contaminate(organization));
    assertNoMarkers(out);
    expect(out.securityScore).toBeUndefined();
    expect(out.activeThreats).toBeUndefined();
  });

  it("returns null rather than an empty husk for a missing organization", () => {
    expect(serializeOrganizationSummary(null)).toBeNull();
    expect(serializeOrganizationSummary(undefined)).toBeNull();
  });
});

describe("serializeActor", () => {
  it("emits id, name and role, never the email or the password hash", () => {
    const out = serializeActor({
      id: 5,
      name: "A. Analyst",
      role: "ANALYST",
      email: CONTACT_MARKER,
      password: SECRET_MARKER,
    });

    expect(out).toEqual({ id: 5, name: "A. Analyst", role: "ANALYST" });
    assertNoMarkers(out);
  });
});

describe("serializeTriageRow", () => {
  const row = {
    id: 11,
    findingId: 2,
    decision: "ESCALATED",
    source: "CASE_LINK",
    reason: "Confirmed exposure",
    caseId: 4,
    actorUserId: 5,
    decidedAt: NOW,
    supersededAt: null,
    createdAt: NOW,
    currentForFindingId: CURRENT_ROW_KEY,
  };

  it("replaces the current-row key with an isCurrent flag", () => {
    const out = serializeTriageRow(row);
    expect(out.isCurrent).toBe(true);
    expect(out.currentForFindingId).toBeUndefined();
    assertNoMarkers(out);
  });

  it("reports a superseded row as not current", () => {
    expect(serializeTriageRow({ ...row, supersededAt: NOW }).isCurrent).toBe(false);
  });

  it("drops every contaminating field", () => {
    assertNoMarkers(serializeTriageRow(contaminate(row)));
  });
});

describe("serializeCaseSummary", () => {
  const record = {
    id: 4,
    caseReference: "TNX-2026-000004",
    title: "Accessible RDP",
    threatType: "Accessible RDP",
    priority: "High",
    status: "Open",
    lifecycleState: "CLOSED",
    analyst: "a.analyst",
    organization: "Acme Bank",
    organizationId: 3,
    ownerOrganization: {
      id: 3,
      name: "Acme Bank",
      sector: "FINANCE",
      email: CONTACT_MARKER,
      phone: CONTACT_MARKER,
    },
    closedAt: NOW,
    closureReason: "REMEDIATED",
    closedByUserId: 6,
    lastReopenedAt: NOW,
    lastReopenTrigger: "RECURRENCE",
    reopenedCount: 2,
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("returns both status concepts explicitly labelled", () => {
    const out = serializeCaseSummary(record);
    // The legacy free-text column the Phase 0 UI still writes, AND the
    // authoritative Phase 3 enum. Returning only one would either break the
    // legacy screen or hide the real state.
    expect(out.status).toBe("Open");
    expect(out.lifecycleState).toBe("CLOSED");
  });

  it("derives the recurrence-reopened badge", () => {
    expect(serializeCaseSummary(record).reopenedByRecurrence).toBe(true);
    expect(
      serializeCaseSummary({ ...record, lastReopenTrigger: "MANUAL" }).reopenedByRecurrence
    ).toBe(false);
    expect(
      serializeCaseSummary({ ...record, lastReopenTrigger: null }).reopenedByRecurrence
    ).toBe(false);
  });

  it("passes the nested organization through the organization allow-list", () => {
    const out = serializeCaseSummary(record);
    expect(out.ownerOrganization).toEqual({ id: 3, name: "Acme Bank", sector: "FINANCE" });
    assertNoMarkers(out);
  });

  it("drops every contaminating field", () => {
    assertNoMarkers(serializeCaseSummary(contaminate(record)));
  });
});

describe("serializeLinkRow", () => {
  const row = {
    id: 21,
    caseId: 4,
    findingId: 2,
    state: "LINKED",
    organizationId: 3,
    ownershipStatusAtLink: "RESOLVED",
    ownershipConfidenceAtLink: "HIGH",
    reason: null,
    actorUserId: 5,
    effectiveAt: NOW,
    supersededAt: null,
    createdAt: NOW,
    currentLinkKey: CURRENT_ROW_KEY,
    finding: {
      id: 2,
      indicatorValue: "192.0.2.10",
      port: 3389,
      protocol: "tcp",
      reportType: "accessible-rdp",
      status: "OPEN",
      firstSeen: NOW,
      lastSeen: NOW,
      occurrenceCount: 3,
      recurrenceCount: 1,
      // Fields the Findings API itself does not publish.
      dedupHash: FINGERPRINT_MARKER,
    },
  };

  it("replaces currentLinkKey with isCurrent", () => {
    const out = serializeLinkRow(row);
    expect(out.isCurrent).toBe(true);
    expect(out.currentLinkKey).toBeUndefined();
  });

  // The Finding identity fields ARE published here: an analyst working a case
  // needs to see which host it is, and /api/findings already returns the same
  // information to any holder of read:findings, which every role holds.
  it("publishes the Finding's identity but not its internal columns", () => {
    const out = serializeLinkRow(row);
    expect(out.finding).toEqual({
      id: 2,
      indicatorValue: "192.0.2.10",
      port: 3389,
      protocol: "tcp",
      reportType: "accessible-rdp",
      status: "OPEN",
      firstSeen: NOW,
      lastSeen: NOW,
      occurrenceCount: 3,
      recurrenceCount: 1,
    });
    assertNoMarkers(out);
  });

  it("omits the finding block entirely when it was not loaded", () => {
    const { finding, ...withoutFinding } = row;
    expect(finding).toBeDefined();
    expect(serializeLinkRow(withoutFinding).finding).toBeUndefined();
  });

  it("drops every contaminating field", () => {
    assertNoMarkers(serializeLinkRow(contaminate(row)));
  });
});

describe("serializeLifecycleEvent", () => {
  const row = {
    id: 31,
    caseId: 4,
    eventType: "CLOSURE_APPROVED",
    fromState: "CLOSURE_PENDING",
    toState: "CLOSED",
    reasonCode: "CLOSURE_APPROVED_BY_REVIEWER",
    note: "Evidence sufficient",
    actorUserId: 6,
    actor: { id: 6, name: "R. Reviewer", role: "REVIEWER", email: CONTACT_MARKER },
    occurredAt: NOW,
    createdAt: NOW,
  };

  it("emits the closed reason code and the actor allow-list only", () => {
    const out = serializeLifecycleEvent(row);
    expect(out.reasonCode).toBe("CLOSURE_APPROVED_BY_REVIEWER");
    expect(out.actor).toEqual({ id: 6, name: "R. Reviewer", role: "REVIEWER" });
    assertNoMarkers(out);
  });

  it("drops every contaminating field", () => {
    assertNoMarkers(serializeLifecycleEvent(contaminate(row)));
  });
});

describe("serializeOrganizationResponse", () => {
  const row = {
    id: 41,
    caseId: 4,
    responseType: "REMEDIATED",
    summary: "The constituent reported the port closed",
    reference: "TICKET-4711",
    occurredAt: NOW,
    recordedAt: NOW,
    recordedByUserId: 5,
    recordedBy: { id: 5, name: "A. Analyst", role: "ANALYST", email: CONTACT_MARKER },
    createdAt: NOW,
  };

  it("publishes the analyst summary and the opaque reference", () => {
    const out = serializeOrganizationResponse(row);
    expect(out.summary).toBe("The constituent reported the port closed");
    expect(out.reference).toBe("TICKET-4711");
    expect(out.recordedBy).toEqual({ id: 5, name: "A. Analyst", role: "ANALYST" });
  });

  it("drops every contaminating field", () => {
    assertNoMarkers(serializeOrganizationResponse(contaminate(row)));
  });
});

describe("serializeClosureRequest", () => {
  const row = {
    id: 51,
    caseId: 4,
    state: "PENDING",
    closureReason: "REMEDIATED",
    justification: "Remediation confirmed with the constituent",
    requestedByUserId: 5,
    requestedBy: { id: 5, name: "A. Analyst", role: "ANALYST", email: CONTACT_MARKER },
    requestedAt: NOW,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    supportingResponseId: 41,
    createdAt: NOW,
    activeCaseId: CURRENT_ROW_KEY,
  };

  it("replaces activeCaseId with isPending", () => {
    const out = serializeClosureRequest(row);
    expect(out.isPending).toBe(true);
    expect(out.activeCaseId).toBeUndefined();
    expect(serializeClosureRequest({ ...row, state: "APPROVED" }).isPending).toBe(false);
  });

  it("keeps the supporting-response pointer, which is the closure's evidence", () => {
    expect(serializeClosureRequest(row).supportingResponseId).toBe(41);
  });

  it("drops every contaminating field", () => {
    assertNoMarkers(serializeClosureRequest(contaminate(row)));
  });
});

describe("serializeRecurrenceReopen", () => {
  const row = {
    id: 61,
    caseId: 4,
    findingId: 2,
    findingOccurrenceId: RECURRENCE_KEY_MARKER,
    outcome: "REOPENED",
    observedAt: NOW,
    processedAt: NOW,
    createdAt: NOW,
  };

  // Publishing it would let a caller enumerate or replay reopen processing for
  // a specific occurrence.
  it("never emits the internal recurrence idempotency key", () => {
    const out = serializeRecurrenceReopen(row);
    expect(out.findingOccurrenceId).toBeUndefined();
    expect(out).toEqual({
      id: 61,
      caseId: 4,
      findingId: 2,
      outcome: "REOPENED",
      observedAt: NOW,
      processedAt: NOW,
      createdAt: NOW,
    });
    assertNoMarkers(out);
  });

  it("drops every contaminating field", () => {
    assertNoMarkers(serializeRecurrenceReopen(contaminate(row)));
  });
});

describe("every serializer", () => {
  const serializers = [
    serializeOrganizationSummary,
    serializeActor,
    serializeTriageRow,
    serializeCaseSummary,
    serializeLinkRow,
    serializeLifecycleEvent,
    serializeOrganizationResponse,
    serializeClosureRequest,
    serializeRecurrenceReopen,
  ];

  it("returns null for a null row rather than throwing or inventing one", () => {
    serializers.forEach((serialize) => {
      expect(serialize(null)).toBeNull();
      expect(serialize(undefined)).toBeNull();
    });
  });

  // Construct-only, never delete-based: the output object cannot share
  // identity with the input row, or a later mutation of the row would change
  // an already-sent response.
  it("constructs a fresh object rather than returning the row it was given", () => {
    const row = { id: 1, name: "x", secret: SECRET_MARKER };
    serializers.forEach((serialize) => {
      const out = serialize(row);
      expect(out).not.toBe(row);
    });
  });
});
