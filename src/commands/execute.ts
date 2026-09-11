import {
  BRIEFS_DIR,
  CLAUDE_COMMAND,
  DEFAULT_EXECUTION_TARGET_NAME,
  EXECUTION_LOG_PATH,
  EXECUTION_MODE,
  TASK_STATE_PATH,
  listExecutionTargetNames,
  resolveExecutionTarget,
} from "../config.js";
import { runExecution, type RunExecuteResult } from "../lib/execution.js";
import { loadTaskState } from "../lib/taskState.js";

// Wires real configuration (config.ts) into an ExecuteContext and delegates
// to the pure orchestration in src/lib/execution.ts. `executeFlag` and
// `targetName` are passed in from CLI argument parsing (src/cli.ts) rather
// than read here, so this function stays a thin, testable wiring layer with
// no argv parsing of its own.
//
// `targetName` selects which approved repository (src/config.ts's
// EXECUTION_TARGETS) Claude's working directory will be. It defaults to
// this control plane's own repository -- the only target that existed
// before Milestone 4 -- so an execute invocation that doesn't name a target
// behaves exactly as it always has. An unrecognized name is refused here,
// before runExecution (and therefore before any process could be spawned):
// this control plane will never fall back to an arbitrary or guessed path.
export async function runExecuteCommand(
  executeFlag: boolean,
  targetName: string = DEFAULT_EXECUTION_TARGET_NAME,
): Promise<RunExecuteResult> {
  const target = resolveExecutionTarget(targetName);
  if (target === null) {
    return {
      ok: false,
      dryRun: true,
      state: loadTaskState(TASK_STATE_PATH),
      brief: null,
      briefFilePath: null,
      command: null,
      result: null,
      message:
        `Unknown execution target "${targetName}". Approved targets: ` +
        `${listExecutionTargetNames().join(", ")}. See .cookvideo/EXECUTION_POLICY.md.`,
      targetMismatch: null,
    };
  }

  return runExecution({
    taskStatePath: TASK_STATE_PATH,
    executionLogPath: EXECUTION_LOG_PATH,
    briefsDir: BRIEFS_DIR,
    claudeCommand: CLAUDE_COMMAND,
    executionMode: EXECUTION_MODE,
    executeFlag,
    cwd: target.path,
  });
}

function formatCommand(result: RunExecuteResult): string {
  if (result.command === null) {
    return "(no command constructed)";
  }
  const argsRendered = result.command.args.map((a) => JSON.stringify(a)).join(" ");
  return `${result.command.command} ${argsRendered}\n  (cwd: ${result.command.cwd})`;
}

// The CLI-facing report for `cookvideo-agent execute`. Prints, in order:
// task objective, allowed scope, expected files, required tests, approval
// requirements, the exact command that would be (or was) invoked, and a
// clear, unambiguous statement of whether dry-run mode prevented execution.
export function formatExecuteReport(result: RunExecuteResult): string {
  const lines: string[] = ["CookVideo Agent -- execute", ""];

  if (result.targetMismatch !== null) {
    lines.push(result.message);
    lines.push("");
    lines.push("Target mismatch:");
    lines.push(`  Selected target repository: ${result.targetMismatch.targetPath}`);
    lines.push("  Missing expected path(s):");
    lines.push(result.targetMismatch.missingPaths.map((p) => `    - ${p}`).join("\n"));
    lines.push("");
    lines.push(
      "Human approval is required before changing the execution target or this task's " +
        "expected files. No implementation brief was written and Claude was not invoked.",
    );
    return lines.join("\n");
  }

  if (result.brief === null) {
    lines.push(result.message);
    return lines.join("\n");
  }

  const { brief } = result;

  lines.push(`Task ID:           ${brief.taskId}`);
  lines.push(`Phase:             ${result.state.phase}`);
  lines.push("");
  lines.push("Objective:");
  lines.push(`  ${brief.objective}`);
  lines.push("");
  lines.push("Allowed scope:");
  lines.push(`  ${brief.scope}`);
  lines.push("");
  lines.push("Expected files:");
  lines.push(
    brief.filesExpectedToChange.length > 0
      ? brief.filesExpectedToChange.map((f) => `  - ${f}`).join("\n")
      : "  (none listed)",
  );
  lines.push("");
  lines.push("Required tests:");
  lines.push(
    brief.testsRequired.length > 0
      ? brief.testsRequired.map((t) => `  - ${t}`).join("\n")
      : "  (none listed)",
  );
  lines.push("");
  lines.push(`Approval requirements: approvalStatus=${brief.approvalStatus} (risk: ${brief.riskLevel ?? "not set"})`);
  lines.push(`Implementation brief written to: ${result.briefFilePath}`);
  lines.push("");
  lines.push("Claude execution command (what would be, or was, invoked):");
  lines.push(`  ${formatCommand(result)}`);
  lines.push("");

  if (result.dryRun) {
    lines.push(`DRY-RUN MODE: ${result.message}`);
    lines.push("No external process was executed. CookVideo was not touched.");
  } else if (result.result !== null) {
    lines.push(`LOCAL EXECUTION: ${result.message}`);
    lines.push(`  exit code: ${String(result.result.exitCode)}`);
    if (result.result.spawnError !== null) {
      lines.push(`  spawn error: ${result.result.spawnError}`);
    }
    lines.push(`  stdout (${result.result.stdout.length} chars), stderr (${result.result.stderr.length} chars) captured.`);
  }

  return lines.join("\n");
}
