import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatActiveTaskMarkdown, prependBuildLogEntry } from "./plan.js";
import { applyTestOutcome, loadTaskState, saveTaskState, type TaskPhase, type TaskState } from "./taskState.js";
import type { TestMode } from "../config.js";

// ---------------------------------------------------------------------------
// Real CookVideo test suite runner (Milestone 13)
//
// This is the orchestration layer behind `cookvideo-agent test`, mirroring
// src/lib/gitWrite.ts's own split between a low-level step runner and the
// orchestration built on top of it. It is the only place in this control
// plane that independently verifies CookVideo's real test suite -- distinct
// from `EXECUTION_POLICY.md`'s "Tests may run" during LOCAL `execute` mode,
// which only means Claude *may choose to* run tests as part of its own work.
// This module never trusts that self-report.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test command resolution (never guessed)
// ---------------------------------------------------------------------------

export interface ResolvedTestCommand {
  ok: true;
  command: string;
  args: string[];
}

export interface UnresolvedTestCommand {
  ok: false;
  reason: string;
}

export type TestCommandResolution = ResolvedTestCommand | UnresolvedTestCommand;

// Reads CookVideo's own package.json and checks it actually declares a
// non-empty `scripts.test` entry -- ground truth, never assumed. This
// control plane must refuse before spawning anything if CookVideo has no
// test script, rather than blindly running `npm test` and letting npm's own
// "missing script" error stand in for a check this control plane should have
// made itself (the same "verify against ground truth, never guess"
// discipline validateExpectedTargets/validateGitWriteScope already
// established for the analogous questions in execution.ts/gitWrite.ts).
export function resolveCookVideoTestCommand(repoPath: string): TestCommandResolution {
  const packageJsonPath = path.join(repoPath, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return { ok: false, reason: `No package.json found at ${packageJsonPath}.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `CookVideo's package.json is not valid JSON: ${reason}` };
  }

  const scripts =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["scripts"]
      : undefined;
  const testScript =
    typeof scripts === "object" && scripts !== null && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)["test"]
      : undefined;

  if (typeof testScript !== "string" || testScript.trim().length === 0) {
    return {
      ok: false,
      reason: 'CookVideo\'s package.json does not declare a non-empty "scripts.test" entry.',
    };
  }

  // The command actually run is always `npm test` -- npm resolves and runs
  // scripts.test itself; this control plane's job above is only to confirm
  // that script exists before deciding to invoke npm at all, not to
  // reimplement npm's own script resolution.
  return { ok: true, command: "npm", args: ["test"] };
}

// ---------------------------------------------------------------------------
// Low-level test command runner
// ---------------------------------------------------------------------------

export interface TestStepResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

// On Windows, "npm" resolves to the npm.cmd shim, and node:child_process
// cannot exec a .cmd file directly without shell:true (the exact same
// documented Windows behavior resolveSpawnOptions/quoteForWindowsShell in
// src/agents/claude.ts already works around for "claude"/"claude.cmd").
// Every other platform runs the plain command/args unchanged.
function quoteForWindowsShell(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Runs the resolved command for real. Never throws -- mirrors
// src/lib/gitWrite.ts's runGitStep and src/agents/claude.ts's invokeClaude:
// every outcome (clean exit, non-zero exit, or a process that never started)
// is reported as data, not thrown.
export function runCookVideoTests(repoPath: string, resolved: ResolvedTestCommand): TestStepResult {
  const isWindows = process.platform === "win32";
  const spawnCommand = isWindows
    ? [resolved.command, ...resolved.args].map(quoteForWindowsShell).join(" ")
    : resolved.command;
  const spawnArgs = isWindows ? [] : resolved.args;

  const result = spawnSync(spawnCommand, spawnArgs, { cwd: repoPath, encoding: "utf8", shell: isWindows });
  if (result.error) {
    return { ok: false, exitCode: null, stdout: "", stderr: "", spawnError: result.error.message };
  }
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: null,
  };
}

// Output can be large; only a bounded tail is ever persisted to
// TASK_STATE.json's `result` field -- the full untruncated output still goes
// to TEST_LOG.json (see appendTestRecord below), never discarded. Default
// limit chosen per .cookvideo/MILESTONE_13_PROPOSAL.md's "Output volume"
// decision: generous enough to show a real failure's tail (stack trace,
// failing assertions) without risking an unbounded TASK_STATE.json.
export const RESULT_OUTPUT_LIMIT = 2000;

export function truncateForResult(output: string, limit: number = RESULT_OUTPUT_LIMIT): string {
  const trimmed = output.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `…(truncated, showing last ${String(limit)} of ${String(trimmed.length)} characters)…\n${trimmed.slice(-limit)}`;
}

function dryRunReason(executeFlag: boolean, testMode: TestMode): string {
  if (!executeFlag && testMode !== "local") {
    return 'the --execute flag was not passed and COOKVIDEO_AGENT_TEST_MODE is not "local"';
  }
  if (!executeFlag) {
    return "the --execute flag was not passed";
  }
  return `COOKVIDEO_AGENT_TEST_MODE is "${testMode}", not "local"`;
}

// ---------------------------------------------------------------------------
// Test log (append-only, mirrors EXECUTION_LOG.json/GIT_WRITE_LOG.json's
// exact pattern)
// ---------------------------------------------------------------------------

export interface TestRecord {
  timestamp: string;
  taskId: string | null;
  phaseBefore: TaskPhase;
  phaseAfter: TaskPhase;
  testMode: TestMode;
  executeFlagSet: boolean;
  dryRun: boolean;
  command: string[] | null;
  exitCode: number | null;
  outcome: string;
  ok: boolean;
  // Full, untruncated output -- unlike TASK_STATE.json's `result`, this
  // append-only log is the one place a complete record survives (see
  // truncateForResult above).
  stdout: string;
  stderr: string;
}

function readTestLog(logPath: string): TestRecord[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TestRecord[]) : [];
  } catch {
    // A corrupt or unreadable log should never block test reporting -- it's
    // a diagnostic trail, not the source of truth (TASK_STATE.json is).
    return [];
  }
}

export function appendTestRecord(logPath: string, record: TestRecord): void {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = readTestLog(logPath);
  existing.push(record);
  fs.writeFileSync(logPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Persisted lifecycle transitions
// ---------------------------------------------------------------------------

function testBuildLogEntry(state: TaskState, previousPhase: TaskPhase, ok: boolean): string {
  const lines: string[] = [
    `## ${new Date().toISOString().slice(0, 10)} — Real CookVideo test run via \`cookvideo-agent test\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Phase: ${previousPhase} -> ${state.phase}.`,
    `- Result: ${state.result ?? "(none)"}`,
    ok
      ? "- This was a real run of CookVideo's own test suite, gated by `--execute` and " +
          "COOKVIDEO_AGENT_TEST_MODE=local."
      : "- This real CookVideo test run failed -- see .cookvideo/TEST_LOG.json for the full detail.",
    "",
  ];
  return lines.join("\n");
}

function persistTestTransition(ctx: TestRunContext, from: TaskState, to: TaskState, ok: boolean): void {
  if (to === from) {
    return;
  }
  saveTaskState(ctx.taskStatePath, to);
  fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(to), "utf8");
  prependBuildLogEntry(ctx.buildLogPath, testBuildLogEntry(to, from.phase, ok));
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

export interface TestRunContext {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
  testLogPath: string;
  testMode: TestMode;
  executeFlag: boolean;
  // Always the resolved CookVideo execution target's path -- src/commands/
  // test.ts hardcodes target resolution to TEST_TARGET_NAME before this
  // context is ever built, so nothing in this module itself chooses or
  // validates which repository it's given.
  cwd: string;
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

export interface RunTestResult {
  ok: boolean;
  dryRun: boolean;
  state: TaskState;
  message: string;
  // The command that was (or, in dry-run, would be) run, e.g. ["npm",
  // "test"] -- null only when it could never be resolved (a pre-flight
  // refusal that never reached the repository, or CookVideo declares no
  // scripts.test entry).
  testCommand: string[] | null;
  // The real test process's exit code -- null for dry-run, a pre-flight
  // refusal, or a process that failed to start.
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function testRefusal(state: TaskState, message: string): RunTestResult {
  return { ok: false, dryRun: true, state, message, testCommand: null, exitCode: null, stdout: "", stderr: "" };
}

// The full test flow: load -> require phase TESTING -> resolve CookVideo's
// real test command -> decide, via the double gate (executeFlag AND
// testMode === "local"), whether to actually run it -> record what happened
// -> return a full report.
//
// Never throws. Every failure mode (no task, wrong phase, no resolvable test
// command, a spawn error, or a real non-zero exit) is represented in the
// returned RunTestResult so callers (src/commands/test.ts, and tests) can
// always render or assert on it directly.
export function runTest(ctx: TestRunContext): RunTestResult {
  const state = loadTaskState(ctx.taskStatePath);

  if (state.taskId === null) {
    return testRefusal(state, "No active task to test. Run `cookvideo-agent task` to check current state.");
  }
  if (state.phase !== "TESTING") {
    return testRefusal(
      state,
      `Task ${state.taskId} is in phase ${state.phase}. Running the CookVideo test suite requires phase ` +
        "TESTING (reached via `cookvideo-agent execute` or a manually recorded `cookvideo-agent advance`). " +
        "See .cookvideo/TEST_POLICY.md.",
    );
  }

  const wantsReal = ctx.executeFlag && ctx.testMode === "local";
  const dryRun = !wantsReal;
  const resolution = resolveCookVideoTestCommand(ctx.cwd);
  const testCommand: string[] | null = resolution.ok ? [resolution.command, ...resolution.args] : null;

  let ok = true;
  let message: string;
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  let currentState = state;

  if (dryRun) {
    // Read-only even in dry-run -- resolveCookVideoTestCommand only reads
    // CookVideo's package.json, so the preview reflects the real repository
    // rather than an assumption, without running anything.
    const reason = dryRunReason(ctx.executeFlag, ctx.testMode);
    if (!resolution.ok) {
      message =
        `DRY-RUN: no tests were run (${reason}). Note: real execution would currently refuse -- ` +
        `${resolution.reason}`;
    } else {
      message =
        `DRY-RUN: no tests were run because ${reason}. This is the safe default -- see ` +
        ".cookvideo/TEST_POLICY.md.";
    }
  } else if (!resolution.ok) {
    ok = false;
    message = `Refusing to run tests: ${resolution.reason}`;
  } else {
    const stepResult = runCookVideoTests(ctx.cwd, resolution);
    exitCode = stepResult.exitCode;
    stdout = stepResult.stdout;
    stderr = stepResult.stderr;
    if (stepResult.spawnError !== null) {
      ok = false;
      message = `Failed to start the CookVideo test command: ${stepResult.spawnError}`;
    } else if (!stepResult.ok) {
      ok = false;
      message = `CookVideo's test suite failed (exit code ${String(exitCode)}).`;
    } else {
      message = "CookVideo's test suite passed.";
    }
  }

  if (!dryRun) {
    const outputTail = truncateForResult(`${stdout}\n${stderr}`);
    const resultMessage = ok
      ? `Verified. CookVideo test command: ${testCommand?.join(" ") ?? "(unknown)"}.`
      : outputTail.length > 0
        ? `${message}\n\n${outputTail}`
        : message;
    const outcome = applyTestOutcome(currentState, ok, resultMessage);
    persistTestTransition(ctx, currentState, outcome.state, ok);
    currentState = outcome.state;
  }

  appendTestRecord(ctx.testLogPath, {
    timestamp: new Date().toISOString(),
    taskId: state.taskId,
    phaseBefore: state.phase,
    phaseAfter: currentState.phase,
    testMode: ctx.testMode,
    executeFlagSet: ctx.executeFlag,
    dryRun,
    command: testCommand,
    exitCode,
    outcome: message,
    ok,
    stdout,
    stderr,
  });

  return { ok, dryRun, state: currentState, message, testCommand, exitCode, stdout, stderr };
}
