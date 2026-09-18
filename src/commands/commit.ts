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
import { buildCommitMessage, runCommitWrite, type RunCommitResult } from "../lib/gitWrite.js";
import { loadTaskState } from "../lib/taskState.js";

// Wires real configuration (config.ts) into a GitWriteContext and delegates
// to the pure orchestration in src/lib/gitWrite.ts, mirroring
// src/commands/execute.ts's split between wiring and orchestration.
//
// Unlike `execute --target`, the target here is not CLI-selectable: it is
// always GIT_WRITE_TARGET_NAME ("CookVideo"), resolved through the existing
// EXECUTION_TARGETS registry. This is deliberate -- see
// .cookvideo/DECISIONS.md -- so no invocation of this command can ever point
// a real git write at CookVideoAgent's own repository.
export function runCommitCommand(executeFlag: boolean): RunCommitResult {
  const target = resolveExecutionTarget(GIT_WRITE_TARGET_NAME);
  if (target === null) {
    const state = loadTaskState(TASK_STATE_PATH);
    return {
      ok: false,
      dryRun: true,
      state,
      message:
        `The "${GIT_WRITE_TARGET_NAME}" execution target is not configured (known targets: ` +
        `${listExecutionTargetNames().join(", ")}). See .cookvideo/EXECUTION_POLICY.md.`,
      commitMessage: buildCommitMessage(state),
      filesStaged: null,
      commitHash: null,
    };
  }

  return runCommitWrite({
    taskStatePath: TASK_STATE_PATH,
    activeTaskPath: ACTIVE_TASK_PATH,
    buildLogPath: BUILD_LOG_PATH,
    gitWriteLogPath: GIT_WRITE_LOG_PATH,
    gitWriteMode: GIT_WRITE_MODE,
    executeFlag,
    cwd: target.path,
  });
}

export function formatCommitReport(result: RunCommitResult): string {
  const lines: string[] = ["CookVideo Agent -- commit", ""];
  lines.push(`Task ID: ${result.state.taskId ?? "(none)"}`);
  lines.push(`Phase:   ${result.state.phase}`);
  lines.push("");
  lines.push("Commit message (deterministic -- not overridable in this milestone):");
  lines.push(`  Subject: ${result.commitMessage.subject}`);
  lines.push(`  Body:    ${result.commitMessage.body}`);
  lines.push("");
  if (result.filesStaged !== null) {
    lines.push("Files staged:");
    lines.push(
      result.filesStaged.length > 0 ? result.filesStaged.map((f) => `  - ${f}`).join("\n") : "  (none)",
    );
    lines.push("");
  }
  if (result.dryRun) {
    lines.push(`DRY-RUN MODE: ${result.message}`);
    lines.push("No commit was created. CookVideo was not touched.");
  } else {
    lines.push(`${result.ok ? "COMMIT SUCCEEDED" : "COMMIT FAILED"}: ${result.message}`);
    if (result.commitHash !== null) {
      lines.push(`  commit hash: ${result.commitHash}`);
    }
  }
  return lines.join("\n");
}
