import {
  ACTIVE_TASK_PATH,
  BUILD_LOG_PATH,
  TASK_STATE_PATH,
  TEST_LOG_PATH,
  TEST_MODE,
  TEST_TARGET_NAME,
  listExecutionTargetNames,
  resolveExecutionTarget,
} from "../config.js";
import { runTest, type RunTestResult } from "../lib/testRun.js";
import { loadTaskState } from "../lib/taskState.js";

// Wires real configuration (config.ts) into a TestRunContext and delegates
// to the pure orchestration in src/lib/testRun.ts, mirroring
// src/commands/commit.ts's/src/commands/push.ts's split between wiring and
// orchestration.
//
// Like GIT_WRITE_TARGET_NAME, the target here is not CLI-selectable: it is
// always TEST_TARGET_NAME ("CookVideo"), resolved through the existing
// EXECUTION_TARGETS registry -- so no invocation of this command can ever
// run a real test command against CookVideoAgent's own repository.
export function runTestCommand(executeFlag: boolean): RunTestResult {
  const target = resolveExecutionTarget(TEST_TARGET_NAME);
  if (target === null) {
    return {
      ok: false,
      dryRun: true,
      state: loadTaskState(TASK_STATE_PATH),
      message:
        `The "${TEST_TARGET_NAME}" execution target is not configured (known targets: ` +
        `${listExecutionTargetNames().join(", ")}). See .cookvideo/EXECUTION_POLICY.md.`,
      testCommand: null,
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }

  return runTest({
    taskStatePath: TASK_STATE_PATH,
    activeTaskPath: ACTIVE_TASK_PATH,
    buildLogPath: BUILD_LOG_PATH,
    testLogPath: TEST_LOG_PATH,
    testMode: TEST_MODE,
    executeFlag,
    cwd: target.path,
  });
}

export function formatTestReport(result: RunTestResult): string {
  const lines: string[] = ["CookVideo Agent -- test", ""];
  lines.push(`Task ID: ${result.state.taskId ?? "(none)"}`);
  lines.push(`Phase:   ${result.state.phase}`);
  lines.push("");
  if (result.testCommand !== null) {
    lines.push(`Test command: ${result.testCommand.join(" ")}`);
    lines.push("");
  }
  if (result.dryRun) {
    lines.push(`DRY-RUN MODE: ${result.message}`);
    lines.push("No tests were run. CookVideo was not touched.");
  } else {
    lines.push(`${result.ok ? "TESTS PASSED" : "TESTS FAILED"}: ${result.message}`);
    if (result.exitCode !== null) {
      lines.push(`  exit code: ${String(result.exitCode)}`);
    }
  }
  return lines.join("\n");
}
