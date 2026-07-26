"use strict";

const multer = require("multer");

// MulterError never sets .status/.statusCode itself, so without this an
// oversized upload (LIMIT_FILE_SIZE) or any other multer rejection would
// fall through errorHandler.js's status resolution to a generic 500 instead
// of the already-supported, more accurate 413/400. Mounted once in app.js,
// ahead of the shared errorHandler, so both upload routes (threats, reports)
// get a consistent, safe status without each route handling it separately.
// eslint-disable-next-line no-unused-vars
function normalizeMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    err.status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  }
  next(err);
}

module.exports = normalizeMulterError;
