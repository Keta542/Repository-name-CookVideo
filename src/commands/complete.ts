import fs from "node:fs";
import { ACTIVE_TASK_PATH, BUILD_LOG_PATH, TASK_STATE_PATH } from "../config.js";
import { formatActiveTaskMarkdown, prependBuildLogEntry } from "../lib/plan.js";
import {
  completeTask,
  loadTaskState,
  saveTaskState,
  type CompleteOptions,
  type TaskPhase,
  type TaskState,
} from "../lib/taskState.js";

export interface RunCompleteResult {
  ok: boolean;
  message: string;
}

// Paths are injectable (mirroring PlanContext/ExecuteContext in
// src/lib/plan.ts / src/lib/execution.ts) so tests can exercise the full
// TASK_STATE.json + ACTIVE_TASK.md + BUILD_LOG.md write behavior against a
// temp directory, never the real .cookvideo/ files. `cookvideo-agent
// complete` (src/cli.ts) calls this with only `options`, which resolves the
// context to the real configured paths.
export interface CompleteContext {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
}

const DEFAULT_COMPLETE_CONTEXT: CompleteContext = {
  taskStatePath: TASK_STATE_PATH,
  activeTaskPath: ACTIVE_TASK_PATH,
  buildLogPath: BUILD_LOG_PATH,
};

// Parses the arguments for `cookvideo-agent complete [--commit <hash>]`.
// Kept as its own pure function (rather than inlined in src/cli.ts, as the
// other commands' flag parsing is) so it stays unit-testable: importing
// src/cli.ts itself triggers process.exit as a side effect of module load,
// so nothing in that file can safely be imported from a test.
export function parseCompleteCliArgs(rest: string[]): CompleteOptions {
  const commitFlagIndex = rest.indexOf("--commit");
  const commitHash = commitFlagIndex !== -1 ? rest[commitFlagIndex + 1] : undefined;
  return commitHash !== undefined ? { commitHash } : {};
}

function completeBuildLogEntry(state: TaskState, previousPhase: TaskPhase): string {
  const lines: string[] = [
    `## ${new Date().toISOString().slice(0, 10)} — Task updated via \`cookvideo-agent complete\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Phase: ${previousPhase} -> ${state.phase}; approvalStatus: ${state.approvalStatus}.`,
  ];
  if (state.phase === "COMPLETED") {
    lines.push(`- Result: ${state.result ?? "Completed."}`);
  } else {
    lines.push(
      "- This task requires human approval before it can be completed (see",
      "  .cookvideo/APPROVAL_POLICY.md); run `cookvideo-agent approve` once reviewed, then re-run",
      "  `cookvideo-agent complete`.",
    );
  }
  lines.push(
    "- No files were edited, and no commit, push, or deployment was performed by this command.",
    "",
  );
  return lines.join("\n");
}

// Loads the real on-disk task state, attempts to complete it, and -- only
// when the attempt actually changed the state (never on a refusal or an
// already-COMPLETED no-op, both of which return the exact same state
// reference they were given) -- writes TASK_STATE.json, ACTIVE_TASK.md, and
// a BUILD_LOG.md entry, using the same helpers `plan`/`reset` already use so
// the three documents can never be left disagreeing with each other. This is
// true whether the task actually reached COMPLETED or was instead moved into
// APPROVAL_REQUIRED/PENDING by the risk/approval gate (src/lib/taskState.ts)
// -- either way this command never edits CookVideo, never runs git
// commit/push, and never deploys anything. It only records that already-done
// work is done, or that it now needs a human's approval before it can be.
export function runComplete(
  options: CompleteOptions = {},
  ctx: CompleteContext = DEFAULT_COMPLETE_CONTEXT,
): RunCompleteResult {
  const state = loadTaskState(ctx.taskStatePath);
  const previousPhase = state.phase;
  const result = completeTask(state, options);

  if (result.state !== state) {
    saveTaskState(ctx.taskStatePath, result.state);
    fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(result.state), "utf8");
    prependBuildLogEntry(ctx.buildLogPath, completeBuildLogEntry(result.state, previousPhase));
  }

  return { ok: result.ok, message: result.message };
}
