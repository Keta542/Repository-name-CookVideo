import fs from "node:fs";
import { ACTIVE_TASK_PATH, TASK_HISTORY_PATH, TASK_STATE_PATH } from "../config.js";
import { formatActiveTaskMarkdown } from "../lib/plan.js";
import { appendTaskHistoryEntry } from "../lib/taskHistory.js";
import { loadTaskState, resetTaskState, saveTaskState } from "../lib/taskState.js";

// Paths are injectable (mirroring ApproveContext/AdvanceContext) so tests
// can exercise the full archive + reset behavior against a temp directory,
// never the real .cookvideo/ files. `cookvideo-agent reset` (src/cli.ts)
// calls this with no arguments, which resolves to the real configured paths.
export interface ResetContext {
  taskStatePath: string;
  activeTaskPath: string;
  taskHistoryPath: string;
}

const DEFAULT_RESET_CONTEXT: ResetContext = {
  taskStatePath: TASK_STATE_PATH,
  activeTaskPath: ACTIVE_TASK_PATH,
  taskHistoryPath: TASK_HISTORY_PATH,
};

export interface RunResetResult {
  message: string;
  archived: boolean;
}

// Overwrites TASK_STATE.json with a fresh EMPTY_TASK_STATE, and -- since
// Milestone 4's `plan` command started actually writing real task content
// into ACTIVE_TASK.md -- also rewrites ACTIVE_TASK.md back to its "no active
// task" form via the same renderer `plan` uses (src/lib/plan.ts), so the two
// can never be left disagreeing with each other after a reset.
//
// Before either of those writes (Milestone 11): if there is a currently
// active task, its full state is archived to .cookvideo/TASK_HISTORY.json
// first -- reset previously discarded that record permanently, with nothing
// surviving except whatever BUILD_LOG.md prose happened to be written along
// the way. A reset on an already-empty state (no active task) archives
// nothing -- there is nothing to preserve.
//
// Never touches anything else -- no source files, no other .cookvideo
// document, and nothing in the CookVideo repository.
export function runReset(ctx: ResetContext = DEFAULT_RESET_CONTEXT): RunResetResult {
  const current = loadTaskState(ctx.taskStatePath);
  const archived = current.taskId !== null;
  if (archived) {
    appendTaskHistoryEntry(ctx.taskHistoryPath, current, "reset");
  }

  const empty = resetTaskState();
  saveTaskState(ctx.taskStatePath, empty);
  fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(empty), "utf8");

  return {
    message:
      "Task state reset to empty (phase: PLANNED, no active task). ACTIVE_TASK.md reset to match. " +
      (archived
        ? `Task ${current.taskId ?? "(unknown)"} (was ${current.phase}) was archived to ` +
          ".cookvideo/TASK_HISTORY.json before being cleared. "
        : "") +
      "No files were deleted.",
    archived,
  };
}
