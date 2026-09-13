import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  EMPTY_TASK_STATE,
  applyExecutionOutcome,
  approveTask,
  beginImplementing,
  completeTask,
  isValidTaskState,
  isValidTransition,
  isTerminalPhase,
  loadTaskState,
  requiresApprovalGate,
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

test("loadTaskState normalizes a pre-Milestone-4 file missing requestedChanges/approvalRequirements", () => {
  const filePath = tempStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Shape as written by Milestone 1-3 -- no requestedChanges/approvalRequirements
  // fields at all, and (as of this milestone) no gate-related history either.
  const preM4Shape = {
    taskId: "T-001",
    objective: "Do the thing",
    scope: "src/",
    phase: "PLANNED",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    filesExpectedToChange: [],
    testsRequired: [],
    result: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  fs.writeFileSync(filePath, JSON.stringify(preM4Shape), "utf8");

  const loaded = loadTaskState(filePath);
  assert.deepEqual(loaded.requestedChanges, []);
  assert.deepEqual(loaded.approvalRequirements, []);
  assert.equal(loaded.taskId, "T-001");
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
// completeTask behavior
// ---------------------------------------------------------------------------

test("completeTask succeeds from PLANNED (the whole remaining chain is validated at once)", () => {
  const before = activeTask({ phase: "PLANNED", approvalStatus: "NOT_REQUIRED", updatedAt: null });
  const result = completeTask(before);

  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "COMPLETED");
  assert.equal(result.state.result, "Completed.");
  assert.ok(result.state.updatedAt, "expected updatedAt to be set");
  assert.match(result.message, /PLANNED -> COMPLETED/);
  assert.match(result.message, /No files were edited/);
});

test("completeTask succeeds from any phase on the forward path (IMPLEMENTING, REVIEW, VERIFYING)", () => {
  for (const phase of ["IMPLEMENTING", "TESTING", "REVIEW", "APPROVAL_REQUIRED", "APPROVED", "COMMITTING", "DEPLOYING", "VERIFYING"] as const) {
    const before = activeTask({ phase, approvalStatus: "NOT_REQUIRED" });
    const result = completeTask(before);
    assert.equal(result.ok, true, `expected completion to succeed from ${phase}`);
    assert.equal(result.state.phase, "COMPLETED");
  }
});

test("completeTask records the supplied CookVideo commit hash in result", () => {
  const before = activeTask({ phase: "PLANNED", approvalStatus: "NOT_REQUIRED" });
  const result = completeTask(before, { commitHash: "c8b7df8" });

  assert.equal(result.ok, true);
  assert.equal(result.state.result, "Completed. CookVideo commit: c8b7df8");
});

test("completeTask ignores a blank/whitespace-only commit hash", () => {
  const before = activeTask({ phase: "PLANNED", approvalStatus: "NOT_REQUIRED" });
  const result = completeTask(before, { commitHash: "   " });

  assert.equal(result.ok, true);
  assert.equal(result.state.result, "Completed.");
});

test("completeTask refuses when there is no active task", () => {
  const result = completeTask(EMPTY_TASK_STATE);
  assert.equal(result.ok, false);
  assert.equal(result.state, EMPTY_TASK_STATE);
  assert.match(result.message, /No active task/);
});

test("completeTask is a no-op (still ok) when the task is already COMPLETED", () => {
  const before = activeTask({ phase: "COMPLETED", approvalStatus: "NOT_REQUIRED" });
  const result = completeTask(before);

  assert.equal(result.ok, true);
  assert.equal(result.state, before);
  assert.match(result.message, /already COMPLETED/);
});

test("completeTask refuses from FAILED, BLOCKED, and CANCELLED", () => {
  for (const phase of ["FAILED", "BLOCKED", "CANCELLED"] as const) {
    const before = activeTask({ phase, approvalStatus: "NOT_REQUIRED" });
    const result = completeTask(before);
    assert.equal(result.ok, false, `expected completion to be refused from ${phase}`);
    assert.equal(result.state, before);
    assert.match(result.message, /not on the forward path to COMPLETED/);
  }
});

test("completeTask refuses when approvalStatus is REJECTED", () => {
  const before = activeTask({ phase: "APPROVAL_REQUIRED", approvalStatus: "REJECTED" });
  const result = completeTask(before);

  assert.equal(result.ok, false);
  assert.equal(result.state, before);
  assert.match(result.message, /REJECTED/);
});

test("completeTask refuses when approvalStatus is PENDING, pointing at `approve`", () => {
  const before = activeTask({ phase: "APPROVAL_REQUIRED", approvalStatus: "PENDING" });
  const result = completeTask(before);

  assert.equal(result.ok, false);
  assert.equal(result.state, before);
  assert.match(result.message, /cookvideo-agent approve/);
});

// ---------------------------------------------------------------------------
// requiresApprovalGate (Milestone 7)
// ---------------------------------------------------------------------------

test("requiresApprovalGate is false for a plain LOW-risk task with no approvalRequirements", () => {
  const task = activeTask({ riskLevel: "LOW", approvalRequirements: [] });
  assert.equal(requiresApprovalGate(task), false);
});

test("requiresApprovalGate is true for MEDIUM or HIGH riskLevel", () => {
  assert.equal(requiresApprovalGate(activeTask({ riskLevel: "MEDIUM", approvalRequirements: [] })), true);
  assert.equal(requiresApprovalGate(activeTask({ riskLevel: "HIGH", approvalRequirements: [] })), true);
});

test("requiresApprovalGate is true for a LOW-risk task with non-empty approvalRequirements", () => {
  const task = activeTask({ riskLevel: "LOW", approvalRequirements: ["Production Vercel deployment"] });
  assert.equal(requiresApprovalGate(task), true);
});

// ---------------------------------------------------------------------------
// completeTask risk/approval gate enforcement (Milestone 7)
// ---------------------------------------------------------------------------

test("completeTask refuses a MEDIUM/HIGH-risk task while approval is PENDING", () => {
  for (const riskLevel of ["MEDIUM", "HIGH"] as const) {
    const before = activeTask({ phase: "APPROVAL_REQUIRED", riskLevel, approvalStatus: "PENDING" });
    const result = completeTask(before);

    assert.equal(result.ok, false, `expected refusal for ${riskLevel}`);
    assert.equal(result.state, before);
    assert.match(result.message, /cookvideo-agent approve/);
  }
});

test("completeTask refuses a task with non-empty approvalRequirements while approval is PENDING", () => {
  const before = activeTask({
    phase: "APPROVAL_REQUIRED",
    riskLevel: "LOW",
    approvalRequirements: ["Production Supabase migration"],
    approvalStatus: "PENDING",
  });
  const result = completeTask(before);

  assert.equal(result.ok, false);
  assert.equal(result.state, before);
  assert.match(result.message, /cookvideo-agent approve/);
});

test("completeTask succeeds for a qualifying task once approvalStatus is APPROVED", () => {
  for (const phase of ["APPROVED", "COMMITTING", "DEPLOYING", "VERIFYING"] as const) {
    const before = activeTask({ phase, riskLevel: "HIGH", approvalStatus: "APPROVED" });
    const result = completeTask(before);

    assert.equal(result.ok, true, `expected completion to succeed from ${phase}`);
    assert.equal(result.state.phase, "COMPLETED");
  }
});

test("completeTask still completes a plain LOW/NOT_REQUIRED task in one step (Milestone 6 shape unchanged)", () => {
  const before = activeTask({
    phase: "PLANNED",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    approvalRequirements: [],
    updatedAt: null,
  });
  const result = completeTask(before);

  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "COMPLETED");
  assert.match(result.message, /PLANNED -> COMPLETED/);
});

test("completeTask moves a qualifying (MEDIUM/HIGH-risk) task into APPROVAL_REQUIRED/PENDING instead of completing", () => {
  for (const riskLevel of ["MEDIUM", "HIGH"] as const) {
    for (const phase of ["PLANNED", "IMPLEMENTING", "TESTING", "REVIEW"] as const) {
      const before = activeTask({ phase, riskLevel, approvalStatus: "NOT_REQUIRED", approvalRequirements: [] });
      const result = completeTask(before);

      assert.equal(result.ok, false, `expected gate, not completion, from ${phase}/${riskLevel}`);
      assert.equal(result.state.phase, "APPROVAL_REQUIRED", `phase after gate from ${phase}/${riskLevel}`);
      assert.equal(result.state.approvalStatus, "PENDING");
      assert.notEqual(result.state, before, "expected a new state object, not the input reference");
      assert.match(result.message, /APPROVAL_REQUIRED/);
      assert.match(result.message, /cookvideo-agent approve/);
    }
  }
});

test("completeTask moves a task with non-empty approvalRequirements into APPROVAL_REQUIRED/PENDING", () => {
  const before = activeTask({
    phase: "PLANNED",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    approvalRequirements: ["Git push"],
  });
  const result = completeTask(before);

  assert.equal(result.ok, false);
  assert.equal(result.state.phase, "APPROVAL_REQUIRED");
  assert.equal(result.state.approvalStatus, "PENDING");
});

test("completeTask never gates an ordinary LOW/NOT_REQUIRED task into APPROVAL_REQUIRED", () => {
  for (const phase of ["PLANNED", "IMPLEMENTING", "TESTING", "REVIEW", "APPROVED", "COMMITTING", "DEPLOYING", "VERIFYING"] as const) {
    const before = activeTask({ phase, riskLevel: "LOW", approvalStatus: "NOT_REQUIRED", approvalRequirements: [] });
    const result = completeTask(before);

    assert.equal(result.ok, true, `expected plain completion from ${phase}`);
    assert.equal(result.state.phase, "COMPLETED");
  }
});

test("completeTask gate -> approveTask -> completeTask reaches COMPLETED end to end", () => {
  const planned = activeTask({ phase: "PLANNED", riskLevel: "HIGH", approvalStatus: "NOT_REQUIRED" });

  const gated = completeTask(planned);
  assert.equal(gated.ok, false);
  assert.equal(gated.state.phase, "APPROVAL_REQUIRED");
  assert.equal(gated.state.approvalStatus, "PENDING");

  const approved = approveTask(gated.state);
  assert.equal(approved.ok, true);
  assert.equal(approved.state.phase, "APPROVED");
  assert.equal(approved.state.approvalStatus, "APPROVED");

  const completed = completeTask(approved.state);
  assert.equal(completed.ok, true);
  assert.equal(completed.state.phase, "COMPLETED");
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

// ---------------------------------------------------------------------------
// beginImplementing / applyExecutionOutcome (Milestone 8)
// ---------------------------------------------------------------------------

test("beginImplementing moves PLANNED to IMPLEMENTING", () => {
  const result = beginImplementing(activeTask({ phase: "PLANNED" }));
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "IMPLEMENTING");
});

test("beginImplementing is a no-op (same reference) when already IMPLEMENTING", () => {
  const task = activeTask({ phase: "IMPLEMENTING" });
  const result = beginImplementing(task);
  assert.equal(result.ok, true);
  assert.equal(result.state, task);
});

test("beginImplementing recovers FAILED and BLOCKED into IMPLEMENTING", () => {
  for (const phase of ["FAILED", "BLOCKED"] as const) {
    const result = beginImplementing(activeTask({ phase }));
    assert.equal(result.ok, true, phase);
    assert.equal(result.state.phase, "IMPLEMENTING", phase);
  }
});

test("beginImplementing refuses a phase that cannot move to IMPLEMENTING (e.g. REVIEW)", () => {
  const task = activeTask({ phase: "REVIEW" });
  const result = beginImplementing(task);
  assert.equal(result.ok, false);
  assert.equal(result.state, task);
  assert.match(result.message, /cannot move to IMPLEMENTING/);
});

test("applyExecutionOutcome moves IMPLEMENTING to TESTING on success and records the result message", () => {
  const task = activeTask({ phase: "IMPLEMENTING" });
  const result = applyExecutionOutcome(task, true, "Claude process completed successfully.");
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "TESTING");
  assert.equal(result.state.result, "Claude process completed successfully.");
});

test("applyExecutionOutcome moves IMPLEMENTING to FAILED on failure and records the result message", () => {
  const task = activeTask({ phase: "IMPLEMENTING" });
  const result = applyExecutionOutcome(task, false, "Execution failed to start: spawn claude ENOENT");
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "FAILED");
  assert.equal(result.state.result, "Execution failed to start: spawn claude ENOENT");
});

test("applyExecutionOutcome refuses a phase where the target transition isn't legal", () => {
  // COMPLETED is terminal -- TRANSITIONS allows nothing out of it, including
  // the escape hatches TESTING/FAILED would otherwise use.
  const task = activeTask({ phase: "COMPLETED" });
  const result = applyExecutionOutcome(task, true, "irrelevant");
  assert.equal(result.ok, false);
  assert.equal(result.state, task);
});
