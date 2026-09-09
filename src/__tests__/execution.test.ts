import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseExecutionMode } from "../config.js";
import type { ClaudeExecutionCommand, ClaudeExecutionResult } from "../agents/claude.js";
import {
  appendExecutionRecord,
  buildImplementationBrief,
  checkApprovalForExecution,
  runExecution,
  validateExecutionTransition,
  validateTaskExists,
  type ExecuteContext,
  type ExecutionRecord,
} from "../lib/execution.js";
import { EMPTY_TASK_STATE, saveTaskState } from "../lib/taskState.js";
import { harmlessTask } from "./fixtures/harmlessTask.js";

// All tests here use a fresh temp directory per test -- never the real
// .cookvideo/ directory or the real CookVideo repository -- so running the
// suite can never touch real task state, write a real execution log, or
// (most importantly) spawn a real process against the developer's machine.
function tempWorkspace(): { taskStatePath: string; executionLogPath: string; briefsDir: string; cwd: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-execution-"));
  return {
    taskStatePath: path.join(dir, "TASK_STATE.json"),
    executionLogPath: path.join(dir, "EXECUTION_LOG.json"),
    briefsDir: path.join(dir, "briefs"),
    cwd: dir,
  };
}

function neverCalledInvoke(): (command: ClaudeExecutionCommand) => Promise<ClaudeExecutionResult> {
  return () => {
    throw new Error("invoke must never be called in this scenario");
  };
}

function spyInvoke(result: ClaudeExecutionResult): {
  invoke: (command: ClaudeExecutionCommand) => Promise<ClaudeExecutionResult>;
  calls: ClaudeExecutionCommand[];
} {
  const calls: ClaudeExecutionCommand[] = [];
  return {
    calls,
    invoke: async (command: ClaudeExecutionCommand) => {
      calls.push(command);
      return result;
    },
  };
}

function baseContext(ws: ReturnType<typeof tempWorkspace>, overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    taskStatePath: ws.taskStatePath,
    executionLogPath: ws.executionLogPath,
    briefsDir: ws.briefsDir,
    claudeCommand: "claude",
    executionMode: "dry-run",
    executeFlag: false,
    cwd: ws.cwd,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// execution-mode validation
// ---------------------------------------------------------------------------

test("parseExecutionMode accepts the two documented values", () => {
  assert.equal(parseExecutionMode("dry-run"), "dry-run");
  assert.equal(parseExecutionMode("local"), "local");
});

test("parseExecutionMode fails safe to dry-run for anything else", () => {
  assert.equal(parseExecutionMode(undefined), "dry-run");
  assert.equal(parseExecutionMode(""), "dry-run");
  assert.equal(parseExecutionMode("LOCAL"), "dry-run");
  assert.equal(parseExecutionMode("Dry-Run"), "dry-run");
  assert.equal(parseExecutionMode("production"), "dry-run");
  assert.equal(parseExecutionMode("local "), "dry-run");
});

// ---------------------------------------------------------------------------
// task validation / missing task handling
// ---------------------------------------------------------------------------

test("validateTaskExists refuses when there is no taskId", () => {
  const result = validateTaskExists(EMPTY_TASK_STATE);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /No active task/);
});

test("validateTaskExists accepts a task with a taskId", () => {
  const result = validateTaskExists(harmlessTask());
  assert.equal(result.ok, true);
});

test("runExecution handles a completely missing TASK_STATE.json file as 'no active task', not a crash", async () => {
  const ws = tempWorkspace(); // taskStatePath never written
  const result = await runExecution(baseContext(ws, { invoke: neverCalledInvoke() }));

  assert.equal(result.ok, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.brief, null);
  assert.match(result.message, /No active task/);
});

// ---------------------------------------------------------------------------
// lifecycle transition validation
// ---------------------------------------------------------------------------

test("validateExecutionTransition allows a task already IMPLEMENTING", () => {
  assert.equal(validateExecutionTransition(harmlessTask({ phase: "IMPLEMENTING" })).ok, true);
});

test("validateExecutionTransition allows a task in PLANNED (can move to IMPLEMENTING)", () => {
  assert.equal(validateExecutionTransition(harmlessTask({ phase: "PLANNED" })).ok, true);
});

test("validateExecutionTransition allows recovery from FAILED", () => {
  assert.equal(validateExecutionTransition(harmlessTask({ phase: "FAILED" })).ok, true);
});

test("validateExecutionTransition refuses a task already past implementation (e.g. REVIEW)", () => {
  const result = validateExecutionTransition(harmlessTask({ phase: "REVIEW" }));
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /cannot move to IMPLEMENTING/);
});

test("validateExecutionTransition refuses a terminal phase (COMPLETED)", () => {
  assert.equal(validateExecutionTransition(harmlessTask({ phase: "COMPLETED" })).ok, false);
});

test("runExecution refuses a task in a non-executable phase without invoking anything", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask({ phase: "REVIEW" }));

  const result = await runExecution(baseContext(ws, { invoke: neverCalledInvoke() }));

  assert.equal(result.ok, false);
  assert.match(result.message, /cannot move to IMPLEMENTING/);
});

// ---------------------------------------------------------------------------
// approval-gate enforcement
// ---------------------------------------------------------------------------

test("checkApprovalForExecution refuses a REJECTED task", () => {
  const result = checkApprovalForExecution(harmlessTask({ approvalStatus: "REJECTED" }));
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /REJECTED/);
});

test("checkApprovalForExecution allows NOT_REQUIRED, PENDING and APPROVED", () => {
  for (const status of ["NOT_REQUIRED", "PENDING", "APPROVED"] as const) {
    assert.equal(checkApprovalForExecution(harmlessTask({ approvalStatus: status })).ok, true, status);
  }
});

test("runExecution refuses a REJECTED task without invoking anything", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask({ approvalStatus: "REJECTED" }));

  const result = await runExecution(baseContext(ws, { invoke: neverCalledInvoke() }));

  assert.equal(result.ok, false);
  assert.match(result.message, /REJECTED/);
});

// ---------------------------------------------------------------------------
// implementation brief
// ---------------------------------------------------------------------------

test("buildImplementationBrief carries over the task's recorded fields verbatim", () => {
  const task = harmlessTask();
  const brief = buildImplementationBrief(task);

  assert.equal(brief.taskId, task.taskId);
  assert.equal(brief.objective, task.objective);
  assert.equal(brief.scope, task.scope);
  assert.deepEqual(brief.filesExpectedToChange, task.filesExpectedToChange);
  assert.deepEqual(brief.testsRequired, task.testsRequired);
  assert.equal(brief.riskLevel, task.riskLevel);
  assert.equal(brief.approvalStatus, task.approvalStatus);
});

test("buildImplementationBrief never invents an objective or scope that wasn't recorded", () => {
  const brief = buildImplementationBrief(harmlessTask({ objective: null, scope: null }));
  assert.match(brief.objective, /not set/);
  assert.match(brief.scope, /not set/);
});

// ---------------------------------------------------------------------------
// dry-run never executes a process
// ---------------------------------------------------------------------------

test("runExecution never invokes a process when executionMode is dry-run, even if --execute was passed", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  const result = await runExecution(
    baseContext(ws, { executionMode: "dry-run", executeFlag: true, invoke: neverCalledInvoke() }),
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.result, null);
  assert.match(result.message, /DRY-RUN/);
});

test("runExecution never invokes a process when --execute was not passed, even if executionMode is local", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  const result = await runExecution(
    baseContext(ws, { executionMode: "local", executeFlag: false, invoke: neverCalledInvoke() }),
  );

  assert.equal(result.dryRun, true);
  assert.equal(result.result, null);
});

test("runExecution still writes the implementation brief and constructs the command in dry-run mode", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  const result = await runExecution(baseContext(ws, { invoke: neverCalledInvoke() }));

  assert.equal(result.dryRun, true);
  assert.ok(result.brief !== null);
  assert.ok(result.briefFilePath !== null);
  assert.ok(fs.existsSync(result.briefFilePath!), "expected the brief file to be written to disk");
  assert.ok(result.command !== null);
});

// ---------------------------------------------------------------------------
// command construction
// ---------------------------------------------------------------------------

test("runExecution constructs the exact command that would be (or is) invoked", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  const result = await runExecution(
    baseContext(ws, { claudeCommand: "my-claude-cli", cwd: ws.cwd, invoke: neverCalledInvoke() }),
  );

  assert.ok(result.command !== null);
  assert.equal(result.command!.command, "my-claude-cli");
  assert.equal(result.command!.cwd, ws.cwd);
  assert.deepEqual(result.command!.args, [result.briefFilePath]);
});

// ---------------------------------------------------------------------------
// real (local) execution -- only reached via the double gate
// ---------------------------------------------------------------------------

test("runExecution invokes the process exactly once when executeFlag=true and executionMode=local", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  const successResult: ClaudeExecutionResult = {
    command: { command: "claude", args: [], cwd: ws.cwd },
    exitCode: 0,
    stdout: "done",
    stderr: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    spawnError: null,
  };
  const spy = spyInvoke(successResult);

  const result = await runExecution(
    baseContext(ws, { executionMode: "local", executeFlag: true, invoke: spy.invoke }),
  );

  assert.equal(result.dryRun, false);
  assert.equal(spy.calls.length, 1);
  assert.deepEqual(spy.calls[0], result.command);
  assert.equal(result.ok, true);
  assert.equal(result.result, successResult);
});

// ---------------------------------------------------------------------------
// failed process handling
// ---------------------------------------------------------------------------

test("runExecution surfaces a spawn error without throwing", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  const failure: ClaudeExecutionResult = {
    command: { command: "claude", args: [], cwd: ws.cwd },
    exitCode: null,
    stdout: "",
    stderr: "",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    spawnError: "spawn claude ENOENT",
  };
  const spy = spyInvoke(failure);

  const result = await runExecution(
    baseContext(ws, { executionMode: "local", executeFlag: true, invoke: spy.invoke }),
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /ENOENT/);
});

test("runExecution surfaces a non-zero exit code without throwing", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  const failure: ClaudeExecutionResult = {
    command: { command: "claude", args: [], cwd: ws.cwd },
    exitCode: 1,
    stdout: "",
    stderr: "boom",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    spawnError: null,
  };
  const spy = spyInvoke(failure);

  const result = await runExecution(
    baseContext(ws, { executionMode: "local", executeFlag: true, invoke: spy.invoke }),
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /exited with code 1/);
});

// ---------------------------------------------------------------------------
// execution log
// ---------------------------------------------------------------------------

test("appendExecutionRecord creates the log file on first use and appends on subsequent calls", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-execlog-"));
  const logPath = path.join(dir, "EXECUTION_LOG.json");

  const record = (n: number): ExecutionRecord => ({
    timestamp: `2026-01-0${n}T00:00:00.000Z`,
    taskId: "T-001",
    phase: "IMPLEMENTING",
    executionMode: "dry-run",
    executeFlagSet: false,
    dryRun: true,
    command: null,
    briefFilePath: null,
    outcome: `attempt ${n}`,
    exitCode: null,
    spawnError: null,
  });

  appendExecutionRecord(logPath, record(1));
  appendExecutionRecord(logPath, record(2));

  const raw = JSON.parse(fs.readFileSync(logPath, "utf8")) as ExecutionRecord[];
  assert.equal(raw.length, 2);
  assert.equal(raw[0]?.outcome, "attempt 1");
  assert.equal(raw[1]?.outcome, "attempt 2");
});

test("runExecution appends one execution log record per attempt", async () => {
  const ws = tempWorkspace();
  saveTaskState(ws.taskStatePath, harmlessTask());

  await runExecution(baseContext(ws, { invoke: neverCalledInvoke() }));
  await runExecution(baseContext(ws, { invoke: neverCalledInvoke() }));

  const raw = JSON.parse(fs.readFileSync(ws.executionLogPath, "utf8")) as ExecutionRecord[];
  assert.equal(raw.length, 2);
});
