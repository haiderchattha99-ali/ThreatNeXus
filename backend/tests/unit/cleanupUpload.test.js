import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const cleanupUpload = require("../../src/middleware/cleanupUpload");
const { UPLOAD_TEMP_DIR } = require("../../src/lib/fileCleanup");

// The middleware deliberately takes no directory override — it always guards
// the real upload directory. These tests therefore create uniquely named
// fixtures inside it and remove any survivors afterwards.
const created = [];
let sandbox;

beforeEach(() => {
  fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tn-mw-"));
  created.length = 0;
});

afterEach(() => {
  created.forEach((filePath) => {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  });
  fs.rmSync(sandbox, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeUploadFile(contents = "ip\n1.1.1.1\n") {
  const filePath = path.join(
    UPLOAD_TEMP_DIR,
    `test-cleanup-${crypto.randomBytes(8).toString("hex")}.csv`
  );
  fs.writeFileSync(filePath, contents);
  created.push(filePath);
  return filePath;
}

function makeRes() {
  return new EventEmitter();
}

// Cleanup is intentionally fire-and-forget, so tests wait for the filesystem
// to settle rather than awaiting the middleware.
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("cleanupUpload middleware", () => {
  it("calls next() immediately without waiting on cleanup", () => {
    const next = vi.fn();
    cleanupUpload({}, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("registers listeners for both finish and close", () => {
    const res = makeRes();
    cleanupUpload({}, res, vi.fn());

    expect(res.listenerCount("finish")).toBe(1);
    expect(res.listenerCount("close")).toBe(1);
  });

  it("deletes the uploaded temp file once the response finishes", async () => {
    const filePath = makeUploadFile();
    const res = makeRes();
    cleanupUpload({ file: { path: filePath } }, res, vi.fn());

    expect(fs.existsSync(filePath)).toBe(true);
    res.emit("finish");

    expect(await waitFor(() => !fs.existsSync(filePath))).toBe(true);
  });

  it("deletes the uploaded temp file when the connection closes instead", async () => {
    const filePath = makeUploadFile();
    const res = makeRes();
    cleanupUpload({ file: { path: filePath } }, res, vi.fn());
    res.emit("close");

    expect(await waitFor(() => !fs.existsSync(filePath))).toBe(true);
  });

  it("runs cleanup only once when finish and close both fire", async () => {
    const filePath = makeUploadFile();
    const unlinkSpy = vi.spyOn(fs.promises, "unlink");
    const res = makeRes();
    cleanupUpload({ file: { path: filePath } }, res, vi.fn());

    res.emit("finish");
    res.emit("close");
    res.emit("finish");

    try {
      expect(await waitFor(() => !fs.existsSync(filePath))).toBe(true);
      expect(unlinkSpy).toHaveBeenCalledTimes(1);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("cleans up every file of a multi-file upload", async () => {
    const a = makeUploadFile();
    const b = makeUploadFile();
    const res = makeRes();
    cleanupUpload({ files: [{ path: a }, { path: b }] }, res, vi.fn());
    res.emit("finish");

    expect(await waitFor(() => !fs.existsSync(a) && !fs.existsSync(b))).toBe(true);
  });

  it("does not throw when there is no uploaded file", () => {
    const res = makeRes();
    expect(() => {
      cleanupUpload({}, res, vi.fn());
      res.emit("finish");
    }).not.toThrow();
  });

  // A cleanup failure happens after the response was sent, so it must stay
  // contained rather than becoming an unhandled rejection.
  it("swallows cleanup failures without an unhandled rejection", async () => {
    const filePath = makeUploadFile();
    const unlinkSpy = vi
      .spyOn(fs.promises, "unlink")
      .mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    try {
      const res = makeRes();
      cleanupUpload({ file: { path: filePath } }, res, vi.fn());
      res.emit("finish");

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toHaveLength(0);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", onRejection);
      unlinkSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("refuses to delete a file outside the upload directory", async () => {
    const outsideFile = path.join(sandbox, "important.txt");
    fs.writeFileSync(outsideFile, "keep me");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = makeRes();
      cleanupUpload({ file: { path: outsideFile } }, res, vi.fn());
      res.emit("finish");

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(outsideFile)).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("refuses a traversal path that escapes the upload directory", async () => {
    const outsideFile = path.join(sandbox, "traversal-target.txt");
    fs.writeFileSync(outsideFile, "keep me");
    const traversal = path.join(UPLOAD_TEMP_DIR, "..", "..", path.relative(
      path.resolve(UPLOAD_TEMP_DIR, "..", ".."),
      outsideFile
    ));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = makeRes();
      cleanupUpload({ file: { path: traversal } }, res, vi.fn());
      res.emit("finish");

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(outsideFile)).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
