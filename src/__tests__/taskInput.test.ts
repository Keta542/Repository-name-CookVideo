import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readTaskInputFile, validateTaskInput, type TaskInput } from "../lib/taskInput.js";
import {
  buildTaskStateFromInput,
  isSafeToReplace,
  REPLACEMENT_BLOCKED_PHASES,
  runPlan,
  type PlanContext,
} from "../lib/plan.js";
import { loadTaskState, saveTaskState, type TaskPhase, type TaskState } from "../lib/taskState.js";

// All tests here use fresh temp files/directories per test -- never the real
// .cookvideo/ directory -- so running the suite can never touch real task
// state or the real CookVideo repository. `plan`/`runPlan` never touch
// CookVideo, Claude, git, or any external system by construction (they only
// ever write TASK_STATE.json, ACTIVE_TASK.md, and BUILD_LOG.md at the paths
// passed in), so there is nothing here that could reach outside the temp
// workspace even by accident.

function validInput(overrides: Partial<TaskInput> = {}): Record<string, unknown> {
  return {
    taskId: "T-100",
    objective: "Do the thing",
    scope: "src/",
    requestedChanges: ["Add a helper function"],
    filesExpectedToChange: ["src/a.ts"],
    testsRequired: ["src/__tests__/a.test.ts"],
    riskLevel: "LOW",
    approvalRequirements: [],
    ...overrides,
  };
}

function withoutKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k !== key) {
      rest[k] = v;
    }
  }
  return rest;
}

function tempInputFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-taskinput-"));
  const filePath = path.join(dir, "task.json");
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function tempWorkspace(): { ctx: PlanContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-plan-"));
  return {
    dir,
    ctx: {
      taskStatePath: path.join(dir, "TASK_STATE.json"),
      activeTaskPath: path.join(dir, "ACTIVE_TASK.md"),
      buildLogPath: path.join(dir, "BUILD_LOG.md"),
      inputFilePath: path.join(dir, "task.json"),
      replace: false,
    },
  };
}

function existingTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskId: "EXISTING-001",
    objective: "Existing objective",
    scope: "src/",
    phase: "PLANNED",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    filesExpectedToChange: [],
    testsRequired: [],
    requestedChanges: [],
    approvalRequirements: [],
    result: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateTaskInput -- schema validation
// ---------------------------------------------------------------------------

test("validateTaskInput accepts a fully valid task", () => {
  const result = validateTaskInput(validInput());
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.value !== null);
  assert.equal(result.value?.taskId, "T-100");
  assert.equal(result.value?.riskLevel, "LOW");
});

test("validateTaskInput rejects a missing taskId", () => {
  const input = withoutKey(validInput(), "taskId");
  const result = validateTaskInput(input);
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.errors.some((e) => /taskId/.test(e)));
});

test("validateTaskInput rejects a missing objective", () => {
  const input = withoutKey(validInput(), "objective");
  const result = validateTaskInput(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /objective/.test(e)));
});

test("validateTaskInput rejects a missing scope", () => {
  const input = withoutKey(validInput(), "scope");
  const result = validateTaskInput(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /scope/.test(e)));
});

test("validateTaskInput rejects a missing/empty requestedChanges", () => {
  const missing = withoutKey(validInput(), "requestedChanges");
  const missingResult = validateTaskInput(missing);
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((e) => /requestedChanges/.test(e)));

  const empty = validateTaskInput(validInput({ requestedChanges: [] }));
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((e) => /requestedChanges/.test(e)));
});

test("validateTaskInput rejects an invalid riskLevel", () => {
  const result = validateTaskInput(validInput({ riskLevel: "EXTREME" as never }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /riskLevel/.test(e)));
});

test("validateTaskInput rejects an invalid approvalRequirements (wrong type / non-string items)", () => {
  const notAnArray = validateTaskInput(validInput({ approvalRequirements: "git commit" as never }));
  assert.equal(notAnArray.ok, false);
  assert.ok(notAnArray.errors.some((e) => /approvalRequirements/.test(e)));

  const nonStringItems = validateTaskInput(validInput({ approvalRequirements: [1, 2, 3] as never }));
  assert.equal(nonStringItems.ok, false);
  assert.ok(nonStringItems.errors.some((e) => /approvalRequirements/.test(e)));
});

test("validateTaskInput accepts an empty approvalRequirements array (no approval-gated actions anticipated)", () => {
  const result = validateTaskInput(validInput({ approvalRequirements: [] }));
  assert.equal(result.ok, true);
});

test("validateTaskInput rejects a non-object value", () => {
  assert.equal(validateTaskInput(null).ok, false);
  assert.equal(validateTaskInput("a string").ok, false);
  assert.equal(validateTaskInput([1, 2, 3]).ok, false);
});

test("validateTaskInput collects every problem, not just the first", () => {
  const result = validateTaskInput({});
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5, `expected multiple errors, got ${result.errors.length}`);
});

// ---------------------------------------------------------------------------
// readTaskInputFile -- file + JSON handling
// ---------------------------------------------------------------------------

test("readTaskInputFile rejects malformed JSON with a clear error", () => {
  const filePath = tempInputFile("{ not valid json");
  const result = readTaskInputFile(filePath);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not valid JSON/.test(e)));
});

test("readTaskInputFile rejects a missing file with a clear error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-taskinput-missing-"));
  const filePath = path.join(dir, "does-not-exist.json");
  const result = readTaskInputFile(filePath);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not found/.test(e)));
});

test("readTaskInputFile accepts a well-formed, valid file", () => {
  const filePath = tempInputFile(JSON.stringify(validInput()));
  const result = readTaskInputFile(filePath);
  assert.equal(result.ok, true);
  assert.equal(result.value?.taskId, "T-100");
});

// ---------------------------------------------------------------------------
// buildTaskStateFromInput / isSafeToReplace
// ---------------------------------------------------------------------------

test("buildTaskStateFromInput always starts a task at PLANNED with approvalStatus NOT_REQUIRED", () => {
  const parsed = validateTaskInput(validInput());
  assert.equal(parsed.ok, true);
  const state = buildTaskStateFromInput(parsed.value!);

  assert.equal(state.phase, "PLANNED");
  assert.equal(state.approvalStatus, "NOT_REQUIRED");
  assert.equal(state.taskId, "T-100");
  assert.deepEqual(state.requestedChanges, ["Add a helper function"]);
  assert.deepEqual(state.approvalRequirements, []);
  assert.ok(state.createdAt);
  assert.ok(state.updatedAt);
});

test("isSafeToReplace matches the documented blocked-phase list exactly", () => {
  for (const phase of REPLACEMENT_BLOCKED_PHASES) {
    assert.equal(isSafeToReplace(phase), false, phase);
  }
  for (const phase of ["PLANNED", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"] as TaskPhase[]) {
    assert.equal(isSafeToReplace(phase), true, phase);
  }
});

// ---------------------------------------------------------------------------
// runPlan -- orchestration
// ---------------------------------------------------------------------------

test("runPlan creates a new PLANNED task when none exists", () => {
  const { ctx } = tempWorkspace();
  fs.writeFileSync(ctx.inputFilePath, JSON.stringify(validInput()), "utf8");

  const result = runPlan(ctx);

  assert.equal(result.ok, true);
  assert.equal(result.replaced, false);
  assert.equal(result.state?.taskId, "T-100");
  assert.equal(result.state?.phase, "PLANNED");

  const saved = loadTaskState(ctx.taskStatePath);
  assert.equal(saved.taskId, "T-100");

  const activeTaskMarkdown = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTaskMarkdown, /T-100/);
  assert.match(activeTaskMarkdown, /Do the thing/);

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /T-100/);
});

test("runPlan refuses invalid input and never writes TASK_STATE.json (failed validation does not modify state)", () => {
  const { ctx } = tempWorkspace();
  fs.writeFileSync(ctx.inputFilePath, "{ not valid json", "utf8");

  assert.equal(fs.existsSync(ctx.taskStatePath), false);

  const result = runPlan(ctx);

  assert.equal(result.ok, false);
  assert.equal(result.state, null);
  assert.match(result.message, /not modified/);
  assert.equal(fs.existsSync(ctx.taskStatePath), false, "TASK_STATE.json must not be created on failure");
});

test("runPlan does not modify an existing TASK_STATE.json when the new input is invalid", () => {
  const { ctx } = tempWorkspace();
  const before = existingTask({ taskId: "KEEP-ME", phase: "REVIEW" });
  saveTaskState(ctx.taskStatePath, before);
  fs.writeFileSync(ctx.inputFilePath, JSON.stringify(validInput({ riskLevel: "EXTREME" as never })), "utf8");

  const result = runPlan({ ...ctx, replace: true });

  assert.equal(result.ok, false);
  const after = loadTaskState(ctx.taskStatePath);
  assert.deepEqual(after, before);
});

test("runPlan refuses to overwrite an existing active task without --replace (existing task protection)", () => {
  const { ctx } = tempWorkspace();
  const before = existingTask({ taskId: "EXISTING-001", phase: "PLANNED" });
  saveTaskState(ctx.taskStatePath, before);
  fs.writeFileSync(ctx.inputFilePath, JSON.stringify(validInput({ taskId: "NEW-001" })), "utf8");

  const result = runPlan({ ...ctx, replace: false });

  assert.equal(result.ok, false);
  assert.equal(result.previousTaskId, "EXISTING-001");
  assert.match(result.message, /EXISTING-001/);
  assert.match(result.message, /--replace/);

  const after = loadTaskState(ctx.taskStatePath);
  assert.deepEqual(after, before, "existing task must be untouched");
});

test("runPlan refuses --replace while the existing task is in a blocked (in-flight) phase", () => {
  for (const blockedPhase of REPLACEMENT_BLOCKED_PHASES) {
    const { ctx } = tempWorkspace();
    const before = existingTask({ taskId: "IN-FLIGHT-001", phase: blockedPhase });
    saveTaskState(ctx.taskStatePath, before);
    fs.writeFileSync(ctx.inputFilePath, JSON.stringify(validInput({ taskId: "NEW-002" })), "utf8");

    const result = runPlan({ ...ctx, replace: true });

    assert.equal(result.ok, false, `expected refusal while existing task is ${blockedPhase}`);
    assert.equal(result.previousTaskId, "IN-FLIGHT-001");
    assert.match(result.message, /IN-FLIGHT-001/);
    assert.match(result.message, new RegExp(blockedPhase));

    const after = loadTaskState(ctx.taskStatePath);
    assert.deepEqual(after, before, `existing ${blockedPhase} task must be untouched`);
  }
});

test("runPlan allows --replace when the existing task is in a safe/terminal phase (replacement of a safe terminal task)", () => {
  for (const safePhase of ["PLANNED", "COMPLETED", "FAILED", "BLOCKED", "CANCELLED"] as TaskPhase[]) {
    const { ctx } = tempWorkspace();
    const before = existingTask({ taskId: "OLD-TASK", phase: safePhase });
    saveTaskState(ctx.taskStatePath, before);
    fs.writeFileSync(ctx.inputFilePath, JSON.stringify(validInput({ taskId: "NEW-TASK" })), "utf8");

    const result = runPlan({ ...ctx, replace: true });

    assert.equal(result.ok, true, `expected replacement to succeed while existing task is ${safePhase}`);
    assert.equal(result.replaced, true);
    assert.equal(result.previousTaskId, "OLD-TASK");
    assert.equal(result.state?.taskId, "NEW-TASK");
    assert.equal(result.state?.phase, "PLANNED");

    const after = loadTaskState(ctx.taskStatePath);
    assert.equal(after.taskId, "NEW-TASK");
  }
});

test("runPlan never needs --replace when there is no existing active task", () => {
  const { ctx } = tempWorkspace();
  fs.writeFileSync(ctx.inputFilePath, JSON.stringify(validInput()), "utf8");

  const result = runPlan({ ...ctx, replace: false });

  assert.equal(result.ok, true);
  assert.equal(result.replaced, false);
  assert.equal(result.previousTaskId, null);
});

test("runPlan preserves the supplied scope, requestedChanges, and approvalRequirements verbatim", () => {
  const { ctx } = tempWorkspace();
  fs.writeFileSync(
    ctx.inputFilePath,
    JSON.stringify(
      validInput({
        scope: "very specific scope string",
        requestedChanges: ["one", "two", "three"],
        approvalRequirements: ["git commit", "git push"],
      }),
    ),
    "utf8",
  );

  const result = runPlan(ctx);

  assert.equal(result.ok, true);
  assert.equal(result.state?.scope, "very specific scope string");
  assert.deepEqual(result.state?.requestedChanges, ["one", "two", "three"]);
  assert.deepEqual(result.state?.approvalRequirements, ["git commit", "git push"]);
});

test("runPlan never writes anything beyond the three configured control-plane paths", () => {
  const { ctx, dir } = tempWorkspace();
  fs.writeFileSync(ctx.inputFilePath, JSON.stringify(validInput()), "utf8");

  runPlan(ctx);

  const entries = fs.readdirSync(dir).sort();
  // Only the input file plus the three files runPlan is configured to write.
  assert.deepEqual(entries, ["ACTIVE_TASK.md", "BUILD_LOG.md", "TASK_STATE.json", "task.json"]);
});
