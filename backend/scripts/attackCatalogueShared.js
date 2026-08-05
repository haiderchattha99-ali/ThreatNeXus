"use strict";

// Constants and deterministic-serialization helpers shared by the ATT&CK
// catalogue build script, the CI verification script, and the runtime loader.
//
// Kept in ONE module so the build script and the verifier cannot disagree about
// where the catalogue lives, what it is called, or how it is serialized — a
// disagreement there would make the integrity check pass against a file the
// application never reads, which is worse than having no check.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Bumped only when the derived catalogue's SHAPE changes. The loader refuses a
// catalogue whose formatVersion it does not recognise rather than reading
// unfamiliar fields optimistically.
const CATALOGUE_FORMAT_VERSION = 1;

const CATALOGUE_DIR = path.join(__dirname, "..", "src", "data", "attack");
const CATALOGUE_FILENAME = "enterprise-attack-catalogue.json";
const MANIFEST_FILENAME = "enterprise-attack-manifest.json";

// STIX vocabulary. `mitre-attack` names both the external-reference source that
// carries real ATT&CK ids and the enterprise kill chain.
const MITRE_ATTACK_SOURCE_NAME = "mitre-attack";
const ENTERPRISE_KILL_CHAIN_NAME = "mitre-attack";

function sha256OfBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256OfFile(filePath) {
  return sha256OfBuffer(fs.readFileSync(filePath));
}

/**
 * JSON with 2-space indent, a trailing newline, and LF line endings.
 *
 * The explicit `\n` normalization matters on Windows, where a checkout with
 * `core.autocrlf=true` would otherwise give the same logical file two different
 * SHA-256 values on two machines and make the integrity gate fail for a reason
 * that has nothing to do with the catalogue. `.gitattributes` pins the stored
 * form; this pins the written form.
 */
function stableStringify(value) {
  return `${JSON.stringify(value, null, 2).replace(/\r\n/g, "\n")}\n`;
}

module.exports = {
  CATALOGUE_FORMAT_VERSION,
  CATALOGUE_DIR,
  CATALOGUE_FILENAME,
  MANIFEST_FILENAME,
  MITRE_ATTACK_SOURCE_NAME,
  ENTERPRISE_KILL_CHAIN_NAME,
  sha256OfBuffer,
  sha256OfFile,
  stableStringify,
};
