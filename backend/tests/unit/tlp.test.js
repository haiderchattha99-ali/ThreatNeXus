import { describe, it, expect } from "vitest";

const {
  TLP_VALUES,
  TLP_DISPLAY,
  DEFAULT_TLP,
  InvalidTlpError,
  isValidTlp,
  assertValidTlp,
  displayTlp,
  isAtLeastAsRestrictive,
} = require("../../src/lib/tlp");

describe("tlp", () => {
  it("exposes all five TLP values", () => {
    expect(TLP_VALUES).toEqual(
      expect.arrayContaining(["CLEAR", "GREEN", "AMBER", "AMBER_STRICT", "RED"])
    );
    expect(TLP_VALUES).toHaveLength(5);
  });

  it("defaults to AMBER", () => {
    expect(DEFAULT_TLP).toBe("AMBER");
  });

  it("displays AMBER_STRICT as TLP:AMBER+STRICT", () => {
    expect(displayTlp("AMBER_STRICT")).toBe("TLP:AMBER+STRICT");
    expect(TLP_DISPLAY.AMBER_STRICT).toBe("TLP:AMBER+STRICT");
  });

  it("displays all values with the TLP: prefix", () => {
    expect(displayTlp("CLEAR")).toBe("TLP:CLEAR");
    expect(displayTlp("GREEN")).toBe("TLP:GREEN");
    expect(displayTlp("AMBER")).toBe("TLP:AMBER");
    expect(displayTlp("RED")).toBe("TLP:RED");
  });

  it("orders comparator from least to most restrictive", () => {
    expect(isAtLeastAsRestrictive("RED", "CLEAR")).toBe(true);
    expect(isAtLeastAsRestrictive("AMBER_STRICT", "AMBER")).toBe(true);
    expect(isAtLeastAsRestrictive("CLEAR", "RED")).toBe(false);
    expect(isAtLeastAsRestrictive("AMBER", "AMBER")).toBe(true);
  });

  it("recognizes valid values and rejects invalid ones", () => {
    expect(isValidTlp("RED")).toBe(true);
    expect(isValidTlp("PURPLE")).toBe(false);
    expect(isValidTlp(undefined)).toBe(false);
    expect(isValidTlp(null)).toBe(false);
    expect(isValidTlp(42)).toBe(false);
  });

  it("fails safe on invalid values for assertValidTlp", () => {
    expect(() => assertValidTlp("PURPLE")).toThrow(InvalidTlpError);
    expect(() => assertValidTlp(undefined)).toThrow(InvalidTlpError);
  });

  it("fails safe on invalid values for displayTlp", () => {
    expect(() => displayTlp("PURPLE")).toThrow(InvalidTlpError);
  });

  it("fails safe on invalid values for isAtLeastAsRestrictive", () => {
    expect(() => isAtLeastAsRestrictive("PURPLE", "RED")).toThrow(InvalidTlpError);
    expect(() => isAtLeastAsRestrictive("RED", "PURPLE")).toThrow(InvalidTlpError);
  });
});
