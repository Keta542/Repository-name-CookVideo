import {
  ACTIVE_TASK_PATH,
  BUILD_LOG_PATH,
  GIT_WRITE_LOG_PATH,
  GIT_WRITE_MODE,
  GIT_WRITE_TARGET_NAME,
  TASK_STATE_PATH,
  listExecutionTargetNames,
  resolveExecutionTarget,
} from "../config.js";
import { runPushWrite, type RunPushResult } from "../lib/gitWrite.js";
import { loadTaskState } from "../lib/taskState.js";

// Wires real configuration into a GitWriteContext and delegates to the pure
// orchestration in src/lib/gitWrite.ts. Mirrors src/commands/commit.ts
// exactly, including the hardcoded (never CLI-selectable) CookVideo target --
// see that file's comment and .cookvideo/DECISIONS.md.
//
// Deliberately never invoked by runCommitCommand, and never invokes it --
// commit and push are separate explicit actions with separate --execute
// flags, never chained automatically.
export function runPushCommand(executeFlag: boolean): RunPushResult {
  const target = resolveExecutionTarget(GIT_WRITE_TARGET_NAME);
  if (target === null) {
    return {
      ok: false,
      dryRun: true,
      state: loadTaskState(TASK_STATE_PATH),
      message:
        `The "${GIT_WRITE_TARGET_NAME}" execution target is not configured (known targets: ` +
        `${listExecutionTargetNames().join(", ")}). See .cookvideo/EXECUTION_POLICY.md.`,
      pushedCommitHash: null,
    };
  }

  return runPushWrite({
    taskStatePath: TASK_STATE_PATH,
    activeTaskPath: ACTIVE_TASK_PATH,
    buildLogPath: BUILD_LOG_PATH,
    gitWriteLogPath: GIT_WRITE_LOG_PATH,
    gitWriteMode: GIT_WRITE_MODE,
    executeFlag,
    cwd: target.path,
  });
}

export function formatPushReport(result: RunPushResult): string {
  const lines: string[] = ["CookVideo Agent -- push", ""];
  lines.push(`Task ID: ${result.state.taskId ?? "(none)"}`);
  lines.push(`Phase:   ${result.state.phase}`);
  lines.push("");
  if (result.dryRun) {
    lines.push(`DRY-RUN MODE: ${result.message}`);
    lines.push("No push was performed. CookVideo's remote was not touched.");
  } else {
    lines.push(`${result.ok ? "PUSH SUCCEEDED" : "PUSH FAILED"}: ${result.message}`);
    if (result.pushedCommitHash !== null) {
      lines.push(`  pushed commit hash: ${result.pushedCommitHash}`);
    }
  }
  return lines.join("\n");
}
