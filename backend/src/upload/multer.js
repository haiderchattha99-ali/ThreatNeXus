"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const env = require("../config/env");
const { UPLOAD_TEMP_DIR } = require("../lib/fileCleanup");

// multer only creates the directory for the `dest` shorthand, not for a
// `destination` callback, so an absent uploads/ made every upload fail with
// ENOENT. Created once at startup.
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });

const SAFE_EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;

const storage = multer.diskStorage({
  destination(req, file, cb) {
    // Absolute and shared with the cleanup helper, so "delete only inside the
    // upload directory" is a check that can actually be enforced.
    cb(null, UPLOAD_TEMP_DIR);
  },

  filename(req, file, cb) {
    // The client-controlled originalname never reaches the path. It can carry
    // traversal sequences ("../../x"), absolute paths, or NUL bytes, any of
    // which would place the file outside the upload directory. Only a
    // conservative extension is carried over; the name itself is generated.
    const extension = path.extname(file.originalname || "").toLowerCase();
    const safeExtension = SAFE_EXTENSION_PATTERN.test(extension) ? extension : "";
    const uniqueSuffix = crypto.randomBytes(8).toString("hex");

    cb(null, `${Date.now()}-${uniqueSuffix}${safeExtension}`);
  },
});

// UPLOAD_MAX_BYTES already exists in config/env.js and is applied to JSON
// bodies (see app.js), but was never wired to multer — a file upload had no
// enforced size cap at all. Wiring it here is additive protection for every
// route that uses this shared instance; it does not loosen anything.
const upload = multer({ storage, limits: { fileSize: env.UPLOAD_MAX_BYTES } });

// Exposed (not part of the default export shape) so a route-specific multer
// instance — e.g. reportUpload.js, which also needs a fileFilter — can reuse
// the exact same safe-filename storage rather than duplicating the path-
// traversal-safety logic above in a second file.
upload.storage = storage;

module.exports = upload;
