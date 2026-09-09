import { EMPTY_TASK_STATE, type TaskState } from "../../lib/taskState.js";

// A deliberately harmless, obviously-fake task used only by the test suite
// (src/__tests__/execution.test.ts) to exercise the execution module without
// ever referring to anything real in the CookVideo repository. Never written
// to the real .cookvideo/TASK_STATE.json -- tests that use this always write
// it to a temp file (see tempStatePath() in taskState.test.ts /
// execution.test.ts).
export function harmlessTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "TEST-HARMLESS-001",
    objective: "Add a code comment to a scratch fixture file. No behavior change.",
    scope: "test-fixtures/scratch/ only -- never CookVideo, never production systems.",
    phase: "IMPLEMENTING",
    riskLevel: "LOW",
    approvalStatus: "NOT_REQUIRED",
    filesExpectedToChange: ["test-fixtures/scratch/example.txt"],
    testsRequired: ["none -- comment-only change"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
