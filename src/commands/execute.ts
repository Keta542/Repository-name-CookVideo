import {
  AGENT_ROOT,
  BRIEFS_DIR,
  CLAUDE_COMMAND,
  EXECUTION_LOG_PATH,
  EXECUTION_MODE,
  TASK_STATE_PATH,
} from "../config.js";
import { runExecution, type RunExecuteResult } from "../lib/execution.js";

// Wires real configuration (config.ts) into an ExecuteContext and delegates
// to the pure orchestration in src/lib/execution.ts. `executeFlag` is passed
// in from CLI argument parsing (src/cli.ts) rather than read here, so this
// function stays a thin, testable wiring layer with no argv parsing of its
// own.
export async function runExecuteCommand(executeFlag: boolean): Promise<RunExecuteResult> {
  return runExecution({
    taskStatePath: TASK_STATE_PATH,
    executionLogPath: EXECUTION_LOG_PATH,
    briefsDir: BRIEFS_DIR,
    claudeCommand: CLAUDE_COMMAND,
    executionMode: EXECUTION_MODE,
    executeFlag,
    cwd: AGENT_ROOT,
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
