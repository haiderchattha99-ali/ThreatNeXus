"use strict";

const { cleanupRequestUploads } = require("../lib/fileCleanup");

// Guarantees an uploaded temp file is removed no matter how the request ends:
// success, validation rejection, a throwing controller, a rejected promise, or
// a client that disconnects mid-response.
//
// Mount this BEFORE the multer middleware. Registering the listener first means
// cleanup is armed even when multer itself fails and skips the rest of the
// chain; the handler reads req.file when the response ends, by which point
// multer has populated it.
function cleanupUpload(req, res, next) {
  let alreadyRan = false;

  const runCleanup = () => {
    if (alreadyRan) return;
    alreadyRan = true;

    // Intentionally not awaited: the response has already been sent, so
    // cleanup must not delay it, and a cleanup failure must never change the
    // status or body the client received. cleanupRequestUploads does not
    // throw, and the catch is a belt-and-braces guard against an unhandled
    // rejection taking down the process.
    cleanupRequestUploads(req).catch(() => {});
  };

  // "finish" covers a completed response; "close" covers an aborted one.
  res.on("finish", runCleanup);
  res.on("close", runCleanup);

  next();
}

module.exports = cleanupUpload;
