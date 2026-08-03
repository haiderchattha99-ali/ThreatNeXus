"use strict";

// Pure, dependency-free rules for Phase 5 framework mapping.
//
// Nothing in this module touches Prisma, the wall clock, HTTP, the audit trail
// or any AI provider. Every service in services/framework/ and services/ai/
// validates through here BEFORE it opens a transaction, so an out-of-contract
// request is a controlled 400 at the boundary rather than a database enum error
// several layers down — the same convention as workflow/caseWorkflowRules.js.
//
// ===========================================================================
// The three claims this phase makes, and the many it refuses to make
// ===========================================================================
// An ACTIVE mapping asserts EXACTLY this: a named analyst associated a named
// framework reference with this case, on a stated evidence basis, and wrote
// down why.
//
// It does NOT assert:
//   - that the organization implements the control          (not compliance)
//   - that any control was audited or assessed              (not an audit)
//   - that a regulatory obligation is satisfied             (not certification)
//   - for ATT&CK, that a technique is "covered" or "detected"
//   - anything at all derivable from a port being open
//
// NIST CSF and CIS Controls mappings are analyst-associated CONTEXT. The words
// "compliant", "implemented", "certified", "audited" and "assessed" appear
// nowhere in any value this module produces, and COMPLIANCE_DISCLAIMER is
// carried on every read path so a screen cannot render a mapping list without
// the caveat that qualifies it.
//
// ===========================================================================
// The MITRE ATT&CK evidence rule is the load-bearing safety property
// ===========================================================================
// An exposed RDP service is an EXPOSURE. It is not adversary behaviour, and
// mapping it to T1021.001 ("Remote Services: Remote Desktop Protocol") because
// port 3389 answered would be fabricating an intrusion out of a scan result.
// The same is true of a CVE (a vulnerability is not an attack), KEV membership
// (exploited *somewhere*, by *someone*, is not exploited *here*), an EPSS
// score (a probability is not an event), an AbuseIPDB reputation result (what
// an address did elsewhere is not what happened to this constituent), the
// organization's sector, and the deterministic Risk v1 score.
//
// So an ATT&CK mapping must clear four gates, three structural and one
// lexical:
//
//   1. evidenceBasis MUST be OBSERVED_BEHAVIOR. The other three bases are
//      definitionally non-behavioural. (structural)
//   2. The rationale must reach MIN_ATTACK_RATIONALE_LENGTH — a technique
//      assertion in eight words is not a defensible one. (structural)
//   3. Evidence must be tied to the case or to a Finding currently linked to
//      it. Enforced in frameworkMappingService, which is the layer that can
//      read links. (structural)
//   4. The rationale must actually describe behaviour rather than restate
//      exposure signals. (lexical — see assertBehaviouralRationale)
//
// Gate 4 is deliberately DOCUMENTED AS WHAT IT IS: a bounded lexical guard,
// not semantic understanding. It requires at least one term from a closed
// behaviour vocabulary, and it refuses a rationale whose substance is nothing
// but exposure signals. It cannot detect a fluent, well-worded fabrication —
// nothing in software can, which is why gates 1-3 are structural and why the
// mapping records a named human actor. Gate 4 exists because the overwhelmingly
// common failure mode is not fabrication, it is an analyst honestly writing
// "port 3389 is open so this is T1021.001", and that specific mistake is
// mechanically detectable. It fails CLOSED: on doubt it refuses.

const FRAMEWORK_FAMILIES = Object.freeze({
  MITRE_ATTACK: "MITRE_ATTACK",
  NIST_CSF: "NIST_CSF",
  CIS_CONTROLS: "CIS_CONTROLS",
});

const FRAMEWORK_FAMILY_VALUES = Object.freeze(Object.values(FRAMEWORK_FAMILIES));

const MAPPING_SCOPES = Object.freeze({ CASE: "CASE", FINDING: "FINDING" });
const MAPPING_SCOPE_VALUES = Object.freeze(Object.values(MAPPING_SCOPES));

const MAPPING_STATES = Object.freeze({ ACTIVE: "ACTIVE", REMOVED: "REMOVED" });
const MAPPING_STATE_VALUES = Object.freeze(Object.values(MAPPING_STATES));

const EVIDENCE_BASES = Object.freeze({
  OBSERVED_BEHAVIOR: "OBSERVED_BEHAVIOR",
  CONTROL_GAP: "CONTROL_GAP",
  REMEDIATION_ALIGNMENT: "REMEDIATION_ALIGNMENT",
  ANALYST_ASSESSMENT: "ANALYST_ASSESSMENT",
});

const EVIDENCE_BASIS_VALUES = Object.freeze(Object.values(EVIDENCE_BASES));

const MAPPING_SOURCES = Object.freeze({
  MANUAL: "MANUAL",
  AI_SUGGESTION_PROMOTED: "AI_SUGGESTION_PROMOTED",
});

const MAPPING_SOURCE_VALUES = Object.freeze(Object.values(MAPPING_SOURCES));

// The ONLY evidence basis a MITRE ATT&CK mapping may carry.
const ATTACK_REQUIRED_EVIDENCE_BASIS = EVIDENCE_BASES.OBSERVED_BEHAVIOR;

// Carried on every framework read path. Deliberately a constant rather than a
// per-screen string so a second screen cannot render mappings without it.
const COMPLIANCE_DISCLAIMER =
  "Framework mappings record analyst-associated context only. An active mapping does not " +
  "state that a control is implemented, audited, assessed or compliant, and does not state " +
  "that an ATT&CK technique was executed beyond what its rationale asserts.";

// Carried alongside every reference id and title. This phase pins no local
// catalogue, so claiming validation would be a fabrication.
const CATALOGUE_DISCLAIMER =
  "Framework reference identifiers and titles are analyst-entered and format-checked only. " +
  "This system pins no local framework catalogue, so no reference is verified to exist.";

// --- Bounds -----------------------------------------------------------------
const MAX_FRAMEWORK_VERSION_LENGTH = 32;
const MAX_REFERENCE_ID_LENGTH = 64;
const MAX_REFERENCE_TITLE_LENGTH = 200;
const MIN_RATIONALE_LENGTH = 20;
const MAX_RATIONALE_LENGTH = 2000;
// An ATT&CK technique assertion carries a higher floor than any other mapping:
// it is the only mapping that claims something happened.
const MIN_ATTACK_RATIONALE_LENGTH = 60;
const MAX_REMOVAL_REASON_LENGTH = 1000;

// Bounded, explicit, never assumed. Accepts "v17.1", "2.0", "8.1",
// "ATT&CK v17.1 Enterprise" — and refuses an empty or control-character value.
const FRAMEWORK_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .&_+/-]{0,31}$/;

// Per-family reference id shapes. These are FORMAT checks, not catalogue
// lookups: T9999 passes the ATT&CK pattern and does not exist. That limitation
// is stated in CATALOGUE_DISCLAIMER and repeated on every read path rather
// than being quietly hidden behind a pattern that looks authoritative.
const REFERENCE_ID_PATTERNS = Object.freeze({
  // Enterprise technique or sub-technique: T1021 / T1021.001
  MITRE_ATTACK: /^T\d{4}(\.\d{3})?$/,
  // CSF 2.0 subcategory: <FUNCTION>.<CATEGORY>-<NN>, e.g. PR.AA-05
  NIST_CSF: /^(GV|ID|PR|DE|RS|RC)\.[A-Z]{2}-\d{2}$/,
  // CIS Controls v8: safeguard "4.6" or whole control "4"
  CIS_CONTROLS: /^(1[0-8]|[1-9])(\.\d{1,2})?$/,
});

// Human-readable shape hints returned with a rejection. Closed strings, never
// derived from the caller's input.
const REFERENCE_ID_HINTS = Object.freeze({
  MITRE_ATTACK: "Expected an ATT&CK technique id such as T1021 or T1021.001",
  NIST_CSF: "Expected a CSF 2.0 subcategory id such as PR.AA-05",
  CIS_CONTROLS: "Expected a CIS Controls v8 safeguard such as 4.6 or a control such as 4",
});

// ---------------------------------------------------------------------------
// Gate 4 vocabularies. Both are CLOSED lists, reviewed as code.
// ---------------------------------------------------------------------------
//
// Terms that describe adversary or user BEHAVIOUR — something that happened,
// was observed, was logged, or was reported. At least one must appear in an
// ATT&CK rationale.
const BEHAVIOUR_EVIDENCE_MARKERS = Object.freeze([
  /\bobserv(?:e|ed|ation)\b/i,
  /\bwitness(?:ed)?\b/i,
  /\blog(?:s|ged|ging|-in)?\b/i,
  /\btelemetry\b/i,
  /\bforensic(?:s|ally)?\b/i,
  /\bpacket capture\b/i,
  /\bnetflow\b/i,
  /\b(?:siem|edr|ids|ips)\b/i,
  /\balert(?:s|ed|ing)?\b/i,
  /\bincident report\b/i,
  /\bconfirmed by (?:the )?(?:organization|organisation|constituent)\b/i,
  /\breported by (?:the )?(?:organization|organisation|constituent)\b/i,
  /\bauthenticat(?:e|ed|ion)\b/i,
  /\b(?:failed |successful )?log(?:on|in)s?\b/i,
  /\bbrute[ -]?force\b/i,
  /\bpassword spray(?:ing)?\b/i,
  /\bcredential stuffing\b/i,
  /\bcredential (?:theft|dump(?:ing)?|access)\b/i,
  /\blateral movement\b/i,
  /\bpivot(?:ed|ing)?\b/i,
  /\bpersistence\b/i,
  /\bscheduled task\b/i,
  /\bregistry run key\b/i,
  /\bexfiltrat(?:e|ed|ion)\b/i,
  /\bransomware\b/i,
  /\bmalware\b/i,
  /\bpayload\b/i,
  /\bexecut(?:e|ed|ion)\b/i,
  /\bcommand(?:s|-line| line)?\b/i,
  /\binteractive (?:logon|session)\b/i,
  /\bremote (?:desktop )?session\b/i,
  /\bsession (?:was )?establish(?:ed)?\b/i,
  /\bconnected from\b/i,
  /\bconnection(?:s)? from\b/i,
  /\bunauthori[sz]ed access\b/i,
  /\bintrusion\b/i,
  /\bcompromis(?:e|ed)\b/i,
  /\battacker\b/i,
  /\badversary\b/i,
  /\bthreat actor\b/i,
  /\bhands[ -]on[ -]keyboard\b/i,
  /\bscreenshot(?:s|ting)?\b/i,
  /\bkeylog(?:ger|ging)?\b/i,
  /\btunnel(?:ed|ing|led|ling)?\b/i,
]);

// Exposure/enrichment signals. These are REMOVED from the rationale before its
// residual substance is measured, so a rationale built only from them cannot
// reach the residual floor. Every entry here corresponds to something the
// Phase 5 brief explicitly forbids an ATT&CK mapping from resting on.
const EXPOSURE_SIGNAL_MARKERS = Object.freeze([
  /\bcve-\d{4}-\d{4,7}\b/gi,
  /\bcve(?:s)?\b/gi,
  /\bkev\b/gi,
  /\bknown exploited vulnerabilit(?:y|ies)\b/gi,
  /\bepss(?: score)?\b/gi,
  /\babuse ?ipdb\b/gi,
  /\breputation(?: score| result)?\b/gi,
  /\brisk (?:score|band|rating)\b/gi,
  /\b(?:critical|high|medium|low) risk\b/gi,
  /\bsector\b/gi,
  /\bbanner(?:s| grab)?\b/gi,
  /\bshodan\b/gi,
  /\bcpe:[^\s]*/gi,
  /\bport\s*\/?\s*\d{1,5}\b/gi,
  /\btcp\s*\/\s*\d{1,5}\b/gi,
  /\budp\s*\/\s*\d{1,5}\b/gi,
  /\b\d{1,5}\/tcp\b/gi,
  /\bopen port(?:s)?\b/gi,
  /\bexposed (?:service|port|host|system)(?:s)?\b/gi,
  /\b(?:service|port|host|rdp) (?:is|was|are|were) exposed\b/gi,
  /\baccessible rdp\b/gi,
  /\brdp\b/gi,
  /\bremote desktop protocol\b/gi,
  /\bexposure\b/gi,
  // Bare forms too. "exposed to the internet" is the single most common way an
  // exposure-only ATT&CK rationale is actually written, and matching only the
  // compound forms above left it substantive enough to clear the residual
  // floor — measured directly against the fixture in
  // tests/unit/frameworkMappingRules.test.js.
  /\bexposed\b/gi,
  /\binternet\b/gi,
  /\bscore(?:s|d)?\b/gi,
  /\binternet[- ]facing\b/gi,
  /\bpublicly (?:accessible|reachable|exposed)\b/gi,
  /\bvulnerab(?:le|ility|ilities)\b/gi,
  /\bscan(?:s|ned|ning|ner)?\b/gi,
  /\bshadowserver\b/gi,
]);

// Ordinary connective words carry no evidential substance, so they are removed
// before the residual count. Kept deliberately short — this is not a
// linguistics exercise, it exists so "the and of a" cannot pad a rationale.
const RESIDUAL_STOPWORDS = Object.freeze(
  new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
    "with", "by", "from", "as", "is", "was", "are", "were", "be", "been",
    "being", "this", "that", "these", "those", "it", "its", "we", "our", "us",
    "has", "have", "had", "so", "then", "than", "there", "their", "which",
    "because", "due", "also", "very", "not", "no", "any", "all", "some",
    "case", "finding", "host", "system", "systems", "server", "servers",
    "asset", "assets", "organization", "organisation", "constituent",
  ])
);

// How many distinct substantive words must survive marker-stripping before an
// ATT&CK rationale counts as saying something beyond the exposure signals.
const MIN_ATTACK_RESIDUAL_WORDS = 6;

// Closed rejection vocabulary. Returned to the caller (an analyst needs to be
// told what to fix) and safe to place in an audit reason: every value is a
// literal from this table, never free text and never a database message.
const MAPPING_REJECTION_CODES = Object.freeze({
  ATTACK_REQUIRES_OBSERVED_BEHAVIOR: "ATTACK_REQUIRES_OBSERVED_BEHAVIOR",
  ATTACK_RATIONALE_TOO_SHORT: "ATTACK_RATIONALE_TOO_SHORT",
  ATTACK_RATIONALE_NOT_BEHAVIOURAL: "ATTACK_RATIONALE_NOT_BEHAVIOURAL",
  ATTACK_EXPOSURE_ONLY_RATIONALE: "ATTACK_EXPOSURE_ONLY_RATIONALE",
  ATTACK_EVIDENCE_NOT_LINKED: "ATTACK_EVIDENCE_NOT_LINKED",
  EVIDENCE_FINDING_NOT_LINKED: "EVIDENCE_FINDING_NOT_LINKED",
  EVIDENCE_FINDING_REQUIRED_FOR_SCOPE: "EVIDENCE_FINDING_REQUIRED_FOR_SCOPE",
  CASE_NOT_ORGANIZATION_BOUND: "CASE_NOT_ORGANIZATION_BOUND",
  MAPPING_NOT_CURRENT: "MAPPING_NOT_CURRENT",
  MAPPING_NOT_FOR_CASE: "MAPPING_NOT_FOR_CASE",
});

class FrameworkMappingValidationError extends Error {
  constructor(message, fields, code) {
    super(message);
    this.name = "FrameworkMappingValidationError";
    this.fields = Array.isArray(fields) ? fields : [];
    this.code = typeof code === "string" ? code : null;
  }
}

class FrameworkMappingNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrameworkMappingNotFoundError";
  }
}

// A well-formed request the durable state refuses (case not organization-bound,
// evidence not linked, mapping row not current). Controllers map it to 409,
// never 400 — the caller's input was fine, the world is not.
class FrameworkMappingStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FrameworkMappingStateError";
    this.code = typeof code === "string" ? code : null;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Trims, rejects blank, and rejects over-length rather than silently
// truncating: an analyst whose rationale was quietly cut in half would believe
// they recorded something they did not. Same rule as caseWorkflowRules.
function normalizeBoundedText(value, { field, maxLength, minLength = 0, required }) {
  if (value === undefined || value === null) {
    if (required) throw new FrameworkMappingValidationError(`${field} is required`, [field]);
    return null;
  }
  if (typeof value !== "string") {
    throw new FrameworkMappingValidationError(`${field} must be a string`, [field]);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new FrameworkMappingValidationError(`${field} is required`, [field]);
    return null;
  }
  if (trimmed.length > maxLength) {
    throw new FrameworkMappingValidationError(
      `${field} must be at most ${maxLength} characters`,
      [field]
    );
  }
  if (minLength > 0 && trimmed.length < minLength) {
    throw new FrameworkMappingValidationError(
      `${field} must be at least ${minLength} characters`,
      [field]
    );
  }
  // Control characters would let a stored value break every downstream
  // renderer and, in a future export path, a line-oriented format. Rejected
  // rather than stripped, the same choice Phase 4's artifact builder made.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(trimmed)) {
    throw new FrameworkMappingValidationError(
      `${field} must not contain control characters`,
      [field]
    );
  }
  return trimmed;
}

function assertMemberOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new FrameworkMappingValidationError(
      `${field} must be one of ${allowed.join(", ")}`,
      [field]
    );
  }
  return value;
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new FrameworkMappingValidationError(`${field} must be a positive integer`, [field]);
  }
  return value;
}

function assertValidDate(value, field) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new FrameworkMappingValidationError(`${field} must be a valid date`, [field]);
  }
  return value;
}

function normalizeFrameworkVersion(value) {
  const trimmed = normalizeBoundedText(value, {
    field: "frameworkVersion",
    maxLength: MAX_FRAMEWORK_VERSION_LENGTH,
    required: true,
  });
  if (!FRAMEWORK_VERSION_PATTERN.test(trimmed)) {
    throw new FrameworkMappingValidationError(
      "frameworkVersion must be a short alphanumeric version label",
      ["frameworkVersion"]
    );
  }
  return trimmed;
}

// Uppercased for ATT&CK and NIST (their identifiers are canonically uppercase),
// left as-is for CIS (which is numeric). Normalizing BEFORE the pattern check
// means "t1021" is accepted and stored canonically rather than becoming a
// second, silently-distinct mapping key from "T1021".
function normalizeReferenceId(value, framework) {
  const trimmed = normalizeBoundedText(value, {
    field: "referenceId",
    maxLength: MAX_REFERENCE_ID_LENGTH,
    required: true,
  });
  const canonical =
    framework === FRAMEWORK_FAMILIES.CIS_CONTROLS ? trimmed : trimmed.toUpperCase();

  const pattern = REFERENCE_ID_PATTERNS[framework];
  if (!pattern || !pattern.test(canonical)) {
    throw new FrameworkMappingValidationError(
      REFERENCE_ID_HINTS[framework] || "referenceId is not valid for this framework",
      ["referenceId"]
    );
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Gate 4: does this rationale describe behaviour, or only restate exposure?
// ---------------------------------------------------------------------------
function stripExposureSignals(text) {
  return EXPOSURE_SIGNAL_MARKERS.reduce(
    (accumulated, marker) => accumulated.replace(marker, " "),
    text
  );
}

function residualSubstantiveWords(text) {
  const stripped = stripExposureSignals(text.toLowerCase());
  const words = stripped
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !RESIDUAL_STOPWORDS.has(word));
  return new Set(words);
}

function hasBehaviourMarker(text) {
  return BEHAVIOUR_EVIDENCE_MARKERS.some((marker) => marker.test(text));
}

/**
 * The ATT&CK-only lexical gate. See this module's header for exactly how much
 * this claims (a bounded guard against exposure-restating rationales) and how
 * much it does not (semantic verification, which is not attempted).
 *
 * Throws FrameworkMappingValidationError carrying a closed rejection code.
 */
function assertBehaviouralRationale(rationale) {
  if (rationale.length < MIN_ATTACK_RATIONALE_LENGTH) {
    throw new FrameworkMappingValidationError(
      `A MITRE ATT&CK mapping requires a behaviour rationale of at least ${MIN_ATTACK_RATIONALE_LENGTH} characters`,
      ["rationale"],
      MAPPING_REJECTION_CODES.ATTACK_RATIONALE_TOO_SHORT
    );
  }
  if (!hasBehaviourMarker(rationale)) {
    throw new FrameworkMappingValidationError(
      "A MITRE ATT&CK mapping requires a rationale that describes observed adversary or user behaviour",
      ["rationale"],
      MAPPING_REJECTION_CODES.ATTACK_RATIONALE_NOT_BEHAVIOURAL
    );
  }
  if (residualSubstantiveWords(rationale).size < MIN_ATTACK_RESIDUAL_WORDS) {
    throw new FrameworkMappingValidationError(
      "A MITRE ATT&CK mapping may not rest only on exposure, vulnerability, reputation or risk signals",
      ["rationale"],
      MAPPING_REJECTION_CODES.ATTACK_EXPOSURE_ONLY_RATIONALE
    );
  }
  return rationale;
}

/**
 * Applies every framework-family obligation that can be decided WITHOUT the
 * database. The remaining ATT&CK obligation (evidence tied to the case or a
 * linked Finding) lives in frameworkMappingService, which is the layer that can
 * read links.
 */
function assertFrameworkObligations({ framework, evidenceBasis, rationale }) {
  if (framework !== FRAMEWORK_FAMILIES.MITRE_ATTACK) return;

  if (evidenceBasis !== ATTACK_REQUIRED_EVIDENCE_BASIS) {
    throw new FrameworkMappingValidationError(
      "A MITRE ATT&CK mapping requires evidenceBasis OBSERVED_BEHAVIOR",
      ["evidenceBasis"],
      MAPPING_REJECTION_CODES.ATTACK_REQUIRES_OBSERVED_BEHAVIOR
    );
  }
  assertBehaviouralRationale(rationale);
}

/**
 * Normalizes and validates one mapping's content, whether it came from an
 * analyst form or from an AI provider. ONE function so a suggestion can never
 * be held to a weaker standard than a hand-written mapping — that equivalence
 * is the reason promotion is safe.
 *
 * Deliberately does NOT accept actor, source, state, effectiveAt, current keys
 * or any other internal field: those are server-decided, and a caller that
 * could set them could forge provenance.
 */
function normalizeMappingContent(raw) {
  if (!isPlainObject(raw)) {
    throw new FrameworkMappingValidationError("mapping content must be an object", []);
  }

  const framework = assertMemberOf(raw.framework, FRAMEWORK_FAMILY_VALUES, "framework");
  const mappingScope = assertMemberOf(raw.mappingScope, MAPPING_SCOPE_VALUES, "mappingScope");
  const evidenceBasis = assertMemberOf(raw.evidenceBasis, EVIDENCE_BASIS_VALUES, "evidenceBasis");
  const frameworkVersion = normalizeFrameworkVersion(raw.frameworkVersion);
  const referenceId = normalizeReferenceId(raw.referenceId, framework);
  const referenceTitle = normalizeBoundedText(raw.referenceTitle, {
    field: "referenceTitle",
    maxLength: MAX_REFERENCE_TITLE_LENGTH,
    required: true,
  });
  const rationale = normalizeBoundedText(raw.rationale, {
    field: "rationale",
    maxLength: MAX_RATIONALE_LENGTH,
    minLength: MIN_RATIONALE_LENGTH,
    required: true,
  });

  let evidenceFindingId = null;
  if (raw.evidenceFindingId !== undefined && raw.evidenceFindingId !== null) {
    evidenceFindingId = assertPositiveInteger(raw.evidenceFindingId, "evidenceFindingId");
  }

  // A FINDING-scoped mapping without a Finding is incoherent — the scope is the
  // claim that this mapping is about one specific piece of evidence.
  if (mappingScope === MAPPING_SCOPES.FINDING && evidenceFindingId === null) {
    throw new FrameworkMappingValidationError(
      "A FINDING-scoped mapping requires evidenceFindingId",
      ["evidenceFindingId"],
      MAPPING_REJECTION_CODES.EVIDENCE_FINDING_REQUIRED_FOR_SCOPE
    );
  }

  assertFrameworkObligations({ framework, evidenceBasis, rationale });

  return Object.freeze({
    framework,
    frameworkVersion,
    referenceId,
    referenceTitle,
    mappingScope,
    evidenceBasis,
    rationale,
    evidenceFindingId,
  });
}

/**
 * "<caseId>:<framework>:<mappingScope>:<referenceId>" — the current-row key.
 *
 * The uniqueness invariant is per (case, framework, scope, reference), so a
 * single integer column cannot express it. Same shape and reasoning as
 * CaseFinding.currentLinkKey and FindingVulnerability.currentAssociationKey.
 */
function currentMappingKey(caseId, framework, mappingScope, referenceId) {
  return `${caseId}:${framework}:${mappingScope}:${referenceId}`;
}

/**
 * True when appending a row in `desiredState` would record a real change.
 *
 * Without this, a re-submitted form or a double-clicked button would append an
 * identical row and the mapping history would stop being a record of decisions
 * and become a log of UI activity. Same guard as isEscalationMeaningful.
 */
function isMappingChangeMeaningful(currentRow, desiredState) {
  if (!currentRow) return desiredState === MAPPING_STATES.ACTIVE;
  return currentRow.state !== desiredState;
}

module.exports = {
  FRAMEWORK_FAMILIES,
  FRAMEWORK_FAMILY_VALUES,
  MAPPING_SCOPES,
  MAPPING_SCOPE_VALUES,
  MAPPING_STATES,
  MAPPING_STATE_VALUES,
  EVIDENCE_BASES,
  EVIDENCE_BASIS_VALUES,
  MAPPING_SOURCES,
  MAPPING_SOURCE_VALUES,
  ATTACK_REQUIRED_EVIDENCE_BASIS,
  COMPLIANCE_DISCLAIMER,
  CATALOGUE_DISCLAIMER,
  MAX_FRAMEWORK_VERSION_LENGTH,
  MAX_REFERENCE_ID_LENGTH,
  MAX_REFERENCE_TITLE_LENGTH,
  MIN_RATIONALE_LENGTH,
  MAX_RATIONALE_LENGTH,
  MIN_ATTACK_RATIONALE_LENGTH,
  MIN_ATTACK_RESIDUAL_WORDS,
  MAX_REMOVAL_REASON_LENGTH,
  FRAMEWORK_VERSION_PATTERN,
  REFERENCE_ID_PATTERNS,
  REFERENCE_ID_HINTS,
  BEHAVIOUR_EVIDENCE_MARKERS,
  EXPOSURE_SIGNAL_MARKERS,
  MAPPING_REJECTION_CODES,
  FrameworkMappingValidationError,
  FrameworkMappingNotFoundError,
  FrameworkMappingStateError,
  isPlainObject,
  normalizeBoundedText,
  assertMemberOf,
  assertPositiveInteger,
  assertValidDate,
  normalizeFrameworkVersion,
  normalizeReferenceId,
  stripExposureSignals,
  residualSubstantiveWords,
  hasBehaviourMarker,
  assertBehaviouralRationale,
  assertFrameworkObligations,
  normalizeMappingContent,
  currentMappingKey,
  isMappingChangeMeaningful,
};
