import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  EMPTY_TASK_STATE,
  approveTask,
  isValidTaskState,
  isValidTransition,
  isTerminalPhase,
  loadTaskState,
  resetTaskState,
  saveTaskState,
  type TaskState,
} from "../lib/taskState.js";

// All tests here use a fresh temp file per test (never the real, on-disk
// .cookvideo/TASK_STATE.json) so running the suite can never corrupt or
// overwrite this control plane's actual task state.
function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-taskstate-"));
  return path.join(dir, "TASK_STATE.json");
}

function activeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "T-001",
    objective: "Do the thing",
    scope: "src/",
    phase: "APPROVAL_REQUIRED",
    riskLevel: "LOW",
    approvalStatus: "PENDING",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// task state loading
// ---------------------------------------------------------------------------

test("loadTaskState returns a fresh EMPTY_TASK_STATE when the file does not exist", () => {
  const filePath = tempStatePath(); // never written to
  const state = loadTaskState(filePath);
  assert.deepEqual(state, EMPTY_TASK_STATE);
});

test("loadTaskState round-trips a saved task state", () => {
  const filePath = tempStatePath();
  const task = activeTask();
  saveTaskState(filePath, task);

  const loaded = loadTaskState(filePath);
  assert.deepEqual(loaded, task);
});

test("loadTaskState throws a clear error on invalid JSON", () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ not valid json", "utf8");

  assert.throws(() => loadTaskState(filePath), /not valid JSON/);
});

test("loadTaskState throws a clear error when the JSON does not match the TaskState shape", () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ taskId: "T-001" }), "utf8"); // missing required fields

  assert.throws(() => loadTaskState(filePath), /does not match the expected TaskState shape/);
});

// ---------------------------------------------------------------------------
// lifecycle validation
// ---------------------------------------------------------------------------

test("isValidTransition allows each step of the main forward path", () => {
  assert.equal(isValidTransition("PLANNED", "IMPLEMENTING"), true);
  assert.equal(isValidTransition("IMPLEMENTING", "TESTING"), true);
  assert.equal(isValidTransition("TESTING", "REVIEW"), true);
  assert.equal(isValidTransition("REVIEW", "APPROVAL_REQUIRED"), true);
  assert.equal(isValidTransition("APPROVAL_REQUIRED", "APPROVED"), true);
  assert.equal(isValidTransition("APPROVED", "COMMITTING"), true);
  assert.equal(isValidTransition("COMMITTING", "DEPLOYING"), true);
  assert.equal(isValidTransition("DEPLOYING", "VERIFYING"), true);
  assert.equal(isValidTransition("VERIFYING", "COMPLETED"), true);
});

test("isValidTransition rejects skipping ahead in the forward path", () => {
  assert.equal(isValidTransition("PLANNED", "TESTING"), false);
  assert.equal(isValidTransition("PLANNED", "APPROVED"), false);
  assert.equal(isValidTransition("REVIEW", "COMMITTING"), false);
});

test("isValidTransition rejects moving backwards along the forward path", () => {
  assert.equal(isValidTransition("TESTING", "IMPLEMENTING"), false);
  assert.equal(isValidTransition("APPROVED", "APPROVAL_REQUIRED"), false);
});

test("isValidTransition allows any non-terminal phase to move to FAILED, BLOCKED or CANCELLED", () => {
  for (const phase of ["PLANNED", "IMPLEMENTING", "TESTING", "REVIEW", "APPROVAL_REQUIRED", "APPROVED", "COMMITTING", "DEPLOYING", "VERIFYING"] as const) {
    assert.equal(isValidTransition(phase, "FAILED"), true, `${phase} -> FAILED`);
    assert.equal(isValidTransition(phase, "BLOCKED"), true, `${phase} -> BLOCKED`);
    assert.equal(isValidTransition(phase, "CANCELLED"), true, `${phase} -> CANCELLED`);
  }
});

test("isValidTransition allows recovering from FAILED or BLOCKED back into the forward flow", () => {
  assert.equal(isValidTransition("FAILED", "PLANNED"), true);
  assert.equal(isValidTransition("FAILED", "IMPLEMENTING"), true);
  assert.equal(isValidTransition("BLOCKED", "PLANNED"), true);
  assert.equal(isValidTransition("BLOCKED", "IMPLEMENTING"), true);
});

test("isValidTransition treats COMPLETED and CANCELLED as terminal (no transitions out)", () => {
  assert.equal(isTerminalPhase("COMPLETED"), true);
  assert.equal(isTerminalPhase("CANCELLED"), true);
  assert.equal(isTerminalPhase("FAILED"), false);
  assert.equal(isTerminalPhase("BLOCKED"), false);

  assert.equal(isValidTransition("COMPLETED", "PLANNED"), false);
  assert.equal(isValidTransition("COMPLETED", "FAILED"), false);
  assert.equal(isValidTransition("CANCELLED", "PLANNED"), false);
});

// ---------------------------------------------------------------------------
// approval / shape validation
// ---------------------------------------------------------------------------

test("isValidTaskState accepts EMPTY_TASK_STATE and a populated active task", () => {
  assert.equal(isValidTaskState(EMPTY_TASK_STATE), true);
  assert.equal(isValidTaskState(activeTask()), true);
});

test("isValidTaskState rejects an unknown phase value", () => {
  const bad = { ...activeTask(), phase: "NOT_A_REAL_PHASE" };
  assert.equal(isValidTaskState(bad), false);
});

test("isValidTaskState rejects an unknown approvalStatus value", () => {
  const bad = { ...activeTask(), approvalStatus: "SORT_OF_APPROVED" };
  assert.equal(isValidTaskState(bad), false);
});

test("isValidTaskState rejects an unknown riskLevel value", () => {
  const bad = { ...activeTask(), riskLevel: "EXTREME" };
  assert.equal(isValidTaskState(bad), false);
});

test("isValidTaskState rejects non-array filesExpectedToChange/testsRequired", () => {
  assert.equal(isValidTaskState({ ...activeTask(), filesExpectedToChange: "not-an-array" }), false);
  assert.equal(isValidTaskState({ ...activeTask(), testsRequired: [1, 2, 3] }), false);
});

test("isValidTaskState rejects null and non-object values", () => {
  assert.equal(isValidTaskState(null), false);
  assert.equal(isValidTaskState("a string"), false);
  assert.equal(isValidTaskState(42), false);
});

// ---------------------------------------------------------------------------
// approveTask behavior
// ---------------------------------------------------------------------------

test("approveTask succeeds from APPROVAL_REQUIRED and sets phase/approvalStatus/updatedAt", () => {
  const before = activeTask({ phase: "APPROVAL_REQUIRED", approvalStatus: "PENDING", updatedAt: null });
  const result = approveTask(before);

  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "APPROVED");
  assert.equal(result.state.approvalStatus, "APPROVED");
  assert.ok(result.state.updatedAt, "expected updatedAt to be set");
  assert.match(result.message, /No commit, push, or deployment/);
});

test("approveTask refuses when there is no active task", () => {
  const result = approveTask(EMPTY_TASK_STATE);
  assert.equal(result.ok, false);
  assert.equal(result.state, EMPTY_TASK_STATE);
  assert.match(result.message, /No active task/);
});

test("approveTask refuses when the task is not in APPROVAL_REQUIRED", () => {
  const before = activeTask({ phase: "IMPLEMENTING" });
  const result = approveTask(before);

  assert.equal(result.ok, false);
  assert.equal(result.state, before);
  assert.match(result.message, /not APPROVAL_REQUIRED/);
});

test("approveTask is a no-op (still ok) when the task is already APPROVED", () => {
  const before = activeTask({ phase: "APPROVED", approvalStatus: "APPROVED" });
  const result = approveTask(before);

  assert.equal(result.ok, true);
  assert.equal(result.state, before);
  assert.match(result.message, /already APPROVED/);
});

// ---------------------------------------------------------------------------
// resetTaskState behavior
// ---------------------------------------------------------------------------

test("resetTaskState returns a fresh empty task state", () => {
  const state = resetTaskState();
  assert.deepEqual(state, EMPTY_TASK_STATE);
  // must be a distinct object, not a shared mutable reference
  assert.notEqual(state, EMPTY_TASK_STATE);
});

test("saveTaskState followed by loadTaskState of a reset state yields an empty task", () => {
  const filePath = tempStatePath();
  saveTaskState(filePath, activeTask()); // start with a populated task on disk

  const reset = resetTaskState();
  saveTaskState(filePath, reset);

  const loaded = loadTaskState(filePath);
  assert.deepEqual(loaded, EMPTY_TASK_STATE);
});
