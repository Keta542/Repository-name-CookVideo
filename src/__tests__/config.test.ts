import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDefaultClaudeCommand } from "../config.js";

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
