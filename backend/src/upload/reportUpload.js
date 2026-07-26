"use strict";

const path = require("path");
const multer = require("multer");

const env = require("../config/env");
const sharedUpload = require("./multer");

// Same disk storage as the shared upload instance (safe random filename,
// never derived from the client-controlled original name) — see multer.js.
// Only .csv is accepted here; unlike the shared instance (also used by the
// legacy threat CSV import), this route is new, so the filter can be strict
// from the start without changing any existing route's behavior.
const CSV_EXTENSION_PATTERN = /\.csv$/i;

function csvOnlyFilter(req, file, cb) {
  const extension = path.extname(file.originalname || "");
  if (!CSV_EXTENSION_PATTERN.test(extension)) {
    // false (not an Error): multer skips the file without writing it to disk
    // and without aborting the request. The controller's existing "no file"
    // handling then rejects the request safely — no separate error path to
    // keep in sync with "missing file".
    return cb(null, false);
  }
  return cb(null, true);
}

const reportUpload = multer({
  storage: sharedUpload.storage,
  limits: { fileSize: env.UPLOAD_MAX_BYTES },
  fileFilter: csvOnlyFilter,
});

module.exports = reportUpload;
