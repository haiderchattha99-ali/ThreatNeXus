import { describe, it, expect } from "vitest";

// The export artifact: RFC 5322 structure, header-injection resistance,
// encoding correctness, filename safety, and — the property the whole phase
// rests on — that nothing internal reaches the bytes an analyst sends to a
// constituent.

const crypto = require("node:crypto");

const {
  CRLF,
  PLACEHOLDER_FROM,
  NotificationArtifactError,
  assertHeaderSafe,
  encodeHeaderValue,
  formatAddress,
  formatRfc5322Date,
  encodeQuotedPrintable,
  composeMessageText,
  buildFilename,
  buildArtifact,
} = require("../../src/services/notification/notificationArtifactBuilder");

const EXPORTED_AT = new Date("2026-08-03T09:30:00.000Z");

function revision(overrides = {}) {
  return {
    id: 5,
    notificationId: 2,
    revisionNumber: 3,
    subject: "Accessible RDP exposure notification",
    body: "Dear contact,\n\nOne host is exposed.",
    remediationGuidance: "Restrict access at the network boundary.",
    recipientName: "Sec Contact",
    recipientEmail: "soc@example.org",
    analystNotes: "INTERNAL: constituent disputed a previous notice.",
    contentChecksum: "irrelevant-here",
    ...overrides,
  };
}

function build(overrides = {}, format = "EML") {
  return buildArtifact({
    revision: revision(overrides),
    notificationReference: "TNX-NOT-2026-000042",
    exportedAt: EXPORTED_AT,
    format,
  });
}

function text(artifact) {
  return artifact.bytes.toString("utf8");
}

describe("RFC 5322 structure", () => {
  it("uses CRLF line endings throughout, with no bare LF or bare CR", () => {
    const body = text(build());
    // Every LF must be preceded by a CR, and every CR followed by an LF.
    expect(/(?<!\r)\n/.test(body)).toBe(false);
    expect(/\r(?!\n)/.test(body)).toBe(false);
    expect(body.includes(CRLF)).toBe(true);
  });

  it("emits the mandatory fields and separates headers from body with one empty line", () => {
    const body = text(build());
    const [headerBlock, ...rest] = body.split(`${CRLF}${CRLF}`);
    const headers = headerBlock.split(CRLF);

    expect(headers[0]).toBe(`From: ${PLACEHOLDER_FROM}`);
    expect(headers[1]).toBe('To: "Sec Contact" <soc@example.org>');
    expect(headers).toContain("MIME-Version: 1.0");
    expect(headers).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(headers).toContain("Content-Transfer-Encoding: quoted-printable");
    expect(headers).toContain("Date: Mon, 03 Aug 2026 09:30:00 +0000");
    expect(rest.length).toBeGreaterThan(0);
  });

  it("addresses the message from a guaranteed-unresolvable placeholder sender", () => {
    // RFC 2606 reserves .invalid. The artifact must be impossible to mistake
    // for something this system actually sent, and impossible to reply to.
    expect(PLACEHOLDER_FROM).toMatch(/\.invalid>$/);
    expect(text(build())).toContain(PLACEHOLDER_FROM);
  });

  it("carries only external-facing identifiers in X- headers", () => {
    const body = text(build());
    expect(body).toContain("X-ThreatNeXus-Notification: TNX-NOT-2026-000042");
    expect(body).toContain("X-ThreatNeXus-Revision: 3");
    // No primary key, no checksum, no case id, no organization id.
    expect(body).not.toMatch(/X-ThreatNeXus-(Id|Case|Organization|Checksum)/);
  });

  it("does not mint a Message-ID or fabricate any delivery evidence", () => {
    // This system does not send the message and therefore has no authority to
    // identify it. A synthesized Message-ID would be indexed by the
    // recipient's mail system as though a real transmission had occurred.
    const body = text(build());
    expect(body).not.toMatch(/^Message-ID:/im);
    expect(body).not.toMatch(/^Received:/im);
    expect(body).not.toMatch(/^Return-Path:/im);
    expect(body).not.toMatch(/^Disposition-Notification-To:/im);
  });

  it("has exactly one recipient and no Bcc or Cc of any kind", () => {
    const body = text(build());
    expect((body.match(/^To:/gm) || []).length).toBe(1);
    expect(body).not.toMatch(/^Bcc:/im);
    expect(body).not.toMatch(/^Cc:/im);
  });
});

describe("what must never appear in the artifact", () => {
  it("omits the internal analyst notes entirely", () => {
    const body = text(build());
    expect(body).not.toContain("INTERNAL");
    expect(body).not.toContain("constituent disputed");
  });

  it("omits internal row identifiers and the content checksum", () => {
    const artifact = build();
    const body = text(artifact);
    expect(body).not.toContain("irrelevant-here");
    // The revision NUMBER is external-facing and does appear; the revision ROW
    // id and notification row id must not.
    expect(body).not.toMatch(/\bnotificationId\b/);
    expect(body).not.toMatch(/\brevisionId\b/);
  });

  it("carries only the message content and the approved guidance", () => {
    const composed = composeMessageText(revision());
    expect(composed).toBe(
      "Dear contact,\n\nOne host is exposed.\n\nRestrict access at the network boundary."
    );
    // With no guidance, nothing is invented to fill the gap.
    expect(composeMessageText(revision({ remediationGuidance: null }))).toBe(
      "Dear contact,\n\nOne host is exposed."
    );
  });
});

describe("header injection resistance", () => {
  it.each([
    ["subject", { subject: "Exposure\r\nBcc: attacker@evil.test" }],
    ["recipientName", { recipientName: "Contact\r\nBcc: attacker@evil.test" }],
    ["recipientEmail", { recipientEmail: "soc@example.org\r\nBcc: attacker@evil.test" }],
  ])("throws rather than sanitizing when %s carries a header break", (_field, overrides) => {
    // Throwing is the point: such a value should have been impossible to store
    // (notificationRules rejects it at write time), so its presence is an
    // alarm, not something to quietly clean up on the way out.
    expect(() => build(overrides)).toThrow(NotificationArtifactError);
  });

  it("refuses an address carrying a second recipient", () => {
    expect(() => build({ recipientEmail: "soc@example.org,attacker@evil.test" })).toThrow(
      NotificationArtifactError
    );
  });

  it("names the offending field but never echoes the offending value", () => {
    let thrown;
    try {
      build({ subject: "Exposure\r\nBcc: attacker@evil.test" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown.field).toBe("subject");
    expect(thrown.message).not.toContain("attacker@evil.test");
  });

  it("escapes quotes and backslashes in a display name rather than letting them terminate it", () => {
    const formatted = formatAddress('Say "hi" \\ bye', "soc@example.org");
    expect(formatted).toBe('"Say \\"hi\\" \\\\ bye" <soc@example.org>');
  });

  it("checks header safety directly", () => {
    expect(assertHeaderSafe("clean", "subject")).toBe("clean");
    expect(assertHeaderSafe(null, "subject")).toBeNull();
    expect(() => assertHeaderSafe("bad\r\n", "subject")).toThrow(NotificationArtifactError);
  });
});

describe("encoding", () => {
  it("emits ASCII header values verbatim and encodes non-ASCII as an RFC 2047 word", () => {
    expect(encodeHeaderValue("Plain subject")).toBe("Plain subject");
    const encoded = encodeHeaderValue("Exposición — RDP");
    expect(encoded).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // Round-trips to the original.
    const base64 = encoded.slice("=?utf-8?B?".length, -"?=".length);
    expect(Buffer.from(base64, "base64").toString("utf8")).toBe("Exposición — RDP");
  });

  it("encodes an em dash in the subject rather than emitting raw 8-bit in a header", () => {
    const body = text(build({ subject: "Exposure — TNX-2026-000001" }));
    expect(body).toMatch(/^Subject: =\?utf-8\?B\?/m);
  });

  it("quoted-printable encodes '=' and leaves ordinary printables alone", () => {
    expect(encodeQuotedPrintable("a=b")).toBe("a=3Db");
    expect(encodeQuotedPrintable("plain text")).toBe("plain text");
  });

  it("quoted-printable encodes trailing whitespace, which transports may strip", () => {
    expect(encodeQuotedPrintable("value  ")).toBe("value =20");
    expect(encodeQuotedPrintable("value\t")).toBe("value=09");
    // Interior whitespace is left readable.
    expect(encodeQuotedPrintable("a  b")).toBe("a  b");
  });

  it("wraps every quoted-printable line to at most 76 characters with a soft break", () => {
    const long = "x".repeat(200);
    const encoded = encodeQuotedPrintable(long);
    const lines = encoded.split(CRLF);
    lines.forEach((line) => expect(line.length).toBeLessThanOrEqual(76));
    // Every wrapped line but the last ends in the soft-break marker.
    lines.slice(0, -1).forEach((line) => expect(line.endsWith("=")).toBe(true));
    // And it round-trips: removing soft breaks restores the original.
    expect(encoded.replace(/=\r\n/g, "")).toBe(long);
  });

  it("encodes non-ASCII body bytes so the artifact stays 7-bit clean", () => {
    const encoded = encodeQuotedPrintable("café");
    expect(encoded).toBe("caf=C3=A9");
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(text(build({ body: "Aviso: café" })))).toBe(false);
  });

  it("formats the date in fixed UTC English, independent of the host locale", () => {
    expect(formatRfc5322Date(new Date("2026-01-04T05:06:07.000Z"))).toBe(
      "Sun, 04 Jan 2026 05:06:07 +0000"
    );
    expect(() => formatRfc5322Date(new Date("nonsense"))).toThrow(NotificationArtifactError);
  });
});

describe("filenames", () => {
  it("builds a predictable name from the reference and revision number", () => {
    expect(buildFilename("TNX-NOT-2026-000042", 3, "EML")).toBe(
      "notification-TNX-NOT-2026-000042-rev3.eml"
    );
    expect(buildFilename("TNX-NOT-2026-000042", 1, "TXT")).toBe(
      "notification-TNX-NOT-2026-000042-rev1.txt"
    );
  });

  it.each([
    ["path traversal", "../../etc/passwd"],
    ["windows path", "C:\\Windows\\System32"],
    ["quote and semicolon", 'evil"; filename="x'],
    ["CRLF", "evil\r\nX-Injected: yes"],
    ["null byte", "evil\u0000.eml"],
  ])("strips every dangerous character from a %s reference", (_label, reference) => {
    const name = buildFilename(reference, 1, "EML");
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain("\\");
    expect(name).not.toContain('"');
    expect(name.startsWith(".")).toBe(false);
    expect(name).not.toContain("..");
  });
});

describe("artifact identity", () => {
  it("records a SHA-256 of the exact bytes and their length", () => {
    const artifact = build();
    expect(artifact.checksum).toBe(
      crypto.createHash("sha256").update(artifact.bytes).digest("hex")
    );
    expect(artifact.byteLength).toBe(artifact.bytes.length);
    expect(artifact.contentType).toBe("message/rfc822");
  });

  it("is byte-identical for the same revision at the same instant", () => {
    expect(build().checksum).toBe(build().checksum);
  });

  it("differs when the content differs", () => {
    expect(build().checksum).not.toBe(build({ body: "Different body." }).checksum);
  });

  it("produces a plain-text artifact with no header semantics when TXT is requested", () => {
    const artifact = build({}, "TXT");
    const body = text(artifact);
    expect(artifact.contentType).toBe("text/plain; charset=utf-8");
    expect(artifact.filename.endsWith(".txt")).toBe(true);
    expect(body).toContain("Notification: TNX-NOT-2026-000042");
    expect(body).toContain("Dear contact,");
    // Still no internal notes, and still no fabricated identifiers.
    expect(body).not.toContain("INTERNAL");
    expect(body).not.toMatch(/^Message-ID:/im);
  });

  it("refuses to build without a revision", () => {
    expect(() =>
      buildArtifact({ revision: null, notificationReference: "R", exportedAt: EXPORTED_AT })
    ).toThrow(NotificationArtifactError);
  });
});

describe("no transport exists", () => {
  it("pulls in no network or mail dependency", () => {
    // The builder's whole dependency surface is node:crypto plus the pure
    // rules module. A future edit that reached for nodemailer, axios or
    // node:net would fail here.
    const source = require("node:fs").readFileSync(
      require("node:path").join(
        __dirname,
        "../../src/services/notification/notificationArtifactBuilder.js"
      ),
      "utf8"
    );
    const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(requires).toEqual(["crypto", "./notificationRules"]);

    // Comment lines are stripped first: the module's own header discusses SMTP
    // at length in order to explain why there is none, and an assertion that
    // failed on the explanation rather than on the code would be worthless.
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/nodemailer|smtp|sendmail|axios|node:net|node:tls|fetch\(/i);
  });
});
