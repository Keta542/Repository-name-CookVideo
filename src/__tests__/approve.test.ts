import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runApprove, type ApproveContext } from "../commands/approve.js";
import { EMPTY_TASK_STATE, loadTaskState, saveTaskState, type TaskState } from "../lib/taskState.js";

// Every test here uses a fresh temp directory -- never the real .cookvideo/
// files -- via the injectable ApproveContext (mirroring PlanContext /
// ExecuteContext).
function tempContext(): ApproveContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-approve-"));
  return {
    taskStatePath: path.join(dir, "TASK_STATE.json"),
    activeTaskPath: path.join(dir, "ACTIVE_TASK.md"),
    buildLogPath: path.join(dir, "BUILD_LOG.md"),
  };
}

function pendingTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "T-GATE-001",
    objective: "Do a risky thing",
    scope: "src/",
    phase: "APPROVAL_REQUIRED",
    riskLevel: "HIGH",
    approvalStatus: "PENDING",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("runApprove writes matching TASK_STATE.json and ACTIVE_TASK.md, and a BUILD_LOG.md entry", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, pendingTask());

  const result = runApprove(ctx);
  assert.equal(result.ok, true);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.phase, "APPROVED");
  assert.equal(state.approvalStatus, "APPROVED");

  const activeTaskMd = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTaskMd, /T-GATE-001/);
  assert.match(activeTaskMd, /\| Phase \| APPROVED \|/);
  assert.match(activeTaskMd, /\| Approval status \| APPROVED \|/);

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Task approved via `cookvideo-agent approve`: T-GATE-001/);
  assert.match(buildLog, /APPROVAL_REQUIRED -> APPROVED/);
});

test("runApprove does not touch ACTIVE_TASK.md or BUILD_LOG.md on a refusal (no state change)", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, pendingTask({ phase: "IMPLEMENTING", approvalStatus: "NOT_REQUIRED" }));

  const result = runApprove(ctx);
  assert.equal(result.ok, false);
  assert.ok(!fs.existsSync(ctx.activeTaskPath), "ACTIVE_TASK.md should not be written on refusal");
  assert.ok(!fs.existsSync(ctx.buildLogPath), "BUILD_LOG.md should not be written on refusal");
});

test("runApprove does not duplicate a BUILD_LOG.md entry on an already-APPROVED no-op", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, pendingTask({ phase: "APPROVED", approvalStatus: "APPROVED" }));

  const result = runApprove(ctx);
  assert.equal(result.ok, true);
  assert.ok(!fs.existsSync(ctx.buildLogPath), "no-op approval should not write a new BUILD_LOG.md entry");
});
