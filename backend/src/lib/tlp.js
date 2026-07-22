"use strict";

const TLP_VALUES = Object.freeze([
  "CLEAR",
  "GREEN",
  "AMBER",
  "AMBER_STRICT",
  "RED",
]);

const TLP_DISPLAY = Object.freeze({
  CLEAR: "TLP:CLEAR",
  GREEN: "TLP:GREEN",
  AMBER: "TLP:AMBER",
  AMBER_STRICT: "TLP:AMBER+STRICT",
  RED: "TLP:RED",
});

const DEFAULT_TLP = "AMBER";

// Higher index = more restrictive (must be shared with a smaller audience).
const TLP_ORDER = Object.freeze({
  CLEAR: 0,
  GREEN: 1,
  AMBER: 2,
  AMBER_STRICT: 3,
  RED: 4,
});

class InvalidTlpError extends Error {
  constructor(value) {
    super(`Invalid TLP value: ${String(value)}`);
    this.name = "InvalidTlpError";
  }
}

function isValidTlp(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TLP_ORDER, value);
}

function assertValidTlp(value) {
  if (!isValidTlp(value)) {
    throw new InvalidTlpError(value);
  }
  return value;
}

function displayTlp(value) {
  assertValidTlp(value);
  return TLP_DISPLAY[value];
}

// Fails safe: throws on invalid input rather than guessing an ordering.
function isAtLeastAsRestrictive(a, b) {
  assertValidTlp(a);
  assertValidTlp(b);
  return TLP_ORDER[a] >= TLP_ORDER[b];
}

module.exports = {
  TLP_VALUES,
  TLP_DISPLAY,
  DEFAULT_TLP,
  InvalidTlpError,
  isValidTlp,
  assertValidTlp,
  displayTlp,
  isAtLeastAsRestrictive,
};
