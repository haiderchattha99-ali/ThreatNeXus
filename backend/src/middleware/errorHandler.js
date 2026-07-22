"use strict";

const { redact } = require("../lib/redact");

const SAFE_STATUS_CODES = new Set([400, 401, 403, 404, 409, 422]);

function resolveStatus(err) {
  if (typeof err.status === "number" && SAFE_STATUS_CODES.has(err.status)) {
    return err.status;
  }
  if (
    typeof err.statusCode === "number" &&
    SAFE_STATUS_CODES.has(err.statusCode)
  ) {
    return err.statusCode;
  }
  return 500;
}

function resolveMessage(err, status) {
  if (status === 500) {
    return "An unexpected error occurred.";
  }
  if (typeof err.message === "string" && err.message.trim() !== "") {
    return err.message;
  }
  return "Request failed.";
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const requestId = req.context && req.context.requestId;
  const status = resolveStatus(err);

  const logMeta = redact({
    name: err.name,
    message: err.message,
    status,
    requestId,
    method: req.method,
    path: req.originalUrl,
  });
  console.error("Unhandled request error", logMeta);

  const body = {
    success: false,
    message: resolveMessage(err, status),
  };
  if (requestId) {
    body.requestId = requestId;
  }

  res.status(status).json(body);
}

module.exports = errorHandler;
