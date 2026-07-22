"use strict";

const crypto = require("crypto");

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;

function generateRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function requestContext(req, res, next) {
  const suppliedId = req.headers[REQUEST_ID_HEADER];
  const requestId =
    typeof suppliedId === "string" && SAFE_REQUEST_ID_PATTERN.test(suppliedId)
      ? suppliedId
      : generateRequestId();

  req.context = {
    requestId,
    startedAt: Date.now(),
  };

  res.setHeader("X-Request-Id", requestId);

  next();
}

module.exports = requestContext;
