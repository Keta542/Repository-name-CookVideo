import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClaudeCommand,
  formatImplementationBrief,
  invokeClaude,
  type ImplementationBrief,
} from "../agents/claude.js";

// ---------------------------------------------------------------------------
// buildClaudeCommand -- pure command construction
// ---------------------------------------------------------------------------

test("buildClaudeCommand builds the command from configured pieces, verbatim", () => {
  const command = buildClaudeCommand({
    claudeCommand: "claude",
    briefFilePath: "/tmp/example/brief.md",
    cwd: "/tmp/example",
  });

  assert.deepEqual(command, {
    command: "claude",
    args: ["/tmp/example/brief.md"],
    cwd: "/tmp/example",
  });
});

test("buildClaudeCommand respects a configured non-default Claude command", () => {
  const command = buildClaudeCommand({
    claudeCommand: "C:\\tools\\claude-cli.exe",
    briefFilePath: "brief.md",
    cwd: "C:\\work",
  });

  assert.equal(command.command, "C:\\tools\\claude-cli.exe");
  assert.deepEqual(command.args, ["brief.md"]);
  assert.equal(command.cwd, "C:\\work");
});

// ---------------------------------------------------------------------------
// formatImplementationBrief
// ---------------------------------------------------------------------------

function sampleBrief(overrides: Partial<ImplementationBrief> = {}): ImplementationBrief {
  return {
    taskId: "T-001",
    objective: "Do the thing",
    scope: "src/",
    filesExpectedToChange: ["src/a.ts"],
    testsRequired: ["src/__tests__/a.test.ts"],
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    ...overrides,
  };
}

test("formatImplementationBrief includes every field's real value", () => {
  const rendered = formatImplementationBrief(sampleBrief());
  assert.match(rendered, /T-001/);
  assert.match(rendered, /Do the thing/);
  assert.match(rendered, /src\//);
  assert.match(rendered, /src\/a\.ts/);
  assert.match(rendered, /src\/__tests__\/a\.test\.ts/);
  assert.match(rendered, /LOW/);
  assert.match(rendered, /NOT_REQUIRED/);
});

test("formatImplementationBrief renders explicit placeholders for empty lists and unset risk", () => {
  const rendered = formatImplementationBrief(
    sampleBrief({ filesExpectedToChange: [], testsRequired: [], riskLevel: null }),
  );
  assert.match(rendered, /\(none listed\)/);
  assert.match(rendered, /\(not set\)/);
});

// ---------------------------------------------------------------------------
// invokeClaude -- real process invocation (never rejects, always resolves)
// ---------------------------------------------------------------------------

test("invokeClaude captures stdout, stderr and a zero exit code on success", async () => {
  const command = {
    command: process.execPath,
    args: ["-e", "console.log('hello-stdout'); console.error('hello-stderr');"],
    cwd: process.cwd(),
  };

  const result = await invokeClaude(command);

  assert.equal(result.spawnError, null);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello-stdout/);
  assert.match(result.stderr, /hello-stderr/);
  assert.equal(result.command, command);
  assert.ok(result.startedAt.length > 0);
  assert.ok(result.finishedAt.length > 0);
});

test("invokeClaude captures a non-zero exit code without throwing", async () => {
  const command = {
    command: process.execPath,
    args: ["-e", "process.exit(7);"],
    cwd: process.cwd(),
  };

  const result = await invokeClaude(command);

  assert.equal(result.spawnError, null);
  assert.equal(result.exitCode, 7);
});

test("invokeClaude reports spawnError instead of throwing when the command does not exist", async () => {
  const command = {
    command: "cookvideo-agent-definitely-not-a-real-executable-xyz",
    args: [],
    cwd: process.cwd(),
  };

  const result = await invokeClaude(command);

  assert.equal(result.exitCode, null);
  assert.ok(result.spawnError !== null, "expected a spawnError to be set");
});
