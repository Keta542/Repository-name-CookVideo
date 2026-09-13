import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClaudeCommand,
  formatImplementationBrief,
  invokeClaude,
  resolveSpawnOptions,
  type ImplementationBrief,
} from "../agents/claude.js";

// ---------------------------------------------------------------------------
// buildClaudeCommand -- pure command construction
// ---------------------------------------------------------------------------

test("buildClaudeCommand builds the command from configured pieces, verbatim", () => {
  const command = buildClaudeCommand({
    claudeCommand: "claude",
    briefContent: "# Implementation brief: T-001\n\nDo the thing.\n",
    cwd: "/tmp/example",
  });

  assert.deepEqual(command, {
    command: "claude",
    args: ["-p", "--permission-mode", "acceptEdits"],
    cwd: "/tmp/example",
    input: "# Implementation brief: T-001\n\nDo the thing.\n",
  });
});

test("buildClaudeCommand respects a configured non-default Claude command", () => {
  const command = buildClaudeCommand({
    claudeCommand: "C:\\tools\\claude-cli.exe",
    briefContent: "brief contents",
    cwd: "C:\\work",
  });

  assert.equal(command.command, "C:\\tools\\claude-cli.exe");
  assert.deepEqual(command.args, ["-p", "--permission-mode", "acceptEdits"]);
  assert.equal(command.cwd, "C:\\work");
  assert.equal(command.input, "brief contents");
});

// ---------------------------------------------------------------------------
// buildClaudeCommand -- the actual brief content reaches Claude, not just a
// path to it. This is the regression test for the bug this change fixes:
// Claude was previously handed only the brief's file path as its sole
// argument, which it had no instruction to open, so it ran with no real
// input and exited 0 having done nothing.
// ---------------------------------------------------------------------------

test("buildClaudeCommand passes the implementation brief's real contents to Claude, not merely its file path", () => {
  const brief: ImplementationBrief = {
    taskId: "MILESTONE-6-SEARCH-EMPTY-STATE-001",
    objective: "Add an empty-state message to the search results component.",
    scope: "apps/web/components/search/",
    filesExpectedToChange: ["apps/web/components/search/SearchResults.tsx"],
    testsRequired: ["apps/web/components/search/__tests__/SearchResults.test.tsx"],
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
  };
  const briefContent = formatImplementationBrief(brief);

  const command = buildClaudeCommand({
    claudeCommand: "claude",
    briefContent,
    cwd: "/tmp/example",
  });

  // The brief's actual instructions -- not just a path -- must reach Claude,
  // via stdin (input) rather than argv: a free-text objective/scope can
  // contain shell metacharacters (&, |, <, >, ^) that cmd.exe would corrupt
  // even inside a quoted argv value on Windows (see the
  // ClaudeExecutionCommand.input doc comment).
  assert.match(command.input, /Add an empty-state message to the search results component/);
  assert.match(command.input, /SearchResults\.tsx/);
  assert.ok(
    !command.args.some((arg) => /\.md$/.test(arg)),
    "expected no bare .md file path among the args -- Claude must receive the brief's contents, not a path to it",
  );
  assert.ok(
    !command.args.join(" ").includes(briefContent),
    "expected the brief content to travel via stdin (input), not argv",
  );
  // Claude Code's own CLI documents `-p`/`--print` as its non-interactive
  // mode ("useful for pipes"); without it the process runs interactively
  // against a closed stdin and exits having done nothing (see
  // resolveSpawnOptions/invokeClaude).
  assert.ok(command.args.includes("-p"), "expected the -p/--print non-interactive flag to be present");
  // Without an explicit permission mode, Claude Code's default prompts
  // interactively for every file edit -- with stdin/stdout piped rather than
  // a TTY (see resolveSpawnOptions), there's no terminal to prompt at, so
  // edits would hang or be rejected. acceptEdits is the documented
  // non-interactive mode that allows normal file edits without also
  // lifting every other permission gate (contrast bypassPermissions).
  assert.ok(
    command.args.includes("--permission-mode") && command.args.includes("acceptEdits"),
    "expected --permission-mode acceptEdits to be present",
  );
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
// resolveSpawnOptions -- Windows requires shell: true to run .bat/.cmd files
// (spawn EINVAL otherwise); every other platform keeps shell: false.
// ---------------------------------------------------------------------------

test("resolveSpawnOptions enables shell on win32", () => {
  const options = resolveSpawnOptions("C:\\work", "win32");
  assert.deepEqual(options, {
    cwd: "C:\\work",
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
  });
});

test("resolveSpawnOptions disables shell on non-Windows platforms", () => {
  assert.equal(resolveSpawnOptions("/work", "darwin").shell, false);
  assert.equal(resolveSpawnOptions("/work", "linux").shell, false);
});

test("resolveSpawnOptions preserves the given cwd and pipes stdin/stdout/stderr regardless of platform", () => {
  const options = resolveSpawnOptions("/some/cwd", "linux");
  assert.equal(options.cwd, "/some/cwd");
  // stdin must be piped (not ignored) so invokeClaude can write the
  // implementation brief's contents to it -- see ClaudeExecutionCommand.input.
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
});

test("resolveSpawnOptions defaults to the current process's real platform when called with no platform argument", () => {
  const options = resolveSpawnOptions("/some/cwd");
  assert.equal(options.shell, process.platform === "win32");
});

// ---------------------------------------------------------------------------
// invokeClaude -- real process invocation (never rejects, always resolves)
// ---------------------------------------------------------------------------

test("invokeClaude captures stdout, stderr and a zero exit code on success", async () => {
  const command = {
    command: process.execPath,
    args: ["-e", "console.log('hello-stdout'); console.error('hello-stderr');"],
    cwd: process.cwd(),
    input: "",
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
    input: "",
  };

  const result = await invokeClaude(command);

  assert.equal(result.spawnError, null);
  assert.equal(result.exitCode, 7);
});

test("invokeClaude reports failure instead of throwing when the command does not exist", async () => {
  const command = {
    command: "cookvideo-agent-definitely-not-a-real-executable-xyz",
    args: [],
    cwd: process.cwd(),
    input: "",
  };

  const result = await invokeClaude(command);

  // On platforms where invocation goes through a shell (Windows -- see
  // resolveSpawnOptions, needed to run .cmd shims), a nonexistent command
  // doesn't fail spawn() itself: cmd.exe starts successfully and reports
  // "not recognized" via its own non-zero exit code, so Node's
  // ENOENT/spawnError path is never triggered. Elsewhere, spawn itself
  // fails and reports spawnError with a null exit code. Either shape must
  // be surfaced as data, never thrown -- this test accepts both rather than
  // assuming one platform's behavior.
  if (result.spawnError !== null) {
    assert.equal(result.exitCode, null);
  } else {
    assert.notEqual(result.exitCode, 0);
  }
});

// ---------------------------------------------------------------------------
// invokeClaude -- the brief's contents (command.input) are actually written
// to the child process's stdin, not silently dropped.
// ---------------------------------------------------------------------------

test("invokeClaude writes command.input to the child process's stdin", async () => {
  const command = {
    command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout);"],
    cwd: process.cwd(),
    input: "the implementation brief's real contents\n",
  };

  const result = await invokeClaude(command);

  assert.equal(result.spawnError, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "the implementation brief's real contents\n");
});
