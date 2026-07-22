"use strict";

const fs = require("fs");
const path = require("path");

// Resolved from this file rather than process.cwd() so the directory is the
// same whether the app is started from backend/, from the repo root, or by a
// test runner.
const UPLOAD_TEMP_DIR = path.resolve(__dirname, "..", "..", "uploads");

// Containment check for every deletion. A traversal payload such as
// "uploads/../../../etc/passwd" resolves outside the upload directory and is
// rejected here; the directory itself is rejected too so a bug can never turn
// into a directory removal.
function isWithinUploadDir(filePath, uploadDir = UPLOAD_TEMP_DIR) {
  if (typeof filePath !== "string" || filePath.trim() === "") return false;

  const resolvedDir = path.resolve(uploadDir);
  const resolvedPath = path.resolve(filePath);

  if (resolvedPath === resolvedDir) return false;
  return resolvedPath.startsWith(resolvedDir + path.sep);
}

// Deletes a single uploaded temp file. Returns true only when a file was
// actually removed. Never throws: cleanup runs after the response has been
// sent, so a failure here must not surface anywhere.
//
// Paths are never included in log output — the filename is derived from a
// request and the absolute path discloses server layout.
async function safeUnlink(filePath, options = {}) {
  const { uploadDir = UPLOAD_TEMP_DIR, logger = console } = options;

  if (!isWithinUploadDir(filePath, uploadDir)) {
    logger.error("Upload cleanup refused: path is outside the upload directory");
    return false;
  }

  const resolvedPath = path.resolve(filePath);

  try {
    // lstat, not stat: a symlink reports isFile() false here, so a link
    // planted in the upload directory cannot be followed to delete its target.
    const stats = await fs.promises.lstat(resolvedPath);

    if (!stats.isFile()) {
      logger.error("Upload cleanup refused: target is not a regular file");
      return false;
    }

    await fs.promises.unlink(resolvedPath);
    return true;
  } catch (error) {
    // Already gone (e.g. a handler removed it) is the expected case, not an error.
    if (error && error.code === "ENOENT") return false;

    logger.error("Upload cleanup failed", { code: error && error.code });
    return false;
  }
}

// Handles every shape multer can populate: single(), array() and fields().
function collectUploadPaths(req) {
  if (!req || typeof req !== "object") return [];

  const files = [];

  if (req.file && typeof req.file.path === "string") {
    files.push(req.file.path);
  }

  if (Array.isArray(req.files)) {
    req.files.forEach((file) => {
      if (file && typeof file.path === "string") files.push(file.path);
    });
  } else if (req.files && typeof req.files === "object") {
    Object.values(req.files).forEach((group) => {
      if (!Array.isArray(group)) return;
      group.forEach((file) => {
        if (file && typeof file.path === "string") files.push(file.path);
      });
    });
  }

  return files;
}

async function cleanupRequestUploads(req, options) {
  const paths = collectUploadPaths(req);
  if (paths.length === 0) return 0;

  const results = await Promise.all(paths.map((p) => safeUnlink(p, options)));
  return results.filter(Boolean).length;
}

module.exports = {
  UPLOAD_TEMP_DIR,
  isWithinUploadDir,
  safeUnlink,
  collectUploadPaths,
  cleanupRequestUploads,
};
