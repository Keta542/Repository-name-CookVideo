import fs from "node:fs";
import { ACTIVE_TASK_PATH, TASK_STATE_PATH } from "../config.js";
import { formatActiveTaskMarkdown } from "../lib/plan.js";
import { resetTaskState, saveTaskState } from "../lib/taskState.js";

export interface RunResetResult {
  message: string;
}

// Overwrites TASK_STATE.json with a fresh EMPTY_TASK_STATE, and -- since
// Milestone 4's `plan` command started actually writing real task content
// into ACTIVE_TASK.md -- also rewrites ACTIVE_TASK.md back to its "no active
// task" form via the same renderer `plan` uses (src/lib/plan.ts), so the two
// can never be left disagreeing with each other after a reset. Never touches
// anything else -- no source files, no other .cookvideo document, and
// nothing in the CookVideo repository.
export function runReset(): RunResetResult {
  const empty = resetTaskState();
  saveTaskState(TASK_STATE_PATH, empty);
  fs.writeFileSync(ACTIVE_TASK_PATH, formatActiveTaskMarkdown(empty), "utf8");
  return {
    message:
      "Task state reset to empty (phase: PLANNED, no active task). ACTIVE_TASK.md reset to match. " +
      "No files were deleted.",
  };
}
