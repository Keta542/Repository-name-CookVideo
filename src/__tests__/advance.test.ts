import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseAdvanceCliArgs, runAdvance, type AdvanceContext } from "../commands/advance.js";
import { EMPTY_TASK_STATE, loadTaskState, saveTaskState, type TaskState } from "../lib/taskState.js";

// Every test here uses a fresh temp directory -- never the real .cookvideo/
// files -- via the injectable AdvanceContext (mirroring ApproveContext /
// CompleteContext).
function tempContext(): AdvanceContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-advance-"));
  return {
    taskStatePath: path.join(dir, "TASK_STATE.json"),
    activeTaskPath: path.join(dir, "ACTIVE_TASK.md"),
    buildLogPath: path.join(dir, "BUILD_LOG.md"),
  };
}

function taskInPhase(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "T-ADVANCE-001",
    objective: "Do a thing",
    scope: "src/",
    phase: "TESTING",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("runAdvance writes matching TASK_STATE.json and ACTIVE_TASK.md, and a BUILD_LOG.md entry", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, taskInPhase({ phase: "TESTING" }));

  const result = runAdvance("REVIEW", {}, ctx);
  assert.equal(result.ok, true);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.phase, "REVIEW");

  const activeTaskMd = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTaskMd, /T-ADVANCE-001/);
  assert.match(activeTaskMd, /\| Phase \| REVIEW \|/);

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Task advanced via `cookvideo-agent advance`: T-ADVANCE-001/);
  assert.match(buildLog, /TESTING -> REVIEW/);
});

test("runAdvance records a supplied --note in TASK_STATE.json and BUILD_LOG.md", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, taskInPhase({ phase: "COMMITTING" }));

  const result = runAdvance("DEPLOYING", { note: "CookVideo commit c8b7df8" }, ctx);
  assert.equal(result.ok, true);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.phase, "DEPLOYING");
  assert.equal(state.result, "CookVideo commit c8b7df8");

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Note: CookVideo commit c8b7df8/);
});

test("runAdvance does not touch ACTIVE_TASK.md or BUILD_LOG.md on a refusal (wrong source phase)", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, taskInPhase({ phase: "PLANNED" }));

  const result = runAdvance("REVIEW", {}, ctx);
  assert.equal(result.ok, false);
  assert.ok(!fs.existsSync(ctx.activeTaskPath), "ACTIVE_TASK.md should not be written on refusal");
  assert.ok(!fs.existsSync(ctx.buildLogPath), "BUILD_LOG.md should not be written on refusal");
});

test("runAdvance refuses a target reserved for execute/approve/complete (IMPLEMENTING/APPROVED/COMPLETED are not advanceable)", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, taskInPhase({ phase: "APPROVAL_REQUIRED" }));

  const parsed = parseAdvanceCliArgs(["--to", "APPROVED"]);
  assert.equal(parsed.toPhase, null);
  assert.equal(parsed.invalidToValue, "APPROVED");
});

test("a full advance walk TESTING -> REVIEW -> APPROVAL_REQUIRED, each step producing its own BUILD_LOG.md entry", () => {
  const ctx = tempContext();
  saveTaskState(ctx.taskStatePath, taskInPhase({ phase: "TESTING" }));

  assert.equal(runAdvance("REVIEW", {}, ctx).ok, true);
  assert.equal(runAdvance("APPROVAL_REQUIRED", {}, ctx).ok, true);

  const state = loadTaskState(ctx.taskStatePath);
  assert.equal(state.phase, "APPROVAL_REQUIRED");
  assert.equal(state.approvalStatus, "NOT_REQUIRED", "advance must never itself set approvalStatus");

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /TESTING -> REVIEW/);
  assert.match(buildLog, /REVIEW -> APPROVAL_REQUIRED/);
});

// ---------------------------------------------------------------------------
// parseAdvanceCliArgs
// ---------------------------------------------------------------------------

test("parseAdvanceCliArgs parses --to and --note", () => {
  const parsed = parseAdvanceCliArgs(["--to", "REVIEW", "--note", "looks good"]);
  assert.equal(parsed.toPhase, "REVIEW");
  assert.equal(parsed.invalidToValue, null);
  assert.deepEqual(parsed.options, { note: "looks good" });
});

test("parseAdvanceCliArgs reports a missing --to distinctly from an invalid one", () => {
  const missing = parseAdvanceCliArgs([]);
  assert.equal(missing.toPhase, null);
  assert.equal(missing.invalidToValue, null);

  const invalid = parseAdvanceCliArgs(["--to", "NOT_A_PHASE"]);
  assert.equal(invalid.toPhase, null);
  assert.equal(invalid.invalidToValue, "NOT_A_PHASE");
});
