#!/usr/bin/env node
"use strict";

// CI gate for the pinned MITRE ATT&CK catalogue.
//
// Answers three questions, in order, and refuses to answer a later one if an
// earlier one fails:
//
//   1. INTEGRITY  — is the committed catalogue byte-for-byte the file the
//                   manifest says it is? (SHA-256, not a size or a date)
//   2. SHAPE      — is it structurally what the loader and the validator
//                   assume: known format version, every sub-technique's parent
//                   present, every tactic reference resolvable, no duplicate
//                   ids, id shapes correct?
//   3. AGREEMENT  — do the manifest's own counts match the catalogue it
//                   describes?
//
// Why all three rather than just the hash: a hash proves nobody edited the file
// by hand, but it would happily certify a catalogue that the build script
// produced from a truncated or wrong-domain bundle. The shape checks are what
// make "the pin is valid" mean something about the DATA and not just about the
// bytes.
//
// Exits 0 on success, 1 on any failure, and prints every failure rather than
// only the first — a single run should tell an operator everything that is
// wrong.
//
// Deliberately has NO dependencies beyond Node's standard library and no
// network access, so it can run in a CI job that has installed nothing.

const fs = require("fs");
const path = require("path");

const {
  CATALOGUE_FORMAT_VERSION,
  CATALOGUE_DIR,
  CATALOGUE_FILENAME,
  MANIFEST_FILENAME,
  sha256OfFile,
} = require("./attackCatalogueShared");

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    failures.push(`${label} is missing: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    failures.push(`${label} is not valid JSON (${error.name})`);
    return null;
  }
}

function main() {
  const cataloguePath = path.join(CATALOGUE_DIR, CATALOGUE_FILENAME);
  const manifestPath = path.join(CATALOGUE_DIR, MANIFEST_FILENAME);

  const manifest = readJson(manifestPath, "manifest");
  const catalogue = readJson(cataloguePath, "catalogue");
  if (!manifest || !catalogue) {
    report();
    return;
  }

  // --- 1. Integrity -------------------------------------------------------
  const actualSha256 = sha256OfFile(cataloguePath);
  const declaredSha256 = manifest.derived && manifest.derived.sha256;
  check(
    actualSha256 === declaredSha256,
    `catalogue SHA-256 does not match the manifest\n    manifest: ${declaredSha256}\n    actual:   ${actualSha256}`
  );

  const actualBytes = fs.statSync(cataloguePath).size;
  check(
    actualBytes === (manifest.derived && manifest.derived.bytes),
    `catalogue size does not match the manifest (manifest ${manifest.derived && manifest.derived.bytes}, actual ${actualBytes})`
  );

  // Provenance must be RECORDED, not merely plausible. A pinned catalogue whose
  // manifest cannot say which upstream file it came from is not pinned.
  const source = manifest.source || {};
  check(typeof source.url === "string" && source.url.startsWith("https://"), "manifest.source.url is missing or not https");
  check(/^[0-9a-f]{64}$/.test(String(source.upstreamSha256)), "manifest.source.upstreamSha256 is not a SHA-256 hex digest");
  check(typeof source.attackVersion === "string" && source.attackVersion.length > 0, "manifest.source.attackVersion is missing");
  check(/^\d{4}-\d{2}-\d{2}$/.test(String(source.retrievedAt)), "manifest.source.retrievedAt is not an ISO date");
  check(
    typeof source.upstreamCommit === "string" && /^[0-9a-f]{40}$/.test(source.upstreamCommit),
    "manifest.source.upstreamCommit is not a full git commit sha (the pin must be immutable, not a branch)"
  );

  // --- 2. Shape -----------------------------------------------------------
  check(
    catalogue.formatVersion === CATALOGUE_FORMAT_VERSION,
    `catalogue formatVersion ${catalogue.formatVersion} is not the supported version ${CATALOGUE_FORMAT_VERSION}`
  );
  check(catalogue.domain === "enterprise-attack", `catalogue domain is ${catalogue.domain}, expected enterprise-attack`);
  check(
    catalogue.attackVersion === source.attackVersion,
    `catalogue attackVersion (${catalogue.attackVersion}) disagrees with manifest.source.attackVersion (${source.attackVersion})`
  );

  const tactics = Array.isArray(catalogue.tactics) ? catalogue.tactics : [];
  const techniques = Array.isArray(catalogue.techniques) ? catalogue.techniques : [];
  check(tactics.length > 0, "catalogue has no tactics");
  check(techniques.length > 0, "catalogue has no techniques");

  const tacticShortNames = new Set();
  const tacticOrders = [];
  tactics.forEach((tactic, index) => {
    check(/^TA\d{4}$/.test(String(tactic.id)), `tactic ${index} has a malformed id: ${tactic.id}`);
    check(typeof tactic.shortName === "string" && tactic.shortName.length > 0, `tactic ${tactic.id} has no shortName`);
    check(typeof tactic.name === "string" && tactic.name.length > 0, `tactic ${tactic.id} has no name`);
    check(!tacticShortNames.has(tactic.shortName), `duplicate tactic shortName: ${tactic.shortName}`);
    tacticShortNames.add(tactic.shortName);
    tacticOrders.push(tactic.order);
  });
  // Matrix column order is the adversary lifecycle, and the navigator renders
  // straight from it. A gap or a repeat would silently reorder the matrix.
  check(
    tacticOrders.every((order, index) => Number.isInteger(order) && order === index),
    "tactic `order` values are not a contiguous 0..n-1 sequence in array order"
  );

  const ids = new Set();
  const parentIds = new Set();
  let subCount = 0;
  let deprecatedCount = 0;
  let revokedCount = 0;

  techniques.forEach((technique) => {
    const id = String(technique.id);
    if (ids.has(id)) failures.push(`duplicate technique id: ${id}`);
    ids.add(id);

    if (technique.isSubTechnique === true) {
      subCount += 1;
      check(/^T\d{4}\.\d{3}$/.test(id), `sub-technique has a malformed id: ${id}`);
      check(
        technique.parentId === id.split(".")[0],
        `sub-technique ${id} declares parentId ${technique.parentId}, which is not its id prefix`
      );
    } else {
      parentIds.add(id);
      check(/^T\d{4}$/.test(id), `technique has a malformed id: ${id}`);
      check(technique.parentId === null, `parent technique ${id} must have parentId null, got ${technique.parentId}`);
    }

    check(typeof technique.name === "string" && technique.name.length > 0, `technique ${id} has no name`);
    check(typeof technique.displayName === "string" && technique.displayName.length > 0, `technique ${id} has no displayName`);
    check(Array.isArray(technique.tactics), `technique ${id} has no tactics array`);
    (technique.tactics || []).forEach((shortName) => {
      check(tacticShortNames.has(shortName), `technique ${id} references unknown tactic "${shortName}"`);
    });
    check(typeof technique.deprecated === "boolean", `technique ${id} has a non-boolean deprecated flag`);
    check(typeof technique.revoked === "boolean", `technique ${id} has a non-boolean revoked flag`);
    if (technique.deprecated) deprecatedCount += 1;
    if (technique.revoked) revokedCount += 1;
    if (technique.revokedBy !== null) {
      check(
        typeof technique.revokedBy === "string" && /^T\d{4}(\.\d{3})?$/.test(technique.revokedBy),
        `technique ${id} has a malformed revokedBy: ${technique.revokedBy}`
      );
    }
  });

  // The validator distinguishes a parent from a sub-technique and resolves a
  // sub-technique's parent. A dangling parent would make that undecidable.
  techniques
    .filter((technique) => technique.isSubTechnique === true)
    .forEach((technique) => {
      check(ids.has(technique.parentId), `sub-technique ${technique.id} has no parent in the catalogue`);
    });

  // Sorted-by-id is what makes the derived file reproducible, and the loader's
  // ordering guarantees rest on it.
  const sorted = techniques.map((technique) => String(technique.id)).every((id, index, all) => index === 0 || all[index - 1] < id);
  check(sorted, "techniques are not sorted ascending by id");

  // --- 3. Agreement -------------------------------------------------------
  const derived = manifest.derived || {};
  check(derived.tacticCount === tactics.length, `manifest tacticCount ${derived.tacticCount} != ${tactics.length}`);
  check(derived.techniqueCount === techniques.length, `manifest techniqueCount ${derived.techniqueCount} != ${techniques.length}`);
  check(derived.subTechniqueCount === subCount, `manifest subTechniqueCount ${derived.subTechniqueCount} != ${subCount}`);
  check(
    derived.parentTechniqueCount === techniques.length - subCount,
    `manifest parentTechniqueCount ${derived.parentTechniqueCount} != ${techniques.length - subCount}`
  );
  check(derived.deprecatedCount === deprecatedCount, `manifest deprecatedCount ${derived.deprecatedCount} != ${deprecatedCount}`);
  check(derived.revokedCount === revokedCount, `manifest revokedCount ${derived.revokedCount} != ${revokedCount}`);
  const mappable = techniques.filter((technique) => !technique.deprecated && !technique.revoked).length;
  check(derived.mappableTechniqueCount === mappable, `manifest mappableTechniqueCount ${derived.mappableTechniqueCount} != ${mappable}`);

  // Attribution is a licence obligation, not decoration.
  check(
    typeof manifest.attribution === "string" && manifest.attribution.includes("MITRE"),
    "manifest.attribution does not carry the MITRE attribution notice"
  );

  report({
    attackVersion: catalogue.attackVersion,
    sha256: actualSha256,
    tactics: tactics.length,
    techniques: techniques.length,
    subTechniques: subCount,
    mappable,
  });
}

function report(summary) {
  if (failures.length > 0) {
    process.stderr.write(`\nATT&CK catalogue verification FAILED (${failures.length}):\n`);
    failures.forEach((message) => process.stderr.write(`  - ${message}\n`));
    process.stderr.write("\n");
    process.exit(1);
  }
  process.stdout.write(
    [
      "ATT&CK catalogue verification PASS",
      `  version    : Enterprise v${summary.attackVersion}`,
      `  sha256     : ${summary.sha256}`,
      `  tactics    : ${summary.tactics}`,
      `  techniques : ${summary.techniques} (${summary.subTechniques} sub-techniques)`,
      `  mappable   : ${summary.mappable} (deprecated and revoked excluded)`,
      "",
    ].join("\n")
  );
}

main();
