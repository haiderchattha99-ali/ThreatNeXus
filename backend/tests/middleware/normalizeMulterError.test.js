import { describe, it, expect, vi } from "vitest";

const multer = require("multer");
const normalizeMulterError = require("../../src/middleware/normalizeMulterError");

describe("normalizeMulterError", () => {
  it("maps LIMIT_FILE_SIZE to 413", () => {
    const err = new multer.MulterError("LIMIT_FILE_SIZE");
    const next = vi.fn();

    normalizeMulterError(err, {}, {}, next);

    expect(err.status).toBe(413);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("maps another MulterError code to 400", () => {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE");
    const next = vi.fn();

    normalizeMulterError(err, {}, {}, next);

    expect(err.status).toBe(400);
    expect(next).toHaveBeenCalledWith(err);
  });

  it("passes through a non-Multer error untouched", () => {
    const err = new Error("something else");
    const next = vi.fn();

    normalizeMulterError(err, {}, {}, next);

    expect(err.status).toBeUndefined();
    expect(next).toHaveBeenCalledWith(err);
  });
});
