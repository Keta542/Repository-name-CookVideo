import { TASK_STATE_PATH } from "../config.js";
import { resetTaskState, saveTaskState } from "../lib/taskState.js";

export interface RunResetResult {
  message: string;
}

// Overwrites TASK_STATE.json with a fresh EMPTY_TASK_STATE. Never touches
// anything else -- no source files, no other .cookvideo documents, and
// nothing in the CookVideo repository.
export function runReset(): RunResetResult {
  const empty = resetTaskState();
  saveTaskState(TASK_STATE_PATH, empty);
  return {
    message: "Task state reset to empty (phase: PLANNED, no active task). No files were deleted.",
  };
}
