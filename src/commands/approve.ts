import fs from "node:fs";
import { ACTIVE_TASK_PATH, BUILD_LOG_PATH, TASK_STATE_PATH } from "../config.js";
import { formatActiveTaskMarkdown, prependBuildLogEntry } from "../lib/plan.js";
import { approveTask, loadTaskState, saveTaskState, type TaskPhase, type TaskState } from "../lib/taskState.js";

// Paths are injectable (mirroring PlanContext/ExecuteContext in
// src/lib/plan.ts / src/lib/execution.ts) so tests can exercise the full
// TASK_STATE.json + ACTIVE_TASK.md + BUILD_LOG.md write behavior against a
// temp directory, never the real .cookvideo/ files. `cookvideo-agent
// approve` (src/cli.ts) calls this with no arguments, which resolves to the
// real configured paths.
export interface ApproveContext {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
}

const DEFAULT_APPROVE_CONTEXT: ApproveContext = {
  taskStatePath: TASK_STATE_PATH,
  activeTaskPath: ACTIVE_TASK_PATH,
  buildLogPath: BUILD_LOG_PATH,
};

export interface RunApproveResult {
  ok: boolean;
  message: string;
}

function approveBuildLogEntry(state: TaskState, previousPhase: TaskPhase): string {
  return [
    `## ${new Date().toISOString().slice(0, 10)} — Task approved via \`cookvideo-agent approve\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Phase: ${previousPhase} -> ${state.phase}; approvalStatus: ${state.approvalStatus}.`,
    "- No commit, push, or deployment was performed -- approval only unlocks those actions for a",
    "  later step.",
    "",
  ].join("\n");
}

// Loads the real on-disk task state, attempts to approve it, and -- only
// when the attempt actually changed the state (never on a refusal or an
// already-APPROVED no-op, both of which return the exact same state
// reference they were given) -- writes TASK_STATE.json, ACTIVE_TASK.md, and
// a BUILD_LOG.md entry, using the same helpers `plan`/`reset` already use so
// the three documents can never be left disagreeing with each other. This
// command never edits CookVideo, never runs git commit/push, and never
// deploys anything.
export function runApprove(ctx: ApproveContext = DEFAULT_APPROVE_CONTEXT): RunApproveResult {
  const state = loadTaskState(ctx.taskStatePath);
  const previousPhase = state.phase;
  const result = approveTask(state);

  if (result.state !== state) {
    saveTaskState(ctx.taskStatePath, result.state);
    fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(result.state), "utf8");
    prependBuildLogEntry(ctx.buildLogPath, approveBuildLogEntry(result.state, previousPhase));
  }

  return { ok: result.ok, message: result.message };
}
