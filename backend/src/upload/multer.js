"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

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

const upload = multer({ storage });

module.exports = upload;
