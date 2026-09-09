import { TASK_STATE_PATH } from "../config.js";
import { approveTask, loadTaskState, saveTaskState } from "../lib/taskState.js";

export interface RunApproveResult {
  ok: boolean;
  message: string;
}

// Loads the real on-disk task state, attempts to approve it, and -- only on
// success -- writes the updated state back. This command never commits,
// pushes, or deploys anything; it only flips APPROVAL_REQUIRED -> APPROVED
// so that a later, separate step could act on that approval.
export function runApprove(): RunApproveResult {
  const state = loadTaskState(TASK_STATE_PATH);
  const result = approveTask(state);

  if (result.ok) {
    saveTaskState(TASK_STATE_PATH, result.state);
  }

  return { ok: result.ok, message: result.message };
}
