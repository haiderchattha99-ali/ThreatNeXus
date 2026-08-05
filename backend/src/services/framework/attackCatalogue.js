"use strict";

// The pinned MITRE ATT&CK Enterprise catalogue, as the running application sees
// it (Phase 6.3).
//
// ===========================================================================
// What changed in Phase 6.3, and why it mattered
// ===========================================================================
// Phase 5 shipped an honest gap and said so: reference ids were FORMAT-checked
// only, so `T9999` — a technique that has never existed — passed validation and
// reached an analyst's screen, and CATALOGUE_DISCLAIMER told every read path to
// admit it. That was the right call while no catalogue existed. It is not a
// resting place: a framework mapping whose identifier might name nothing is not
// evidence, and the build guard requires rejecting any framework id absent from
// a pinned local catalogue.
//
// This module is that catalogue. It is DERIVED from an official MITRE STIX 2.1
// bundle by backend/scripts/buildAttackCatalogue.js, committed, and pinned by
// SHA-256 in enterprise-attack-manifest.json.
//
// ===========================================================================
// Three properties this module is responsible for
// ===========================================================================
//
// 1. NO NETWORK, EVER. This file reads two committed JSON files from disk. It
//    imports no HTTP client, and neither does anything it requires. The URL in
//    the manifest is provenance — a record of where a human downloaded the
//    bundle from — and is never dereferenced. Live ATT&CK fetching is out of
//    scope for this phase, and the guarantee is the absence of a client, not a
//    disabled flag.
//
// 2. FAIL CLOSED. If the catalogue file is missing, unparseable, of an
//    unrecognised format version, or does not hash to what the manifest
//    declares, this module throws AttackCatalogueUnavailableError and keeps
//    throwing. It NEVER degrades to format-only checking. A silent fallback
//    would be the worst possible outcome: every ATT&CK mapping written during
//    the degraded window would be recorded as catalogue-verified while nothing
//    had verified it. Refusing to write an ATT&CK mapping is recoverable;
//    writing an unverifiable one and calling it verified is not.
//
// 3. INTEGRITY IS CHECKED AT LOAD, NOT ONLY IN CI. Hashing a 330 kB file costs
//    about a millisecond, once per process. Paying it means a catalogue that
//    was corrupted, truncated or edited after CI ran cannot quietly become the
//    thing the application validates against.
//
// The catalogue is loaded once, deep-frozen, and memoized — including a
// memoized FAILURE, so a broken deployment does not re-read and re-hash a bad
// file on every request.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CATALOGUE_FORMAT_VERSION = 1;
const CATALOGUE_DIR = path.join(__dirname, "..", "..", "data", "attack");
const CATALOGUE_FILENAME = "enterprise-attack-catalogue.json";
const MANIFEST_FILENAME = "enterprise-attack-manifest.json";

/**
 * The catalogue could not be loaded or does not match its manifest.
 *
 * Carries a closed `code` and NEVER an underlying filesystem path or parser
 * message: this reaches a controller, and a 503 body that names a server
 * directory is an information leak for no operational benefit. The detail goes
 * to the server log instead.
 */
class AttackCatalogueUnavailableError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AttackCatalogueUnavailableError";
    this.code = typeof code === "string" ? code : "ATTACK_CATALOGUE_UNAVAILABLE";
  }
}

const CATALOGUE_FAILURE_CODES = Object.freeze({
  MISSING: "ATTACK_CATALOGUE_MISSING",
  UNREADABLE: "ATTACK_CATALOGUE_UNREADABLE",
  CHECKSUM_MISMATCH: "ATTACK_CATALOGUE_CHECKSUM_MISMATCH",
  UNSUPPORTED_FORMAT: "ATTACK_CATALOGUE_UNSUPPORTED_FORMAT",
  MALFORMED: "ATTACK_CATALOGUE_MALFORMED",
});

let cached = null;

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
  return Object.freeze(value);
}

function readJsonFile(filePath, code) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (error) {
    throw new AttackCatalogueUnavailableError(
      "The pinned MITRE ATT&CK catalogue is not available",
      error && error.code === "ENOENT" ? CATALOGUE_FAILURE_CODES.MISSING : code
    );
  }
  try {
    return { raw, parsed: JSON.parse(raw.toString("utf8")) };
  } catch (error) {
    throw new AttackCatalogueUnavailableError(
      "The pinned MITRE ATT&CK catalogue could not be read",
      CATALOGUE_FAILURE_CODES.UNREADABLE
    );
  }
}

function buildCatalogue() {
  const { parsed: manifest } = readJsonFile(
    path.join(CATALOGUE_DIR, MANIFEST_FILENAME),
    CATALOGUE_FAILURE_CODES.UNREADABLE
  );
  const cataloguePath = path.join(CATALOGUE_DIR, CATALOGUE_FILENAME);
  const { raw, parsed: catalogue } = readJsonFile(
    cataloguePath,
    CATALOGUE_FAILURE_CODES.UNREADABLE
  );

  // Integrity first. Nothing below this line may read `catalogue` content until
  // the bytes are proven to be the pinned ones.
  const declared = manifest && manifest.derived && manifest.derived.sha256;
  const actual = crypto.createHash("sha256").update(raw).digest("hex");
  if (typeof declared !== "string" || declared.toLowerCase() !== actual) {
    // Logged with both digests because an operator debugging this needs them,
    // and neither is sensitive — they are hashes of a public MITRE derivative.
    console.error("ATT&CK catalogue checksum mismatch", { declared, actual });
    throw new AttackCatalogueUnavailableError(
      "The pinned MITRE ATT&CK catalogue failed its integrity check",
      CATALOGUE_FAILURE_CODES.CHECKSUM_MISMATCH
    );
  }

  if (catalogue.formatVersion !== CATALOGUE_FORMAT_VERSION) {
    throw new AttackCatalogueUnavailableError(
      "The pinned MITRE ATT&CK catalogue is in an unsupported format",
      CATALOGUE_FAILURE_CODES.UNSUPPORTED_FORMAT
    );
  }

  if (
    !Array.isArray(catalogue.tactics) ||
    catalogue.tactics.length === 0 ||
    !Array.isArray(catalogue.techniques) ||
    catalogue.techniques.length === 0 ||
    typeof catalogue.attackVersion !== "string"
  ) {
    throw new AttackCatalogueUnavailableError(
      "The pinned MITRE ATT&CK catalogue is structurally invalid",
      CATALOGUE_FAILURE_CODES.MALFORMED
    );
  }

  const byId = new Map();
  catalogue.techniques.forEach((technique) => {
    byId.set(technique.id, technique);
  });

  // Tactic order is MITRE's published matrix order, already baked into the
  // derived file. Sorted defensively so a hand-edited catalogue that passed the
  // hash check (it could not) still could not reorder the navigator.
  const tactics = [...catalogue.tactics].sort((left, right) => left.order - right.order);
  const tacticsByShortName = new Map(tactics.map((tactic) => [tactic.shortName, tactic]));

  return deepFreeze({
    attackVersion: catalogue.attackVersion,
    domain: catalogue.domain,
    formatVersion: catalogue.formatVersion,
    checksum: actual,
    source: {
      url: manifest.source && manifest.source.url,
      upstreamCommit: manifest.source && manifest.source.upstreamCommit,
      upstreamSha256: manifest.source && manifest.source.upstreamSha256,
      retrievedAt: manifest.source && manifest.source.retrievedAt,
      repository: manifest.source && manifest.source.repository,
    },
    attribution: manifest.attribution,
    counts: {
      tactics: tactics.length,
      techniques: catalogue.techniques.length,
      parentTechniques: catalogue.techniques.filter((technique) => !technique.isSubTechnique).length,
      subTechniques: catalogue.techniques.filter((technique) => technique.isSubTechnique).length,
      deprecated: catalogue.techniques.filter((technique) => technique.deprecated).length,
      revoked: catalogue.techniques.filter((technique) => technique.revoked).length,
      mappable: catalogue.techniques.filter(
        (technique) => !technique.deprecated && !technique.revoked
      ).length,
    },
    tactics,
    techniques: catalogue.techniques,
    // Maps are frozen by reference; deepFreeze does not traverse them, and
    // nothing here mutates one after construction.
    byId,
    tacticsByShortName,
  });
}

/**
 * The loaded catalogue, or a thrown AttackCatalogueUnavailableError.
 *
 * The failure is memoized as deliberately as the success: a deployment with a
 * corrupt catalogue should fail identically on request one and request ten
 * thousand, and should not re-hash a bad file each time.
 */
function getAttackCatalogue() {
  if (cached === null) {
    try {
      cached = { ok: true, value: buildCatalogue() };
    } catch (error) {
      cached = {
        ok: false,
        error:
          error instanceof AttackCatalogueUnavailableError
            ? error
            : new AttackCatalogueUnavailableError(
                "The pinned MITRE ATT&CK catalogue could not be loaded",
                CATALOGUE_FAILURE_CODES.UNREADABLE
              ),
      };
    }
  }
  if (!cached.ok) throw cached.error;
  return cached.value;
}

/**
 * True when the catalogue is loadable. For read surfaces that must render an
 * explicit "unavailable" state rather than 500 — the navigator says so on the
 * page instead of showing an empty matrix that reads as "nothing is mapped".
 */
function isAttackCatalogueAvailable() {
  try {
    getAttackCatalogue();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * One technique entry, or null. Exact match on the canonical id — no fuzzy
 * matching, no nearest-neighbour, no case folding beyond the caller's own
 * canonicalization. An id that is not in the catalogue returns null and the
 * caller refuses; it is never resolved to "the closest thing".
 */
function findTechnique(referenceId) {
  if (typeof referenceId !== "string") return null;
  return getAttackCatalogue().byId.get(referenceId) || null;
}

function findTactic(shortName) {
  if (typeof shortName !== "string") return null;
  return getAttackCatalogue().tacticsByShortName.get(shortName) || null;
}

/**
 * Provenance for read paths and the UI. Carries no technique data — a caller
 * that wants the matrix asks for the matrix.
 */
function catalogueProvenance() {
  const catalogue = getAttackCatalogue();
  return {
    framework: "MITRE_ATTACK",
    domain: catalogue.domain,
    attackVersion: catalogue.attackVersion,
    checksum: catalogue.checksum,
    source: catalogue.source,
    attribution: catalogue.attribution,
    counts: catalogue.counts,
  };
}

// Test-only. Never called by application code; exists so a test can exercise a
// missing or corrupt catalogue without leaving the failure memoized for the
// rest of the file's tests.
function resetAttackCatalogueCacheForTests() {
  cached = null;
}

module.exports = {
  CATALOGUE_FORMAT_VERSION,
  CATALOGUE_DIR,
  CATALOGUE_FILENAME,
  MANIFEST_FILENAME,
  CATALOGUE_FAILURE_CODES,
  AttackCatalogueUnavailableError,
  getAttackCatalogue,
  isAttackCatalogueAvailable,
  findTechnique,
  findTactic,
  catalogueProvenance,
  resetAttackCatalogueCacheForTests,
};
