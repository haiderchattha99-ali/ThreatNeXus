"use strict";

// The manual-export artifact builder (Phase 4).
//
// ---------------------------------------------------------------------------
// This module builds bytes. It never sends them.
// ---------------------------------------------------------------------------
// There is no transport here and none anywhere else in this system: no SMTP
// client, no webhook, no messaging SDK, no `fetch`, no `mailto:` launch, no
// queue. `require`ing this file pulls in exactly one runtime dependency, crypto,
// for the artifact checksum. The output is handed to an analyst as a download;
// what happens to it afterwards is a human act that only the delivery timeline
// can record.
//
// ---------------------------------------------------------------------------
// Header injection is prevented twice, on purpose
// ---------------------------------------------------------------------------
// notificationRules rejects control characters in single-line fields at WRITE
// time, so a CR or LF cannot be stored in a subject, recipient name or
// recipient address at all. This module re-checks every value it is about to
// place in a header and THROWS rather than stripping. Silently sanitizing here
// would mean a stored value that should have been impossible produces a
// slightly-different artifact instead of an alarm — and a defence that exists
// in only one place is one refactor away from not existing.
//
// ---------------------------------------------------------------------------
// What is deliberately NOT in the artifact
// ---------------------------------------------------------------------------
//   - Bcc, or any second recipient of any kind. There is exactly one To.
//   - analystNotes — internal working notes, never constituent-facing.
//   - audit rows, database ids, primary keys, internal fingerprints.
//   - API keys, tokens, environment values, filesystem paths.
//   - organization contact detail beyond the single approved recipient
//     (no phone, no industry, no location, no secondary contacts).
//   - a Message-ID. This system does not send the message and therefore has no
//     authority to mint its identifier; a fabricated one would be indexed by
//     the recipient's mail system as though it came from a real transmission.
//     The same reasoning bans a fake Received header or a delivery receipt.
//   - a real From address. RFC 5322 requires the field, so it is emitted with
//     the RFC 2606 reserved `.invalid` TLD, which is guaranteed never to
//     resolve. The artifact therefore cannot be mistaken for having been sent
//     by us, and cannot be replied to by accident. The analyst's own mail
//     client supplies the true sender when they send it.

const crypto = require("crypto");

const {
  EXPORT_FORMATS,
  containsControlCharacters,
  isValidRecipientEmail,
} = require("./notificationRules");

const CRLF = "\r\n";

// RFC 2606 §2 reserves `.invalid` for names that are guaranteed not to be
// resolvable. See the header note on why the From field looks like this.
const PLACEHOLDER_FROM = "ThreatNeXus notification (unsent draft) <noreply@threatnexus.invalid>";

const CONTENT_TYPES = Object.freeze({
  EML: "message/rfc822",
  TXT: "text/plain; charset=utf-8",
});

const FILE_EXTENSIONS = Object.freeze({ EML: "eml", TXT: "txt" });

class NotificationArtifactError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "NotificationArtifactError";
    this.field = typeof field === "string" ? field : null;
  }
}

// Throws rather than sanitizes — see the module header.
function assertHeaderSafe(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new NotificationArtifactError(`${field} must be a string`, field);
  }
  if (containsControlCharacters(value)) {
    throw new NotificationArtifactError(
      `${field} contains a control character and cannot be placed in a header`,
      field
    );
  }
  return value;
}

function isAscii(value) {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value);
}

/**
 * RFC 2047 encoded-word for a non-ASCII header value.
 *
 * Base64 rather than Q-encoding because it has no per-character escaping rules
 * to get subtly wrong, and the result is unambiguous. ASCII values are emitted
 * as-is so the common case stays human-readable in a text editor.
 */
function encodeHeaderValue(value) {
  if (isAscii(value)) return value;
  return `=?utf-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Formats one address as an RFC 5322 name-addr.
 *
 * The display name is emitted as an encoded-word when it is not ASCII, and is
 * quoted otherwise. Quoting escapes `"` and `\`, which are the only two
 * characters that can terminate or continue a quoted-string — everything else
 * dangerous was already refused by assertHeaderSafe and by the recipient-email
 * pattern in notificationRules.
 */
function formatAddress(name, email) {
  assertHeaderSafe(email, "recipientEmail");
  if (!isValidRecipientEmail(email)) {
    throw new NotificationArtifactError("recipientEmail is not a valid address", "recipientEmail");
  }

  const displayName = assertHeaderSafe(name, "recipientName");
  if (displayName === null || displayName === "") return `<${email}>`;

  if (!isAscii(displayName)) return `${encodeHeaderValue(displayName)} <${email}>`;
  return `"${displayName.replace(/([\\"])/g, "\\$1")}" <${email}>`;
}

// RFC 5322 §3.3 date-time, in UTC (+0000). Fixed English abbreviations rather
// than a locale-dependent formatter: the artifact must be byte-identical on
// every machine, and its checksum is recorded.
const DAY_NAMES = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
const MONTH_NAMES = Object.freeze([
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]);

function formatRfc5322Date(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new NotificationArtifactError("exportedAt must be a valid date", "exportedAt");
  }
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${DAY_NAMES[date.getUTCDay()]}, ${pad(date.getUTCDate())} ` +
    `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

const QP_MAX_LINE_LENGTH = 76;

/**
 * RFC 2045 §6.7 quoted-printable.
 *
 * Chosen over base64 so the exported message stays readable in a text editor
 * (an analyst reviewing what they are about to send should not have to decode
 * it), and over raw 8-bit so the artifact is a valid 7-bit-clean RFC 5322
 * message rather than one that only works where 8BITMIME does.
 *
 * The three rules that are easy to get wrong, and are handled explicitly:
 *   - `=` must always be encoded, or the decoder cannot tell data from escape.
 *   - whitespace at the END of a line must be encoded, because a mail
 *     transport is permitted to strip trailing whitespace and would otherwise
 *     silently alter the content.
 *   - a soft line break is a trailing `=`; every output line including it must
 *     stay within 76 characters.
 */
function encodeQuotedPrintable(text) {
  const encodeByte = (byte) => `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;

  return text
    .split("\n")
    .map((line) => {
      const tokens = [];
      const bytes = Buffer.from(line, "utf8");

      bytes.forEach((byte) => {
        const isPrintable = (byte >= 33 && byte <= 60) || (byte >= 62 && byte <= 126);
        const isSpaceOrTab = byte === 32 || byte === 9;
        tokens.push(isPrintable || isSpaceOrTab ? String.fromCharCode(byte) : encodeByte(byte));
      });

      // Trailing whitespace would be strippable in transit, so it is encoded.
      while (tokens.length > 0 && (tokens[tokens.length - 1] === " " || tokens[tokens.length - 1] === "\t")) {
        const last = tokens.pop();
        tokens.push(encodeByte(last.charCodeAt(0)));
      }

      const out = [];
      let current = "";
      tokens.forEach((token) => {
        // -1 leaves room for the soft-break "=" that terminates a wrapped line.
        if (current.length + token.length > QP_MAX_LINE_LENGTH - 1) {
          out.push(`${current}=`);
          current = "";
        }
        current += token;
      });
      out.push(current);
      return out.join(CRLF);
    })
    .join(CRLF);
}

/**
 * Assembles the constituent-facing message text from an approved revision.
 *
 * Exactly two sections, in a fixed order: the approved body, then the approved
 * remediation guidance when one exists. Nothing else is added — no signature
 * block naming a person, no auto-generated footer making claims about how to
 * reply, no tracking marker, and no analyst notes.
 */
function composeMessageText(revision) {
  const sections = [revision.body];
  if (typeof revision.remediationGuidance === "string" && revision.remediationGuidance !== "") {
    sections.push(revision.remediationGuidance);
  }
  return sections.join("\n\n");
}

/**
 * A filesystem- and header-safe download filename.
 *
 * Whitelist, not blacklist: anything outside [A-Za-z0-9._-] becomes `-`. That
 * removes path separators, quotes, semicolons, CR/LF and every reserved
 * Windows character in one rule, so the value can be placed in a
 * Content-Disposition header and written to disk without further escaping.
 *
 * The whitelist alone is NOT sufficient, and the first version of this
 * function was wrong about that: `.` is a permitted character, so a reference
 * of "../../etc/passwd" survives as "notification-..-..-etc-passwd", which
 * carries no separator and cannot traverse, but still contains `..`. Runs of
 * dots are therefore collapsed to a single dot and leading dots stripped, so
 * the result can never be a relative path segment or a hidden file.
 *
 * In practice the reference is server-generated ("TNX-NOT-2026-000042") and
 * never caller-supplied, so this is defence in depth — which is exactly why it
 * has to actually hold rather than merely look like it does.
 */
function buildFilename(notificationReference, revisionNumber, format) {
  const base = `notification-${notificationReference}-rev${revisionNumber}`;
  const safe = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .slice(0, 120);
  const extension = FILE_EXTENSIONS[format] || FILE_EXTENSIONS.TXT;
  return `${safe || "notification"}.${extension}`;
}

function buildEml({ revision, notificationReference, exportedAt }) {
  const subject = assertHeaderSafe(revision.subject, "subject");
  const to = formatAddress(revision.recipientName, revision.recipientEmail);

  const headers = [
    `From: ${PLACEHOLDER_FROM}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${formatRfc5322Date(exportedAt)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    // External-facing identifiers only. `notificationReference` and
    // `revisionNumber` are the values shown in the UI and quoted in
    // correspondence; no primary key, checksum or internal id appears here.
    `X-ThreatNeXus-Notification: ${assertHeaderSafe(notificationReference, "notificationReference")}`,
    `X-ThreatNeXus-Revision: ${revision.revisionNumber}`,
  ];

  // The single empty line that separates headers from body. Everything above
  // it was control-character-checked, which is what makes this the ONLY place
  // the header block can end.
  return `${headers.join(CRLF)}${CRLF}${CRLF}${encodeQuotedPrintable(composeMessageText(revision))}${CRLF}`;
}

function buildTxt({ revision, notificationReference, exportedAt }) {
  const subject = assertHeaderSafe(revision.subject, "subject");
  const to = formatAddress(revision.recipientName, revision.recipientEmail);

  // The same information as the .eml, in a form with no header semantics at
  // all. Offered for environments where a message/rfc822 attachment is
  // unacceptable; it is not a lesser artifact, and its checksum is recorded
  // identically.
  const lines = [
    `Notification: ${assertHeaderSafe(notificationReference, "notificationReference")}`,
    `Revision:     ${revision.revisionNumber}`,
    `Prepared:     ${formatRfc5322Date(exportedAt)}`,
    `To:           ${to}`,
    `Subject:      ${subject}`,
    "",
    "-".repeat(72),
    "",
    composeMessageText(revision),
    "",
  ];

  return lines.join("\n");
}

/**
 * Builds the export artifact for one approved revision.
 *
 * Deterministic apart from `exportedAt`, which the caller supplies: the same
 * revision exported at the same instant produces byte-identical output, which
 * is what makes the recorded checksum meaningful.
 *
 * @returns {{bytes:Buffer, filename:string, contentType:string,
 *   checksum:string, byteLength:number}}
 */
function buildArtifact({ revision, notificationReference, exportedAt, format }) {
  if (!revision || typeof revision !== "object") {
    throw new NotificationArtifactError("revision is required", "revision");
  }

  const text =
    format === EXPORT_FORMATS.TXT
      ? buildTxt({ revision, notificationReference, exportedAt })
      : buildEml({ revision, notificationReference, exportedAt });

  const bytes = Buffer.from(text, "utf8");

  return {
    bytes,
    filename: buildFilename(notificationReference, revision.revisionNumber, format),
    contentType: CONTENT_TYPES[format] || CONTENT_TYPES.TXT,
    checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
}

module.exports = {
  CRLF,
  PLACEHOLDER_FROM,
  CONTENT_TYPES,
  FILE_EXTENSIONS,
  NotificationArtifactError,
  assertHeaderSafe,
  isAscii,
  encodeHeaderValue,
  formatAddress,
  formatRfc5322Date,
  encodeQuotedPrintable,
  composeMessageText,
  buildFilename,
  buildEml,
  buildTxt,
  buildArtifact,
};
