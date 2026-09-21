import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.join(import.meta.dir, "../scripts/ci-tag-and-dispatch-npm.sh");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  }
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-release-gate-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["commit", "--allow-empty", "-m", "docs: base"]);
  return dir;
}

function shouldRelease(dir: string): string {
  const result = spawnSync("bash", [SCRIPT, "--should-release"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`--should-release failed: ${result.stderr}${result.stdout}`);
  }
  return result.stdout.trim();
}

describe("npm release commit gate", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("skips ordinary commits", () => {
    dir = initRepo();
    expect(shouldRelease(dir)).toBe("no");
  });

  it("accepts a Version Packages commit, including a squash suffix", () => {
    dir = initRepo();
    git(dir, ["commit", "--allow-empty", "-m", "chore: version packages"]);
    expect(shouldRelease(dir)).toBe("yes");
    git(dir, ["commit", "--allow-empty", "-m", "chore: version packages (#17)"]);
    expect(shouldRelease(dir)).toBe("yes");
  });

  it("accepts a merge whose second parent is Version Packages", () => {
    dir = initRepo();
    git(dir, ["checkout", "-b", "changeset-release/main"]);
    git(dir, ["commit", "--allow-empty", "-m", "chore: version packages"]);
    git(dir, ["checkout", "main"]);
    git(dir, [
      "merge",
      "--no-ff",
      "-m",
      "Merge pull request #17 from org/changeset-release/main",
      "changeset-release/main",
    ]);
    expect(shouldRelease(dir)).toBe("yes");
  });

  it("skips a merge of an unrelated branch", () => {
    dir = initRepo();
    git(dir, ["checkout", "-b", "feature"]);
    git(dir, ["commit", "--allow-empty", "-m", "feat: bump by hand"]);
    git(dir, ["checkout", "main"]);
    git(dir, ["merge", "--no-ff", "-m", "Merge pull request #9 from org/feature", "feature"]);
    expect(shouldRelease(dir)).toBe("no");
  });
});
