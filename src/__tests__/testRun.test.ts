import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseTestMode } from "../config.js";
import {
  RESULT_OUTPUT_LIMIT,
  appendTestRecord,
  resolveCookVideoTestCommand,
  runCookVideoTests,
  runTest,
  truncateForResult,
  type ResolvedTestCommand,
  type TestRecord,
  type TestRunContext,
} from "../lib/testRun.js";
import { EMPTY_TASK_STATE, loadTaskState, saveTaskState, type TaskState } from "../lib/taskState.js";

// All real process execution here runs against throwaway npm projects
// created fresh under the OS temp directory for each test -- never the real
// CookVideo repository or this control plane's own repository. This is the
// only module in this project that ever runs a real `npm test`, so these
// tests deliberately exercise a real spawned process, not a mock.

// ---------------------------------------------------------------------------
// resolveCookVideoTestCommand
// ---------------------------------------------------------------------------

function npmProject(scripts: Record<string, string> | undefined): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-testrun-project-"));
  const pkg: Record<string, unknown> = { name: "temp-cookvideo", version: "1.0.0" };
  if (scripts !== undefined) {
    pkg["scripts"] = scripts;
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  return dir;
}

test("resolveCookVideoTestCommand refuses when there is no package.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-testrun-nopkg-"));
  const result = resolveCookVideoTestCommand(dir);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /No package\.json found/);
});

test("resolveCookVideoTestCommand refuses when package.json is not valid JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-testrun-badjson-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{ not valid json", "utf8");
  const result = resolveCookVideoTestCommand(dir);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /not valid JSON/);
});

test("resolveCookVideoTestCommand refuses when scripts.test is absent", () => {
  const dir = npmProject({ build: "tsc" });
  const result = resolveCookVideoTestCommand(dir);
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /does not declare a non-empty "scripts\.test"/);
});

test("resolveCookVideoTestCommand refuses when scripts.test is an empty string", () => {
  const dir = npmProject({ test: "   " });
  const result = resolveCookVideoTestCommand(dir);
  assert.equal(result.ok, false);
});

test("resolveCookVideoTestCommand refuses when package.json has no scripts object at all", () => {
  const dir = npmProject(undefined);
  const result = resolveCookVideoTestCommand(dir);
  assert.equal(result.ok, false);
});

test("resolveCookVideoTestCommand resolves to npm test when scripts.test is present", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const result = resolveCookVideoTestCommand(dir);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.command, "npm");
  assert.deepEqual(result.ok ? result.args : [], ["test"]);
});

// ---------------------------------------------------------------------------
// runCookVideoTests -- real process execution
// ---------------------------------------------------------------------------

test("runCookVideoTests reports a real passing test script as ok with exit code 0", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const resolved: ResolvedTestCommand = { ok: true, command: "npm", args: ["test"] };
  const result = runCookVideoTests(dir, resolved);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.spawnError, null);
});

test("runCookVideoTests reports a real failing test script as not ok with a non-zero exit code", () => {
  const dir = npmProject({ test: 'node -e "process.exit(1)"' });
  const resolved: ResolvedTestCommand = { ok: true, command: "npm", args: ["test"] };
  const result = runCookVideoTests(dir, resolved);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.spawnError, null);
});

test("runCookVideoTests never throws when the command itself cannot be spawned", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const resolved: ResolvedTestCommand = { ok: true, command: "cookvideo-agent-definitely-not-a-real-binary", args: [] };
  const result = runCookVideoTests(dir, resolved);
  // On POSIX, spawnSync itself fails to start the process (ENOENT via
  // result.error). On Windows, the command runs through a shell (shell:
  // true -- see quoteForWindowsShell in src/lib/testRun.ts), so cmd.exe
  // itself starts fine and instead reports "not recognized" via a non-zero
  // exit code, never result.error. Either way this must never throw, and
  // must always be reported as a non-ok outcome.
  assert.equal(result.ok, false);
  if (result.spawnError !== null) {
    assert.equal(result.exitCode, null);
  } else {
    assert.notEqual(result.exitCode, 0);
  }
});

// ---------------------------------------------------------------------------
// truncateForResult
// ---------------------------------------------------------------------------

test("truncateForResult returns short output unchanged (trimmed)", () => {
  assert.equal(truncateForResult("  all good  "), "all good");
});

test("truncateForResult bounds long output to the tail and reports the original length", () => {
  const output = "x".repeat(3000);
  const truncated = truncateForResult(output);
  assert.match(truncated, /truncated, showing last 2000 of 3000 characters/);
  assert.ok(truncated.endsWith("x".repeat(RESULT_OUTPUT_LIMIT)));
});

test("truncateForResult respects a custom limit", () => {
  const output = "y".repeat(50);
  const truncated = truncateForResult(output, 10);
  assert.match(truncated, /showing last 10 of 50 characters/);
  assert.ok(truncated.endsWith("y".repeat(10)));
});

// ---------------------------------------------------------------------------
// test log
// ---------------------------------------------------------------------------

test("appendTestRecord creates the log file on first use and appends on subsequent calls", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-testlog-"));
  const logPath = path.join(dir, "TEST_LOG.json");

  const record = (n: number): TestRecord => ({
    timestamp: `2026-01-0${n}T00:00:00.000Z`,
    taskId: "T-001",
    phaseBefore: "TESTING",
    phaseAfter: "REVIEW",
    testMode: "dry-run",
    executeFlagSet: false,
    dryRun: true,
    command: ["npm", "test"],
    exitCode: null,
    outcome: `attempt ${n}`,
    ok: true,
    stdout: "",
    stderr: "",
  });

  appendTestRecord(logPath, record(1));
  appendTestRecord(logPath, record(2));

  const raw = JSON.parse(fs.readFileSync(logPath, "utf8")) as TestRecord[];
  assert.equal(raw.length, 2);
  assert.equal(raw[0]?.outcome, "attempt 1");
  assert.equal(raw[1]?.outcome, "attempt 2");
});

// ---------------------------------------------------------------------------
// runTest -- full flow
// ---------------------------------------------------------------------------

function tempStateFiles(): {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
  testLogPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-testrun-state-"));
  return {
    taskStatePath: path.join(dir, "TASK_STATE.json"),
    activeTaskPath: path.join(dir, "ACTIVE_TASK.md"),
    buildLogPath: path.join(dir, "BUILD_LOG.md"),
    testLogPath: path.join(dir, "TEST_LOG.json"),
  };
}

function baseCtx(cwd: string, overrides: Partial<TestRunContext> = {}): TestRunContext {
  const ws = tempStateFiles();
  return {
    taskStatePath: ws.taskStatePath,
    activeTaskPath: ws.activeTaskPath,
    buildLogPath: ws.buildLogPath,
    testLogPath: ws.testLogPath,
    testMode: "dry-run",
    executeFlag: false,
    cwd,
    ...overrides,
  };
}

function testingTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "TESTRUN-001",
    objective: "Fix the empty-state copy.",
    scope: "src/",
    phase: "TESTING",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("runTest refuses when there is no active task", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const result = runTest(baseCtx(dir));
  assert.equal(result.ok, false);
  assert.equal(result.dryRun, true);
  assert.match(result.message, /No active task/);
});

test("runTest refuses a task that is not phase TESTING", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, testingTask({ phase: "PLANNED" }));

  const result = runTest(ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /requires phase TESTING/);
  assert.ok(!fs.existsSync(ctx.activeTaskPath));
});

test("runTest dry-run previews the resolved command without running anything or touching state", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.testCommand, ["npm", "test"]);
  assert.equal(result.exitCode, null);
  assert.match(result.message, /DRY-RUN/);
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "TESTING", "dry-run must not persist a phase change");
  assert.ok(!fs.existsSync(ctx.activeTaskPath), "dry-run must never write ACTIVE_TASK.md");
});

test("runTest dry-run flags an in-preview missing scripts.test without refusing the dry-run itself", () => {
  const dir = npmProject({ build: "tsc" });
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.dryRun, true);
  assert.match(result.message, /would currently refuse/);
});

test("runTest never runs real tests when executeFlag is true but testMode is dry-run", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const ctx = baseCtx(dir, { executeFlag: true, testMode: "dry-run" });
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.dryRun, true);
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "TESTING");
});

test("runTest never runs real tests when testMode is local but --execute was not passed", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const ctx = baseCtx(dir, { executeFlag: false, testMode: "local" });
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.dryRun, true);
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "TESTING");
});

test("runTest real execution: a genuine pass moves TESTING -> REVIEW and records the command", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const ctx = baseCtx(dir, { executeFlag: true, testMode: "local" });
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state.phase, "REVIEW");
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "REVIEW");
  assert.match(loadTaskState(ctx.taskStatePath).result ?? "", /npm test/);

  const activeTask = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTask, /\| Phase \| REVIEW \|/);
  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Real CookVideo test run via `cookvideo-agent test`/);
});

test("runTest real execution: a genuine failure moves TESTING -> FAILED and preserves a truncated output tail", () => {
  const dir = npmProject({ test: 'node -e "console.error(\'boom\'); process.exit(1)"' });
  const ctx = baseCtx(dir, { executeFlag: true, testMode: "local" });
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.dryRun, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.state.phase, "FAILED");
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "FAILED");
  assert.match(loadTaskState(ctx.taskStatePath).result ?? "", /boom/);
});

test("runTest real execution: refuses (-> FAILED) when CookVideo has no resolvable scripts.test", () => {
  const dir = npmProject({ build: "tsc" });
  const ctx = baseCtx(dir, { executeFlag: true, testMode: "local" });
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.state.phase, "FAILED");
  assert.match(result.message, /does not declare a non-empty "scripts\.test"/);
});

test("runTest appends exactly one TEST_LOG.json record per attempt, dry-run or real", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, testingTask());

  runTest(ctx);
  const localCtx = { ...ctx, executeFlag: true, testMode: "local" as const };
  runTest(localCtx);

  const raw = JSON.parse(fs.readFileSync(ctx.testLogPath, "utf8")) as TestRecord[];
  assert.equal(raw.length, 2);
  assert.equal(raw[0]?.dryRun, true);
  assert.equal(raw[1]?.dryRun, false);
  assert.equal(raw[1]?.ok, true);
});

test("runTest recovers a FAILED task back to TESTING and passes on retry", () => {
  const dir = npmProject({ test: 'node -e "process.exit(0)"' });
  const ctx = baseCtx(dir, { executeFlag: true, testMode: "local" });
  saveTaskState(ctx.taskStatePath, testingTask({ phase: "FAILED", result: "previous attempt failed" }));

  // FAILED can't go straight back to REVIEW -- simulate the recovery a
  // human/planner would perform (back to TESTING) before retrying.
  saveTaskState(ctx.taskStatePath, testingTask());

  const result = runTest(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "REVIEW");
});

// ---------------------------------------------------------------------------
// COOKVIDEO_AGENT_TEST_MODE parsing
// ---------------------------------------------------------------------------

test("parseTestMode accepts the two documented values", () => {
  assert.equal(parseTestMode("dry-run"), "dry-run");
  assert.equal(parseTestMode("local"), "local");
});

test("parseTestMode fails safe to dry-run for anything else", () => {
  assert.equal(parseTestMode(undefined), "dry-run");
  assert.equal(parseTestMode(""), "dry-run");
  assert.equal(parseTestMode("LOCAL"), "dry-run");
  assert.equal(parseTestMode("production"), "dry-run");
});
