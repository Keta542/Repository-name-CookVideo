import { ACTIVE_TASK_PATH, BUILD_LOG_PATH, TASK_HISTORY_PATH, TASK_STATE_PATH } from "../config.js";
import { runPlan, type RunPlanResult } from "../lib/plan.js";

export interface PlanCommandOptions {
  filePath: string;
  replace: boolean;
}

// Wires real configuration (config.ts) into a PlanContext and delegates to
// the pure orchestration in src/lib/plan.ts. argv parsing (--file, --replace)
// happens in src/cli.ts, not here, so this stays a thin, testable wiring
// layer -- matching the same pattern src/commands/execute.ts uses for
// src/lib/execution.ts.
export function runPlanCommand(options: PlanCommandOptions): RunPlanResult {
  return runPlan({
    taskStatePath: TASK_STATE_PATH,
    activeTaskPath: ACTIVE_TASK_PATH,
    buildLogPath: BUILD_LOG_PATH,
    taskHistoryPath: TASK_HISTORY_PATH,
    inputFilePath: options.filePath,
    replace: options.replace,
  });
}

// The CLI-facing report for `cookvideo-agent plan`. On failure, prints every
// validation error (or the existing-task/replacement-safety refusal message,
// which always names the existing task ID) and makes clear nothing was
// written. On success, prints the resulting task record.
export function formatPlanReport(result: RunPlanResult): string {
  const lines: string[] = ["CookVideo Agent -- plan", ""];

  if (!result.ok || result.state === null) {
    lines.push(result.message);
    if (result.errors.length > 0) {
      lines.push("");
      lines.push("Validation errors:");
      for (const error of result.errors) {
        lines.push(`  - ${error}`);
      }
    }
    if (result.previousTaskId !== null) {
      lines.push("");
      lines.push(`Existing task ID: ${result.previousTaskId} (phase: ${result.previousPhase ?? "unknown"})`);
    }
    return lines.join("\n");
  }

  const { state } = result;
  lines.push(result.message);
  lines.push("");
  lines.push(`Task ID:           ${state.taskId}`);
  lines.push(`Objective:         ${state.objective}`);
  lines.push(`Scope:             ${state.scope}`);
  lines.push(`Phase:             ${state.phase}`);
  lines.push(`Risk level:        ${state.riskLevel ?? "(not set)"}`);
  lines.push(`Approval status:   ${state.approvalStatus}`);
  lines.push(
    `Requested changes: ${state.requestedChanges.length > 0 ? state.requestedChanges.join(", ") : "(none)"}`,
  );
  lines.push(
    `Files expected to change: ${
      state.filesExpectedToChange.length > 0 ? state.filesExpectedToChange.join(", ") : "(none listed)"
    }`,
  );
  lines.push(
    `Tests required:    ${state.testsRequired.length > 0 ? state.testsRequired.join(", ") : "(none listed)"}`,
  );
  lines.push(
    `Approval requirements (anticipated): ${
      state.approvalRequirements.length > 0 ? state.approvalRequirements.join(", ") : "(none)"
    }`,
  );
  lines.push("");
  lines.push("Wrote .cookvideo/TASK_STATE.json, .cookvideo/ACTIVE_TASK.md, and a .cookvideo/BUILD_LOG.md entry.");
  lines.push("No CookVideo file was touched. No Claude process, git commit/push, or production-system");
  lines.push("action was performed.");

  return lines.join("\n");
}
