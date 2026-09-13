import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runReset, type ResetContext } from "../commands/reset.js";
import { EMPTY_TASK_STATE, loadTaskState, saveTaskState, type TaskState } from "../lib/taskState.js";
import { readTaskHistoryEntries } from "../lib/taskHistory.js";

// Every test here uses a fresh temp directory -- never the real .cookvideo/
// files -- via the injectable ResetContext (mirroring ApproveContext/
// AdvanceContext).
function tempContext(): ResetContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-reset-"));
  return {
    taskStatePath: path.join(dir, "TASK_STATE.json"),
    activeTaskPath: path.join(dir, "ACTIVE_TASK.md"),
    taskHistoryPath: path.join(dir, "TASK_HISTORY.json"),
  };
}

function completedTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "T-RESET-001",
    objective: "Do a thing",
    scope: "src/",
    phase: "COMPLETED",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    result: "Completed.",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("runReset archives the current task to TASK_HISTORY.json before clearing it", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, completedTask());

  const result = runReset(ctx);
  assert.equal(result.archived, true);
  assert.match(result.message, /T-RESET-001/);
  assert.match(result.message, /TASK_HISTORY\.json/);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.taskId, null);
  assert.equal(state.phase, "PLANNED");

  const history = readTaskHistoryEntries(ctx.taskHistoryPath);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.archivedVia, "reset");
  assert.equal(history[0]?.task.taskId, "T-RESET-001");
  assert.equal(history[0]?.task.phase, "COMPLETED");

  const activeTaskMd = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTaskMd, /no active task/);
});

test("runReset archives an incomplete/abandoned task too, not only a COMPLETED one", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, completedTask({ taskId: "T-ABANDONED", phase: "IMPLEMENTING", result: null }));

  runReset(ctx);

  const history = readTaskHistoryEntries(ctx.taskHistoryPath);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.task.taskId, "T-ABANDONED");
  assert.equal(history[0]?.task.phase, "IMPLEMENTING");
});

test("runReset archives nothing when there is no active task", () => {
  const ctx = tempContext();
  // No TASK_STATE.json written at all -- loadTaskState returns EMPTY_TASK_STATE.

  const result = runReset(ctx);
  assert.equal(result.archived, false);
  assert.equal(fs.existsSync(ctx.taskHistoryPath), false, "TASK_HISTORY.json should not be created when there is nothing to archive");
});

test("runReset appends to an existing TASK_HISTORY.json rather than overwriting it", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, completedTask({ taskId: "T-FIRST" }));
  runReset(ctx);

  saveTaskState(ctx.taskStatePath, completedTask({ taskId: "T-SECOND" }));
  runReset(ctx);

  const history = readTaskHistoryEntries(ctx.taskHistoryPath);
  assert.equal(history.length, 2);
  assert.equal(history[0]?.task.taskId, "T-FIRST");
  assert.equal(history[1]?.task.taskId, "T-SECOND");
});
