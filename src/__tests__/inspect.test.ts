import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { COOKVIDEO_APP_RELATIVE_PATH, STATE_FILES } from "../config.js";
import { runInspect } from "../commands/inspect.js";

// This exercises runInspect() against a throwaway, self-contained fixture -- a real git
// repository shaped like CookVideo (an apps/web Next.js app) plus a real state directory
// containing every file STATE_FILES expects -- rather than the real, developer-machine-only
// C:\Users\aesfm\CookVideo checkout. That real checkout does not exist in CI (or on any
// machine other than the original developer's), and runInspect() has no way to fabricate it;
// this test only needs to prove runInspect() correctly reports on *a* real CookVideo-shaped
// repository, not that this specific machine happens to have the real one checked out. It is
// still a real integration test, not a mock: real git commands run against a real temporary
// repository on disk, and runInspect()'s own repo/app/state-dir checks are exercised exactly
// as they run for real, unmocked.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A throwaway repository shaped like CookVideo: a git repo with one commit, containing
// <repo>/apps/web/package.json declaring a "next" dependency -- exactly what
// checkCookVideoRepo()/getGitInfo() actually check for, so this fixture is a faithful stand-in
// for the real CookVideo repository rather than a shortcut around what's being tested.
function makeFixtureCookVideoRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-inspect-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  const appDir = path.join(dir, COOKVIDEO_APP_RELATIVE_PATH);
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "web", dependencies: { next: "14.0.0" } }, null, 2),
    "utf8"
  );

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
  return dir;
}

// A throwaway state directory containing every file STATE_FILES expects -- content doesn't
// matter to checkStateDir() (it only checks presence), so each is written empty.
function makeFixtureStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-inspect-state-"));
  for (const fileName of STATE_FILES) {
    fs.writeFileSync(path.join(dir, fileName), "", "utf8");
  }
  return dir;
}

function fixtureOptions() {
  return {
    repoPath: makeFixtureCookVideoRepo(),
    appRelativePath: COOKVIDEO_APP_RELATIVE_PATH,
    stateDirPath: makeFixtureStateDir(),
  };
}

test("runInspect finds the configured CookVideo repository", () => {
  const result = runInspect(fixtureOptions());

  assert.equal(result.repo.exists, true);
  assert.equal(result.repo.isDirectory, true);
});

test("runInspect reports real git state for the CookVideo repository", () => {
  const result = runInspect(fixtureOptions());

  assert.equal(result.git.isRepo, true, "expected CookVideo repository to be a git repo");
  assert.equal(result.git.error, undefined, `git command failed: ${result.git.error}`);
  assert.ok(result.git.branch && result.git.branch.length > 0, "expected a branch name");
  assert.ok(
    result.git.commit && /^[0-9a-f]{40}$/.test(result.git.commit),
    "expected a full 40-character commit SHA"
  );
  assert.equal(typeof result.git.isClean, "boolean");
});

test("runInspect finds the CookVideo Next.js app and confirms the Next.js dependency", () => {
  const result = runInspect(fixtureOptions());

  assert.equal(result.repo.app.exists, true, `expected ${result.repo.app.relativePath} to exist`);
  assert.equal(result.repo.app.hasPackageJson, true);
  assert.equal(
    result.repo.app.hasNextDependency,
    true,
    "expected apps/web/package.json to declare a next dependency"
  );
});

test("runInspect reports this control plane's own .cookvideo state directory", () => {
  const result = runInspect(fixtureOptions());

  assert.equal(result.stateDir.exists, true);
  for (const [fileName, present] of Object.entries(result.stateDir.files)) {
    assert.equal(present, true, `expected .cookvideo/${fileName} to exist`);
  }
});
