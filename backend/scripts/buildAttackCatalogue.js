#!/usr/bin/env node
"use strict";

// Derives the pinned local MITRE ATT&CK Enterprise catalogue from an OFFICIAL
// MITRE STIX 2.1 bundle.
//
// ---------------------------------------------------------------------------
// This script is the ONLY thing in the repository that reads a STIX bundle
// ---------------------------------------------------------------------------
// It is run by a human, deliberately, against a bundle that has already been
// downloaded to disk. Nothing in `backend/src/` imports it, nothing calls it at
// runtime, and it opens no network socket — the URL in the manifest is a
// PROVENANCE RECORD, not something this system will ever fetch. The build plan
// forbids live external calls in this phase, and "we only fetch it at build
// time" is exactly the kind of drift that becomes a runtime dependency two
// refactors later. So the fetch is the operator's job, and this script verifies
// what they handed it.
//
// The upstream bundle is ~53 MB and is NOT committed. What is committed is the
// derived catalogue (identifiers, names, tactic membership, lifecycle flags and
// official URLs) plus a manifest that records where it came from and the SHA-256
// of both files. That makes the pin auditable — anyone can re-download the same
// upstream file, re-run this script, and get a byte-identical catalogue — without
// putting 53 MB of vendored third-party data in the tree.
//
// ATT&CK technique DESCRIPTIONS are deliberately NOT copied. They are the bulk
// of the upstream file, they change between releases, and an analyst who needs
// one is better served by the official URL this catalogue carries for every
// technique than by a snapshot that will silently go stale.
//
// Usage:
//   node backend/scripts/buildAttackCatalogue.js \
//     --bundle <path-to-enterprise-attack-19.1.json> \
//     [--expect-sha256 <hex>] [--attack-version 19.1] \
//     [--source-url <url>] [--upstream-commit <sha>] [--retrieved-at YYYY-MM-DD]
//
// Determinism: every array is sorted by a stable key and the JSON is written
// with a fixed key order and a trailing newline, so re-running against the same
// bundle reproduces the same bytes and therefore the same SHA-256. If that ever
// stops being true, verifyAttackCatalogue.js fails and CI goes red.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  CATALOGUE_DIR,
  CATALOGUE_FILENAME,
  MANIFEST_FILENAME,
  CATALOGUE_FORMAT_VERSION,
  MITRE_ATTACK_SOURCE_NAME,
  ENTERPRISE_KILL_CHAIN_NAME,
  sha256OfFile,
  stableStringify,
} = require("./attackCatalogueShared");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function fail(message) {
  process.stderr.write(`buildAttackCatalogue: ${message}\n`);
  process.exit(1);
}

// The mitre-attack external reference is the ONLY place a real ATT&CK id lives.
// An object without one is not an ATT&CK object we can name, and is skipped
// rather than guessed at.
function attackReference(stixObject) {
  const references = Array.isArray(stixObject.external_references)
    ? stixObject.external_references
    : [];
  return references.find(
    (reference) =>
      reference &&
      reference.source_name === MITRE_ATTACK_SOURCE_NAME &&
      typeof reference.external_id === "string"
  );
}

// Enterprise tactic membership, in the bundle's own vocabulary. Only the
// enterprise kill chain is read: a bundle that also carried mobile or ICS
// phases must not silently contribute them to an Enterprise catalogue.
function enterpriseTacticShortNames(stixObject) {
  const phases = Array.isArray(stixObject.kill_chain_phases) ? stixObject.kill_chain_phases : [];
  return phases
    .filter((phase) => phase && phase.kill_chain_name === ENTERPRISE_KILL_CHAIN_NAME)
    .map((phase) => phase.phase_name)
    .filter((name) => typeof name === "string" && name.length > 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundlePath = args.bundle;
  if (typeof bundlePath !== "string") {
    fail("--bundle <path-to-official-stix-bundle.json> is required");
  }
  if (!fs.existsSync(bundlePath)) {
    fail(`bundle not found: ${bundlePath}`);
  }

  // Integrity BEFORE parse. A bundle that is not the one the operator believes
  // they downloaded must never reach the derivation logic, because everything
  // downstream would then be a faithful, deterministic catalogue of the wrong
  // data.
  const upstreamSha256 = sha256OfFile(bundlePath);
  if (typeof args["expect-sha256"] === "string") {
    const expected = args["expect-sha256"].trim().toLowerCase();
    if (expected !== upstreamSha256) {
      fail(
        `bundle SHA-256 mismatch\n  expected: ${expected}\n  actual:   ${upstreamSha256}\n` +
          "Refusing to derive a catalogue from an unverified bundle."
      );
    }
  }

  const upstreamBytes = fs.statSync(bundlePath).size;
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  if (!bundle || !Array.isArray(bundle.objects)) {
    fail("bundle is not a STIX bundle with an objects array");
  }

  const objects = bundle.objects;
  const byStixId = new Map(objects.map((object) => [object.id, object]));

  // ---------------------------------------------------------------------
  // Tactics, in the matrix's own declared order
  // ---------------------------------------------------------------------
  // Column order is not alphabetical and is not ours to invent: it is the
  // adversary lifecycle order MITRE publishes in the x-mitre-matrix object.
  // Sorting it any other way would make the navigator misrepresent the matrix.
  const matrix = objects.find(
    (object) => object.type === "x-mitre-matrix" && object.x_mitre_deprecated !== true
  );
  if (!matrix || !Array.isArray(matrix.tactic_refs)) {
    fail("bundle contains no usable x-mitre-matrix object");
  }

  const tactics = [];
  matrix.tactic_refs.forEach((ref, index) => {
    const object = byStixId.get(ref);
    if (!object || object.type !== "x-mitre-tactic") return;
    if (object.revoked === true || object.x_mitre_deprecated === true) return;
    const reference = attackReference(object);
    if (!reference) return;
    tactics.push({
      id: reference.external_id,
      shortName: object.x_mitre_shortname,
      name: object.name,
      order: index,
      url: reference.url || null,
    });
  });

  if (tactics.length === 0) fail("no enterprise tactics were derived");

  const tacticShortNames = new Set(tactics.map((tactic) => tactic.shortName));

  // ---------------------------------------------------------------------
  // revoked-by: what replaced a revoked technique
  // ---------------------------------------------------------------------
  // A revoked id is not the same failure as an unknown id, and an analyst who
  // typed a revoked id deserves to be told what it became rather than just
  // "no". Built from the bundle's own relationship objects — never guessed.
  const revokedBy = new Map();
  objects.forEach((object) => {
    if (object.type !== "relationship" || object.relationship_type !== "revoked-by") return;
    const target = byStixId.get(object.target_ref);
    if (!target) return;
    const targetReference = attackReference(target);
    if (!targetReference) return;
    revokedBy.set(object.source_ref, targetReference.external_id);
  });

  // ---------------------------------------------------------------------
  // Techniques and sub-techniques
  // ---------------------------------------------------------------------
  const techniques = [];
  const seenIds = new Set();

  objects.forEach((object) => {
    if (object.type !== "attack-pattern") return;
    const reference = attackReference(object);
    if (!reference) return;

    const id = reference.external_id;
    // A duplicate id in an official bundle would mean two objects claim the
    // same technique. That is not something to resolve by picking one.
    if (seenIds.has(id)) {
      fail(`duplicate ATT&CK id in bundle: ${id}`);
    }
    seenIds.add(id);

    const isSubTechnique = object.x_mitre_is_subtechnique === true;
    // Derived from the id itself rather than from a relationship: the dotted
    // form IS the parent link in ATT&CK, and deriving it any other way would
    // let a malformed relationship silently reparent a sub-technique.
    const parentId = isSubTechnique ? id.split(".")[0] : null;
    if (isSubTechnique && !/^T\d{4}\.\d{3}$/.test(id)) {
      fail(`sub-technique id has an unexpected shape: ${id}`);
    }
    if (!isSubTechnique && !/^T\d{4}$/.test(id)) {
      fail(`technique id has an unexpected shape: ${id}`);
    }

    const tacticNames = enterpriseTacticShortNames(object).filter((name) =>
      tacticShortNames.has(name)
    );

    techniques.push({
      id,
      name: object.name,
      isSubTechnique,
      parentId,
      tactics: [...tacticNames].sort(),
      deprecated: object.x_mitre_deprecated === true,
      revoked: object.revoked === true,
      revokedBy: revokedBy.get(object.id) || null,
      url: reference.url || null,
    });
  });

  if (techniques.length === 0) fail("no techniques were derived");

  // Every sub-technique must have a parent present in the same catalogue, or
  // the parent/child distinction the validator depends on is not actually
  // decidable. Fail here rather than shipping a catalogue with dangling parents.
  const idSet = new Set(techniques.map((technique) => technique.id));
  const orphans = techniques
    .filter((technique) => technique.isSubTechnique && !idSet.has(technique.parentId))
    .map((technique) => technique.id);
  if (orphans.length > 0) {
    fail(`sub-techniques with no parent in the bundle: ${orphans.slice(0, 10).join(", ")}`);
  }

  // displayName is the human string MITRE itself uses for a sub-technique
  // ("Remote Services: Remote Desktop Protocol"). Composed once here so no
  // renderer has to know the rule and no two renderers can disagree.
  const nameById = new Map(techniques.map((technique) => [technique.id, technique.name]));
  techniques.forEach((technique) => {
    technique.displayName = technique.isSubTechnique
      ? `${nameById.get(technique.parentId)}: ${technique.name}`
      : technique.name;
  });

  techniques.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const collection = objects.find((object) => object.type === "x-mitre-collection");
  const attackVersion =
    (typeof args["attack-version"] === "string" && args["attack-version"]) ||
    (collection && collection.x_mitre_version) ||
    null;
  if (!attackVersion) fail("could not determine the ATT&CK version; pass --attack-version");

  const catalogue = {
    catalogueId: "mitre-attack-enterprise",
    formatVersion: CATALOGUE_FORMAT_VERSION,
    attackVersion,
    domain: "enterprise-attack",
    killChainName: ENTERPRISE_KILL_CHAIN_NAME,
    tactics,
    techniques: techniques.map((technique) => ({
      id: technique.id,
      name: technique.name,
      displayName: technique.displayName,
      isSubTechnique: technique.isSubTechnique,
      parentId: technique.parentId,
      tactics: technique.tactics,
      deprecated: technique.deprecated,
      revoked: technique.revoked,
      revokedBy: technique.revokedBy,
      url: technique.url,
    })),
  };

  const cataloguePath = path.join(CATALOGUE_DIR, CATALOGUE_FILENAME);
  fs.mkdirSync(CATALOGUE_DIR, { recursive: true });
  fs.writeFileSync(cataloguePath, stableStringify(catalogue), "utf8");

  const derivedSha256 = sha256OfFile(cataloguePath);
  const derivedBytes = fs.statSync(cataloguePath).size;

  const activeTechniques = techniques.filter(
    (technique) => !technique.deprecated && !technique.revoked
  );

  const manifest = {
    formatVersion: CATALOGUE_FORMAT_VERSION,
    generatedBy: "backend/scripts/buildAttackCatalogue.js",
    source: {
      project: "MITRE ATT&CK",
      domain: "enterprise-attack",
      attackVersion,
      repository: "https://github.com/mitre-attack/attack-stix-data",
      url:
        (typeof args["source-url"] === "string" && args["source-url"]) ||
        "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack-19.1.json",
      upstreamCommit:
        typeof args["upstream-commit"] === "string" ? args["upstream-commit"] : null,
      upstreamSha256,
      upstreamBytes,
      retrievedAt: typeof args["retrieved-at"] === "string" ? args["retrieved-at"] : null,
    },
    derived: {
      file: CATALOGUE_FILENAME,
      sha256: derivedSha256,
      bytes: derivedBytes,
      tacticCount: tactics.length,
      techniqueCount: techniques.length,
      parentTechniqueCount: techniques.filter((technique) => !technique.isSubTechnique).length,
      subTechniqueCount: techniques.filter((technique) => technique.isSubTechnique).length,
      deprecatedCount: techniques.filter((technique) => technique.deprecated).length,
      revokedCount: techniques.filter((technique) => technique.revoked).length,
      mappableTechniqueCount: activeTechniques.length,
    },
    attribution:
      "© 2015-2026 The MITRE Corporation. This work is reproduced and distributed with the " +
      "permission of The MITRE Corporation. MITRE ATT&CK® is a registered trademark of The MITRE " +
      "Corporation. See https://attack.mitre.org/resources/legal-and-branding/terms-of-use/",
    note:
      "Derived identifiers, names, tactic membership, lifecycle flags and official URLs only. " +
      "Technique descriptions are NOT reproduced; each entry carries its official ATT&CK URL. " +
      "Nothing in backend/src fetches this data at runtime.",
  };

  fs.writeFileSync(path.join(CATALOGUE_DIR, MANIFEST_FILENAME), stableStringify(manifest), "utf8");

  process.stdout.write(
    [
      `ATT&CK Enterprise v${attackVersion}`,
      `  upstream sha256 : ${upstreamSha256}`,
      `  derived sha256  : ${derivedSha256}`,
      `  tactics         : ${tactics.length}`,
      `  techniques      : ${techniques.length} ` +
        `(${manifest.derived.parentTechniqueCount} parent / ${manifest.derived.subTechniqueCount} sub)`,
      `  deprecated      : ${manifest.derived.deprecatedCount}`,
      `  revoked         : ${manifest.derived.revokedCount}`,
      `  mappable        : ${manifest.derived.mappableTechniqueCount}`,
      "",
    ].join("\n")
  );
}

main();
