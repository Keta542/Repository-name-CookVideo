import assert from "node:assert/strict";
import { test } from "node:test";
import { COOKVIDEO_REPO_PATH } from "../config.js";
import { runInspect } from "../commands/inspect.js";

// This is deliberately an integration test against the REAL, configured CookVideo
// repository (COOKVIDEO_REPO_PATH), not a mock -- its whole purpose is to prove the CLI
// can actually inspect the repository it's meant to coordinate against, per the milestone
// requirement. It is read-only: runInspect() never writes to the CookVideo repo.
test("runInspect finds the configured CookVideo repository", () => {
  const result = runInspect();

  assert.equal(
    result.repo.exists,
    true,
    `expected a directory at COOKVIDEO_REPO_PATH (${COOKVIDEO_REPO_PATH}) -- set the ` +
      "COOKVIDEO_REPO_PATH env var if the repo lives somewhere else in this environment"
  );
  assert.equal(result.repo.isDirectory, true);
});

test("runInspect reports real git state for the CookVideo repository", () => {
  const result = runInspect();

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
  const result = runInspect();

  assert.equal(result.repo.app.exists, true, `expected ${result.repo.app.relativePath} to exist`);
  assert.equal(result.repo.app.hasPackageJson, true);
  assert.equal(
    result.repo.app.hasNextDependency,
    true,
    "expected apps/web/package.json to declare a next dependency"
  );
});

test("runInspect reports this control plane's own .cookvideo state directory", () => {
  const result = runInspect();

  assert.equal(result.stateDir.exists, true);
  for (const [fileName, present] of Object.entries(result.stateDir.files)) {
    assert.equal(present, true, `expected .cookvideo/${fileName} to exist`);
  }
});
