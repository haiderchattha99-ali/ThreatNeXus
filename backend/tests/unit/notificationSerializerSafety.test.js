import { describe, it, expect } from "vitest";

// The exclusion proof notificationSerializers.js's own header promises.
//
// Every serializer is fed a CONTAMINATED row: the real column set plus every
// internal, secret and contact field a future migration, a careless `include`
// or a copy-paste could realistically attach. A construct-only serializer
// stays safe under that treatment; a delete-based one would start leaking the
// moment a new key appeared. This file is what makes that claim testable
// rather than aspirational.
//
// Modelled directly on caseWorkflowSerializerSafety.test.js.

const {
  maskEmail,
  serializeRevision,
  serializeRevisionSummary,
  serializeLifecycleEvent,
  serializeExport,
  serializeDeliveryEvent,
  serializeNotificationSummary,
} = require("../../src/services/notification/notificationSerializers");

// Values that must never appear in ANY serialized output. Each is distinctive
// enough that a substring search over the JSON is a real test.
const CONTAMINANTS = Object.freeze({
  password: "$2b$10$hashedpasswordvalue",
  apiKey: "abuseipdb-key-must-never-leak",
  token: "Bearer eyJhbGciOiJIUzI1NiJ9.leak",
  contactPhone: "+92-300-1234567",
  contactPerson: "Mr Private Contact",
  organizationEmail: "private-registry-contact@acme.example",
  filesystemPath: "C:/Users/LENOVO/Desktop/ThreatNeXus/backend/uploads/secret.csv",
  stack: "Error: boom\n    at Object.<anonymous> (/app/src/leak.js:1:1)",
  prismaMessage: "Invalid `prisma.notification.update()` invocation",
  artifactBytes: "From: ThreatNeXus notification (unsent draft) <noreply@threatnexus.invalid>",
});

function contaminate(row) {
  return {
    ...row,
    // Internal current-row key — the whole distinct-NULLs mechanism.
    currentForNotificationId: 42,
    // Credentials and secrets that could ride in on a careless include.
    password: CONTAMINANTS.password,
    apiKey: CONTAMINANTS.apiKey,
    authorization: CONTAMINANTS.token,
    // Organization contact detail.
    contactPerson: CONTAMINANTS.contactPerson,
    phone: CONTAMINANTS.contactPhone,
    email: CONTAMINANTS.organizationEmail,
    industry: "Banking",
    location: "Karachi",
    securityScore: 91,
    activeThreats: 4,
    // Server internals.
    filePath: CONTAMINANTS.filesystemPath,
    stack: CONTAMINANTS.stack,
    prismaError: CONTAMINANTS.prismaMessage,
    // The artifact itself.
    bytes: Buffer.from(CONTAMINANTS.artifactBytes),
    artifact: CONTAMINANTS.artifactBytes,
    rawContent: CONTAMINANTS.artifactBytes,
    // Phase 1/2 fingerprints.
    inputFingerprint: "risk-fingerprint-abc",
    configurationFingerprint: "config-fingerprint-def",
    cacheKey: "ioc:203.0.113.10",
    // A whole audit row.
    auditLog: { id: 1, action: "notification.approved", before: {}, after: {} },
  };
}

const revisionRow = () => ({
  id: 7,
  notificationId: 3,
  revisionNumber: 2,
  subject: "Accessible RDP exposure notification",
  body: "Dear contact,\n\nOne host is exposed.",
  remediationGuidance: "Restrict access.",
  recipientName: "Sec Contact",
  recipientEmail: "soc@acme.example",
  analystNotes: "Internal: called the contact.",
  contentChecksum: "a".repeat(64),
  createdByUserId: 10,
  createdAt: new Date("2026-08-03T08:00:00.000Z"),
  supersededAt: null,
});

const notificationRow = () => ({
  id: 3,
  notificationReference: "TNX-NOT-2026-000003",
  caseId: 5,
  organizationId: 9,
  lifecycleState: "APPROVED",
  approvedRevisionId: 7,
  approvedByUserId: 11,
  approvedAt: new Date("2026-08-03T10:00:00.000Z"),
  createdByUserId: 10,
  createdAt: new Date("2026-08-03T08:00:00.000Z"),
  // The legacy display projection, which must not be emitted alongside the
  // authoritative revision.
  title: "Accessible RDP exposure notification",
  message: "Constituent notification TNX-NOT-2026-000003 — revision 2.",
  severity: "Medium",
  status: "Unread",
  type: "Constituent",
  ownerOrganization: {
    id: 9,
    name: "Acme Bank",
    sector: "FINANCE",
    contactPerson: CONTAMINANTS.contactPerson,
    email: CONTAMINANTS.organizationEmail,
    phone: CONTAMINANTS.contactPhone,
  },
});

const exportRow = () => ({
  id: 4,
  notificationId: 3,
  revisionId: 7,
  format: "EML",
  artifactChecksum: "b".repeat(64),
  artifactByteLength: 1234,
  filename: "notification-TNX-NOT-2026-000003-rev2.eml",
  exportedByUserId: 10,
  exportedAt: new Date("2026-08-03T11:00:00.000Z"),
  createdAt: new Date("2026-08-03T11:00:00.000Z"),
});

const deliveryRow = () => ({
  id: 6,
  notificationId: 3,
  exportId: 4,
  revisionId: 7,
  status: "SENT_MANUALLY",
  occurredAt: new Date("2026-08-03T12:00:00.000Z"),
  recordedAt: new Date("2026-08-03T12:05:00.000Z"),
  reference: "TICKET-99",
  note: "Sent from the analyst mailbox.",
  recordedByUserId: 10,
  createdAt: new Date("2026-08-03T12:05:00.000Z"),
});

const lifecycleRow = () => ({
  id: 8,
  notificationId: 3,
  eventType: "APPROVED",
  fromState: "PENDING_REVIEW",
  toState: "APPROVED",
  revisionId: 7,
  reasonCode: "APPROVED_BY_REVIEWER",
  note: "Content verified against the case evidence.",
  actorUserId: 11,
  occurredAt: new Date("2026-08-03T10:00:00.000Z"),
  createdAt: new Date("2026-08-03T10:00:00.000Z"),
});

const SERIALIZERS = [
  ["serializeRevision", serializeRevision, revisionRow],
  ["serializeRevisionSummary", serializeRevisionSummary, revisionRow],
  ["serializeLifecycleEvent", serializeLifecycleEvent, lifecycleRow],
  ["serializeExport", serializeExport, exportRow],
  ["serializeDeliveryEvent", serializeDeliveryEvent, deliveryRow],
  ["serializeNotificationSummary", serializeNotificationSummary, notificationRow],
];

describe("no serializer emits a contaminant", () => {
  it.each(SERIALIZERS)("%s", (_name, serialize, row) => {
    const output = JSON.stringify(serialize(contaminate(row())));
    Object.entries(CONTAMINANTS).forEach(([label, value]) => {
      expect(output, `leaked ${label}`).not.toContain(value);
    });
  });

  it.each(SERIALIZERS)("%s never emits the current-row key", (_name, serialize, row) => {
    const output = serialize(contaminate(row()));
    expect(output).not.toHaveProperty("currentForNotificationId");
    expect(JSON.stringify(output)).not.toContain("currentForNotificationId");
  });

  it.each(SERIALIZERS)("%s returns null for a null row", (_name, serialize) => {
    expect(serialize(null)).toBeNull();
    expect(serialize(undefined)).toBeNull();
  });
});

describe("recipient addresses are masked, never verbatim", () => {
  it("masks the local part and preserves the domain", () => {
    expect(maskEmail("soc@acme.example")).toBe("s**@acme.example");
    expect(maskEmail("a@x.test")).toBe("a*@x.test");
  });

  it("reports an implausible value as null rather than echoing it", () => {
    expect(maskEmail("not-an-address")).toBeNull();
    expect(maskEmail("@x.test")).toBeNull();
    expect(maskEmail("a@")).toBeNull();
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(12345)).toBeNull();
  });

  it("never emits the full recipient address from the revision serializers", () => {
    const full = serializeRevision(revisionRow());
    expect(JSON.stringify(full)).not.toContain("soc@acme.example");
    expect(full.recipientEmailMasked).toBe("s**@acme.example");
    expect(full.hasRecipientEmail).toBe(true);
    expect(full).not.toHaveProperty("recipientEmail");

    const summary = serializeRevisionSummary(revisionRow());
    expect(JSON.stringify(summary)).not.toContain("soc@acme.example");
    expect(summary).not.toHaveProperty("recipientEmail");
  });
});

describe("what each serializer does emit", () => {
  it("gives a revision its content, its checksum and a derived isCurrent", () => {
    const output = serializeRevision(revisionRow());
    expect(output.subject).toBe("Accessible RDP exposure notification");
    expect(output.contentChecksum).toBe("a".repeat(64));
    expect(output.isCurrent).toBe(true);
    // Internal notes ARE visible to holders of read:notifications — a reviewer
    // must see the whole record they are approving. They are never EXPORTED,
    // which is a different guarantee and is proven in the artifact tests.
    expect(output.analystNotes).toBe("Internal: called the contact.");
  });

  it("marks a superseded revision as not current without exposing the mechanism", () => {
    const output = serializeRevision({
      ...revisionRow(),
      supersededAt: new Date("2026-08-03T09:00:00.000Z"),
    });
    expect(output.isCurrent).toBe(false);
  });

  it("omits the legacy unversioned display projection from the notification summary", () => {
    // Returning `title`/`message` next to the authoritative revision would
    // invite a client to render whichever it read first.
    const output = serializeNotificationSummary(notificationRow());
    expect(output).not.toHaveProperty("title");
    expect(output).not.toHaveProperty("message");
    expect(output).not.toHaveProperty("severity");
    expect(output).not.toHaveProperty("status");
    expect(output).not.toHaveProperty("type");
    expect(output.lifecycleState).toBe("APPROVED");
  });

  it("reduces an organization to id, name and sector only", () => {
    const output = serializeNotificationSummary(notificationRow());
    expect(output.organization).toEqual({ id: 9, name: "Acme Bank", sector: "FINANCE" });
  });

  it("gives an export its integrity facts and no bytes", () => {
    const output = serializeExport(contaminate(exportRow()));
    expect(output.artifactChecksum).toBe("b".repeat(64));
    expect(output.artifactByteLength).toBe(1234);
    expect(output.filename).toBe("notification-TNX-NOT-2026-000003-rev2.eml");
    expect(output).not.toHaveProperty("bytes");
    expect(output).not.toHaveProperty("artifact");
  });

  it("keeps the reviewer note on the lifecycle event, where the analyst must read it", () => {
    const output = serializeLifecycleEvent(lifecycleRow());
    expect(output.note).toBe("Content verified against the case evidence.");
    expect(output.reasonCode).toBe("APPROVED_BY_REVIEWER");
    expect(output.revisionId).toBe(7);
  });

  it("keeps the delivery reference and note, which are the analyst's own record", () => {
    const output = serializeDeliveryEvent(deliveryRow());
    expect(output.reference).toBe("TICKET-99");
    expect(output.note).toBe("Sent from the analyst mailbox.");
    expect(output.exportId).toBe(4);
  });
});
