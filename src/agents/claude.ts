import { spawn } from "node:child_process";
import type { RiskLevel } from "../lib/taskState.js";

// ---------------------------------------------------------------------------
// Claude execution adapter
//
// This is the first controlled bridge between CookVideoAgent and Claude Code.
// It is deliberately NOT a clipboard/chat-window automation system -- it is a
// command/process boundary: given a task, it prepares a structured brief and
// describes (or, only when explicitly allowed, actually runs) a single local
// process invocation. Everything about *whether* that process is allowed to
// run is decided by the caller (src/lib/execution.ts) before this module is
// ever asked to invoke anything; this module itself has no opinion about
// dry-run vs. local mode.
// ---------------------------------------------------------------------------

// A structured description of the work Claude is being asked to do, built
// entirely from this task's recorded state -- never invented. Every field
// here should trace back to something already present in TASK_STATE.json.
export interface ImplementationBrief {
  taskId: string;
  objective: string;
  scope: string;
  filesExpectedToChange: string[];
  testsRequired: string[];
  riskLevel: RiskLevel | null;
  approvalStatus: string;
}

// The exact local process invocation this adapter would run (or, in local
// mode, does run) for a given brief. `command`/`args`/`cwd` map directly onto
// node:child_process.spawn's own arguments -- kept as plain data so it can be
// printed verbatim in dry-run mode without any risk of the printed form
// diverging from what would actually execute.
export interface ClaudeExecutionCommand {
  command: string;
  args: string[];
  cwd: string;
}

export interface ClaudeExecutionResult {
  command: ClaudeExecutionCommand;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
  // Set when the process could not even be started (command not found,
  // permission denied, etc.) rather than when it ran and exited non-zero --
  // that distinction matters to callers deciding how to report failure.
  spawnError: string | null;
}

export interface BuildClaudeCommandOptions {
  claudeCommand: string;
  briefFilePath: string;
  cwd: string;
}

// Pure and side-effect-free: turns configuration + a prepared brief file path
// into the exact command that would be invoked. Kept separate from
// invokeClaude so dry-run mode can show this without ever touching
// child_process, and so it's trivially unit-testable.
export function buildClaudeCommand(options: BuildClaudeCommandOptions): ClaudeExecutionCommand {
  return {
    command: options.claudeCommand,
    args: [options.briefFilePath],
    cwd: options.cwd,
  };
}

// Renders an ImplementationBrief as the markdown document that gets written
// to disk and pointed at by the Claude command's arguments. Uncertain or
// unset fields are rendered as explicit placeholders ("(not set)") rather
// than omitted or guessed -- this brief is meant to be exactly what the task
// record says, nothing invented on top of it.
export function formatImplementationBrief(brief: ImplementationBrief): string {
  const lines: string[] = [
    `# Implementation brief: ${brief.taskId}`,
    "",
    "## Objective",
    "",
    brief.objective,
    "",
    "## Scope",
    "",
    brief.scope,
    "",
    "## Files expected to change",
    "",
    brief.filesExpectedToChange.length > 0
      ? brief.filesExpectedToChange.map((f) => `- ${f}`).join("\n")
      : "(none listed)",
    "",
    "## Tests required",
    "",
    brief.testsRequired.length > 0
      ? brief.testsRequired.map((t) => `- ${t}`).join("\n")
      : "(none listed)",
    "",
    "## Risk level",
    "",
    brief.riskLevel ?? "(not set)",
    "",
    "## Approval status",
    "",
    brief.approvalStatus,
    "",
  ];
  return lines.join("\n");
}

// Spawns the given command and captures its full output. Deliberately never
// rejects and never throws -- every possible outcome (clean exit, non-zero
// exit, signal termination, or the process failing to start at all) is
// reported as data in the resolved ClaudeExecutionResult, the same
// never-throws philosophy src/lib/git.ts uses for git invocations. Callers
// (src/lib/execution.ts) decide what a given exit code or spawnError means;
// this function only observes and reports.
export function invokeClaude(command: ClaudeExecutionCommand): Promise<ClaudeExecutionResult> {
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    let child;
    try {
      child = spawn(command.command, command.args, {
        cwd: command.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        command,
        exitCode: null,
        stdout: "",
        stderr: "",
        startedAt,
        finishedAt: new Date().toISOString(),
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      resolve({
        command,
        exitCode: null,
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date().toISOString(),
        spawnError: err instanceof Error ? err.message : String(err),
      });
    });

    child.on("close", (code) => {
      resolve({
        command,
        exitCode: code,
        stdout,
        stderr,
        startedAt,
        finishedAt: new Date().toISOString(),
        spawnError: null,
      });
    });
  });
}
