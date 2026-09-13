import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseCompleteCliArgs, runComplete, type CompleteContext } from "../commands/complete.js";
import { EMPTY_TASK_STATE, loadTaskState, saveTaskState, type TaskState } from "../lib/taskState.js";

// Covers `cookvideo-agent complete [--commit <hash>]`'s argument parsing.
// This is kept out of src/cli.ts's own test coverage deliberately: cli.ts
// calls process.exit as a side effect of being imported at all, so its
// dispatch logic can never be safely imported from a test -- only the pure
// parser it delegates to (src/commands/complete.ts) can be.

test("parseCompleteCliArgs returns no commitHash when --commit is absent", () => {
  const result = parseCompleteCliArgs([]);
  assert.equal(result.commitHash, undefined);
});

test("parseCompleteCliArgs reads the value following --commit", () => {
  const result = parseCompleteCliArgs(["--commit", "c8b7df8"]);
  assert.equal(result.commitHash, "c8b7df8");
});

test("parseCompleteCliArgs is undefined when --commit is the last argument with no value", () => {
  const result = parseCompleteCliArgs(["--commit"]);
  assert.equal(result.commitHash, undefined);
});

// ---------------------------------------------------------------------------
// runComplete: TASK_STATE.json / ACTIVE_TASK.md / BUILD_LOG.md consistency
// (Milestone 7). Every test here uses a fresh temp directory -- never the
// real .cookvideo/ files -- via the injectable CompleteContext.
// ---------------------------------------------------------------------------

function tempContext(): CompleteContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-complete-"));
  return {
    taskStatePath: path.join(dir, "TASK_STATE.json"),
    activeTaskPath: path.join(dir, "ACTIVE_TASK.md"),
    buildLogPath: path.join(dir, "BUILD_LOG.md"),
  };
}

function qualifyingTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "T-GATE-001",
    objective: "Do a risky thing",
    scope: "src/",
    phase: "PLANNED",
    riskLevel: "HIGH",
    approvalStatus: "NOT_REQUIRED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("runComplete on a plain LOW-risk task writes matching TASK_STATE.json and ACTIVE_TASK.md, and a BUILD_LOG.md entry", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, qualifyingTask({ riskLevel: "LOW", taskId: "T-LOW-001" }));

  const result = runComplete({}, ctx);
  assert.equal(result.ok, true);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.phase, "COMPLETED");

  const activeTaskMd = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTaskMd, /T-LOW-001/);
  assert.match(activeTaskMd, /\| Phase \| COMPLETED \|/);

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Task updated via `cookvideo-agent complete`: T-LOW-001/);
  assert.match(buildLog, /PLANNED -> COMPLETED/);
});

test("runComplete on a qualifying task writes the APPROVAL_REQUIRED/PENDING gate state consistently, without completing", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, qualifyingTask());

  const result = runComplete({}, ctx);
  assert.equal(result.ok, false);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.phase, "APPROVAL_REQUIRED");
  assert.equal(state.approvalStatus, "PENDING");

  const activeTaskMd = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTaskMd, /\| Phase \| APPROVAL_REQUIRED \|/);
  assert.match(activeTaskMd, /\| Approval status \| PENDING \|/);

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Task updated via `cookvideo-agent complete`: T-GATE-001/);
  assert.match(buildLog, /requires human approval/);
});

test("runComplete does not touch ACTIVE_TASK.md or BUILD_LOG.md on a pure refusal (no state change)", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, qualifyingTask({ approvalStatus: "REJECTED" }));

  const result = runComplete({}, ctx);
  assert.equal(result.ok, false);
  assert.ok(!fs.existsSync(ctx.activeTaskPath), "ACTIVE_TASK.md should not be written on a no-op refusal");
  assert.ok(!fs.existsSync(ctx.buildLogPath), "BUILD_LOG.md should not be written on a no-op refusal");
});

test("runComplete records the CookVideo commit hash in TASK_STATE.json and BUILD_LOG.md when completed", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, qualifyingTask({ riskLevel: "LOW", taskId: "T-LOW-002" }));

  const result = runComplete({ commitHash: "abc1234" }, ctx);
  assert.equal(result.ok, true);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.result, "Completed. CookVideo commit: abc1234");

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Completed\. CookVideo commit: abc1234/);
});
