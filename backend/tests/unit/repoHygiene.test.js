import { describe, it, expect } from "vitest";

// Guards the repository hygiene fix: frontend/dist is a build output and is
// listed in .gitignore, but the files had been committed before that rule
// existed, so `npm run build` kept producing diffs in tracked files. Once
// untracked, this test keeps them that way — a re-add would otherwise pass
// unnoticed because .gitignore does not apply to already-tracked paths.

const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..", "..");

function gitLsFiles(pathspec) {
  return execFileSync("git", ["ls-files", "--", pathspec], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Skipped rather than failed outside a git checkout (e.g. an exported tarball
// or a CI image without git), so the suite stays runnable there.
function gitAvailable() {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const maybe = gitAvailable() ? describe : describe.skip;

maybe("repository hygiene", () => {
  it("tracks no files under frontend/dist", () => {
    expect(gitLsFiles("frontend/dist")).toEqual([]);
  });

  it("tracks no files under backend/node_modules or frontend/node_modules", () => {
    expect(gitLsFiles("backend/node_modules")).toEqual([]);
    expect(gitLsFiles("frontend/node_modules")).toEqual([]);
  });

  it("tracks no .env file", () => {
    const tracked = gitLsFiles("*.env").concat(gitLsFiles(".env"));
    expect(tracked).toEqual([]);
  });
});
