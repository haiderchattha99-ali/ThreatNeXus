import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  UPLOAD_TEMP_DIR,
  isWithinUploadDir,
  safeUnlink,
  collectUploadPaths,
  cleanupRequestUploads,
} = require("../../src/lib/fileCleanup");

let sandbox;
let uploadDir;
let outsideDir;
let logger;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tn-cleanup-"));
  uploadDir = path.join(sandbox, "uploads");
  outsideDir = path.join(sandbox, "outside");
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  logger = { error: vi.fn() };
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeFile(dir, name, contents = "data") {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

describe("UPLOAD_TEMP_DIR", () => {
  it("is absolute and independent of the working directory", () => {
    expect(path.isAbsolute(UPLOAD_TEMP_DIR)).toBe(true);
    expect(UPLOAD_TEMP_DIR.endsWith(`${path.sep}uploads`)).toBe(true);
  });
});

describe("isWithinUploadDir", () => {
  it("accepts files directly inside the upload directory", () => {
    expect(isWithinUploadDir(path.join(uploadDir, "a.csv"), uploadDir)).toBe(true);
    expect(isWithinUploadDir(path.join(uploadDir, "nested", "a.csv"), uploadDir)).toBe(true);
  });

  it("rejects traversal out of the upload directory", () => {
    const traversals = [
      path.join(uploadDir, "..", "outside", "a.csv"),
      path.join(uploadDir, "..", "..", "etc", "passwd"),
      path.join(outsideDir, "a.csv"),
    ];

    traversals.forEach((candidate) => {
      expect(isWithinUploadDir(candidate, uploadDir)).toBe(false);
    });
  });

  it("rejects the upload directory itself", () => {
    expect(isWithinUploadDir(uploadDir, uploadDir)).toBe(false);
    expect(isWithinUploadDir(`${uploadDir}${path.sep}`, uploadDir)).toBe(false);
  });

  // "uploads-evil" must not pass a naive startsWith(uploadDir) check.
  it("rejects a sibling directory sharing the name prefix", () => {
    expect(isWithinUploadDir(`${uploadDir}-evil${path.sep}a.csv`, uploadDir)).toBe(false);
  });

  it("rejects empty and non-string input", () => {
    [undefined, null, "", "   ", 42, {}, []].forEach((value) => {
      expect(isWithinUploadDir(value, uploadDir)).toBe(false);
    });
  });
});

describe("safeUnlink", () => {
  it("deletes a file inside the upload directory", async () => {
    const filePath = makeFile(uploadDir, "upload.csv");

    await expect(safeUnlink(filePath, { uploadDir, logger })).resolves.toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("refuses to delete a file outside the upload directory", async () => {
    const outsideFile = makeFile(outsideDir, "important.txt");

    await expect(safeUnlink(outsideFile, { uploadDir, logger })).resolves.toBe(false);
    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it("refuses a traversal path even when the target exists", async () => {
    const outsideFile = makeFile(outsideDir, "important.txt");
    const traversal = path.join(uploadDir, "..", "outside", "important.txt");

    await expect(safeUnlink(traversal, { uploadDir, logger })).resolves.toBe(false);
    expect(fs.existsSync(outsideFile)).toBe(true);
  });

  it("refuses to remove a directory", async () => {
    const nested = path.join(uploadDir, "nested");
    fs.mkdirSync(nested);

    await expect(safeUnlink(nested, { uploadDir, logger })).resolves.toBe(false);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("returns false without throwing when the file is already gone", async () => {
    const missing = path.join(uploadDir, "not-there.csv");

    await expect(safeUnlink(missing, { uploadDir, logger })).resolves.toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("never throws on unexpected filesystem errors", async () => {
    const filePath = makeFile(uploadDir, "boom.csv");
    const spy = vi.spyOn(fs.promises, "unlink").mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" })
    );

    try {
      await expect(safeUnlink(filePath, { uploadDir, logger })).resolves.toBe(false);
      expect(logger.error).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("never writes a filesystem path into the log output", async () => {
    const outsideFile = makeFile(outsideDir, "secret-name.txt");
    await safeUnlink(outsideFile, { uploadDir, logger });

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain("secret-name");
    expect(logged).not.toContain(outsideDir);
  });
});

describe("collectUploadPaths", () => {
  it("collects a single multer file", () => {
    expect(collectUploadPaths({ file: { path: "/tmp/a.csv" } })).toEqual(["/tmp/a.csv"]);
  });

  it("collects array and field-map uploads", () => {
    expect(
      collectUploadPaths({ files: [{ path: "/tmp/a" }, { path: "/tmp/b" }] })
    ).toEqual(["/tmp/a", "/tmp/b"]);

    expect(
      collectUploadPaths({ files: { csv: [{ path: "/tmp/a" }], other: [{ path: "/tmp/b" }] } })
    ).toEqual(["/tmp/a", "/tmp/b"]);
  });

  it("returns nothing for a request with no upload", () => {
    expect(collectUploadPaths({})).toEqual([]);
    expect(collectUploadPaths(undefined)).toEqual([]);
    expect(collectUploadPaths({ file: {} })).toEqual([]);
  });
});

describe("cleanupRequestUploads", () => {
  it("removes every uploaded file on the request", async () => {
    const a = makeFile(uploadDir, "a.csv");
    const b = makeFile(uploadDir, "b.csv");

    const removed = await cleanupRequestUploads(
      { files: [{ path: a }, { path: b }] },
      { uploadDir, logger }
    );

    expect(removed).toBe(2);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
  });

  it("removes safe files and skips unsafe ones in the same request", async () => {
    const inside = makeFile(uploadDir, "inside.csv");
    const outside = makeFile(outsideDir, "outside.csv");

    const removed = await cleanupRequestUploads(
      { files: [{ path: inside }, { path: outside }] },
      { uploadDir, logger }
    );

    expect(removed).toBe(1);
    expect(fs.existsSync(inside)).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("is a no-op for a request with no upload", async () => {
    await expect(cleanupRequestUploads({}, { uploadDir, logger })).resolves.toBe(0);
  });
});
