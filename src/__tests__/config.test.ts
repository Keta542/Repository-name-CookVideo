import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_ROOT,
  DEFAULT_EXECUTION_TARGET_NAME,
  listExecutionTargetNames,
  resolveDefaultClaudeCommand,
  resolveExecutionTarget,
} from "../config.js";

// Covers the Windows Claude CLI spawning fix: child_process.spawn (no shell: true) fails
// with `spawn claude ENOENT` on Windows because the installed CLI is a "claude.cmd" shim
// and spawn doesn't apply PATHEXT resolution the way cmd.exe does. This exercises the
// platform branch directly, as a pure function, rather than mocking process.platform or
// reloading the module.

test("resolveDefaultClaudeCommand selects claude.cmd on win32", () => {
  assert.equal(resolveDefaultClaudeCommand("win32"), "claude.cmd");
});

test("resolveDefaultClaudeCommand keeps the bare claude command on non-Windows platforms", () => {
  assert.equal(resolveDefaultClaudeCommand("darwin"), "claude");
  assert.equal(resolveDefaultClaudeCommand("linux"), "claude");
});

test("resolveDefaultClaudeCommand defaults to the current process's real platform when called with no argument", () => {
  const expected = process.platform === "win32" ? "claude.cmd" : "claude";
  assert.equal(resolveDefaultClaudeCommand(), expected);
});

// ---------------------------------------------------------------------------
// Milestone 4 -- approved execution targets
// ---------------------------------------------------------------------------

test("resolveExecutionTarget recognizes CookVideo as an approved target, pointed at the real CookVideo repository", () => {
  const target = resolveExecutionTarget("CookVideo");
  assert.ok(target !== null, "expected CookVideo to be a recognized target");
  assert.equal(target?.name, "CookVideo");
  assert.equal(target?.path, "C:\\Users\\aesfm\\CookVideo");
});

test("resolveExecutionTarget recognizes CookVideoAgent as the default target, pointed at this repository's own root", () => {
  assert.equal(DEFAULT_EXECUTION_TARGET_NAME, "CookVideoAgent");
  const target = resolveExecutionTarget("CookVideoAgent");
  assert.ok(target !== null, "expected CookVideoAgent to be a recognized target");
  assert.equal(target?.path, AGENT_ROOT);
});

test("resolveExecutionTarget rejects an unknown target name rather than guessing or falling back", () => {
  assert.equal(resolveExecutionTarget("SomeOtherRepo"), null);
  assert.equal(resolveExecutionTarget("C:\\Users\\aesfm"), null);
  assert.equal(resolveExecutionTarget(""), null);
});

test("listExecutionTargetNames lists exactly the two approved targets", () => {
  assert.deepEqual(listExecutionTargetNames(), ["CookVideoAgent", "CookVideo"]);
});
