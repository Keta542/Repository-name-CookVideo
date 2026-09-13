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
//
// `input` is the implementation brief's rendered contents, written to the
// child process's stdin rather than appended to `args`. A command-line
// argument on Windows has to survive both Node's own argv-escaping *and*
// cmd.exe's line parsing (required to invoke a .cmd shim -- see
// resolveSpawnOptions), and cmd.exe treats `&`, `|`, `<`, `>` and `^` as
// control characters even inside a quoted argument. An implementation
// brief's free-text objective/scope can easily contain any of those, so
// putting it in argv would silently truncate or corrupt Claude's actual
// instructions on Windows. Piping it over stdin sidesteps shell parsing
// entirely, and matches Claude Code's own `-p`/`--print` flag, which its
// `--help` output documents as "useful for pipes".
export interface ClaudeExecutionCommand {
  command: string;
  args: string[];
  cwd: string;
  input: string;
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
  briefContent: string;
  cwd: string;
}

// Pure and side-effect-free: turns configuration + the brief's actual
// rendered contents into the exact command that would be invoked. Kept
// separate from invokeClaude so dry-run mode can show this without ever
// touching child_process, and so it's trivially unit-testable.
//
// This previously passed only the brief's file path as the invocation's sole
// argument (`args: [briefFilePath]`), which handed Claude Code a bare string
// it had no instruction to open or read -- `claude <path>` is not a "read
// this file" command. Combined with running in Claude Code's default
// interactive mode against a closed stdin (see resolveSpawnOptions), that
// produced a process that exited 0 having done nothing.
//
// The fix is `-p`/`--print`, Claude Code's documented non-interactive mode
// ("useful for pipes" per its own --help text), fed the brief's actual
// rendered contents over stdin (see the ClaudeExecutionCommand.input doc
// comment for why stdin and not argv). The brief file itself is still
// written to disk by the caller (src/lib/execution.ts) purely for
// auditability -- this function has no opinion about that and never reads
// it back.
//
// `--permission-mode acceptEdits` is paired with `-p` so the non-interactive
// run can actually make the file edits it's asked for: Claude Code's default
// permission mode prompts interactively for each edit, and with stdin/stdout
// wired to a pipe (see resolveSpawnOptions) rather than a TTY, there is no
// terminal to prompt at -- the process would hang or reject the edit instead
// of applying it. acceptEdits is the documented mode for exactly this case
// (auto-accepts file edits while leaving other permission classes, e.g.
// shell command execution, gated). This is deliberately not
// `bypassPermissions`, which also lifts those other gates -- the whole point
// of this adapter is that *this module* decides nothing about what Claude is
// allowed to do beyond "edit the files it was asked to edit"; every other
// safety property (dry-run vs. local mode, target validation, postcondition
// verification) is still enforced by the caller (src/lib/execution.ts).
export function buildClaudeCommand(options: BuildClaudeCommandOptions): ClaudeExecutionCommand {
  return {
    command: options.claudeCommand,
    args: ["-p", "--permission-mode", "acceptEdits"],
    cwd: options.cwd,
    input: options.briefContent,
  };
}

// Renders an ImplementationBrief as the markdown document that gets written
// to disk for auditability and fed to Claude as the Claude command's stdin
// (see ClaudeExecutionCommand.input). Uncertain or unset fields are rendered
// as explicit placeholders ("(not set)") rather than omitted or guessed --
// this brief is meant to be exactly what the task record says, nothing
// invented on top of it.
export function formatImplementationBrief(brief: ImplementationBrief): string {
  const lines: string[] = [
    `# Implementation brief: ${brief.taskId}`,
    "",
    `Implement the following task now, in this repository. Use your file tools ` +
      `to inspect and edit the expected files listed below -- do not merely ` +
      `describe what should be changed. After completing the implementation, ` +
      `summarize what changed.`,
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

// On Windows, Node's child_process.spawn refuses to execute .bat/.cmd files directly
// without shell: true -- it throws EINVAL rather than starting the process. This is
// documented Node.js behavior (a deliberate security hardening related to
// CVE-2024-27980, closing a command-injection vector), not a bug in how the command is
// configured. It applies no matter which command string is in play -- the platform-aware
// default from src/config.ts's resolveDefaultClaudeCommand, or a
// COOKVIDEO_AGENT_CLAUDE_COMMAND override -- so the fix is a blanket shell: true gated on
// platform, not a special case for any particular command. Exposed as its own pure
// function (parameterized on platform, same pattern as resolveDefaultClaudeCommand) so
// it's directly unit-testable without mocking process.platform or reloading the module.
//
// stdin is piped (not ignored) on every platform: the implementation brief's contents
// are written to it by invokeClaude below rather than passed as an argv value -- see the
// ClaudeExecutionCommand.input doc comment for why.
export function resolveSpawnOptions(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): { cwd: string; stdio: ["pipe", "pipe", "pipe"]; shell: boolean } {
  return {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: platform === "win32",
  };
}

// When shell is true, Node hands `command` and `args` to cmd.exe *without* escaping or
// quoting them itself -- they are simply concatenated with spaces (Node emits DEP0190
// warning about exactly this). An unquoted value containing whitespace (a custom
// COOKVIDEO_AGENT_CLAUDE_COMMAND path, or -- in this module's own tests -- a Node install
// path like "C:\Program Files\nodejs\node.exe") then gets split at the space and fails to
// resolve. Quoting is intentionally limited to whitespace/quote characters rather than a
// general shell-metacharacter escaper: the values that ever reach this function are our
// own configured executable path and a small set of static, metacharacter-free flags
// (e.g. "-p", "--permission-mode", "acceptEdits") -- never arbitrary or attacker-controlled text, since the brief's actual
// free-text content travels over stdin instead (see ClaudeExecutionCommand.input).
function quoteForWindowsShell(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function invokeClaude(command: ClaudeExecutionCommand): Promise<ClaudeExecutionResult> {
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const options = resolveSpawnOptions(command.cwd);
    // With shell:false (every non-Windows platform), spawn's own argv handling is used
    // unchanged. With shell:true, command/args must be pre-quoted and merged into a
    // single command line ourselves -- see quoteForWindowsShell.
    const spawnCommand = options.shell
      ? [command.command, ...command.args].map(quoteForWindowsShell).join(" ")
      : command.command;
    const spawnArgs = options.shell ? [] : command.args;

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, options);
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

    // A process that fails to start (or exits immediately) can make writing to its
    // stdin raise EPIPE/EOF -- the child's own 'error'/'close' handlers below already
    // capture the real outcome, so this only needs to prevent an unhandled stream error.
    child.stdin?.on("error", () => {});

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

    child.stdin?.end(command.input);
  });
}
