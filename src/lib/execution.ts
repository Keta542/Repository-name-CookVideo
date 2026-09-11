import fs from "node:fs";
import path from "node:path";
import {
  buildClaudeCommand,
  formatImplementationBrief,
  invokeClaude,
  type ClaudeExecutionCommand,
  type ClaudeExecutionResult,
  type ImplementationBrief,
} from "../agents/claude.js";
import { isValidTransition, loadTaskState, type TaskState } from "./taskState.js";
import type { ExecutionMode } from "../config.js";

// ---------------------------------------------------------------------------
// Task execution module (Milestone 3)
//
// This is the orchestration layer between the on-disk task state and the
// Claude adapter (src/agents/claude.ts). It is responsible for every
// decision about *whether* a run should touch a real process, and for
// leaving a durable record of what was decided and why. The adapter itself
// makes no such decisions -- it just builds commands and, if asked, runs
// them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Validation steps
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

// A task must actually exist (and have a taskId) before execution can be
// considered at all -- an empty/never-populated TASK_STATE.json is not an
// error condition in general (see loadTaskState), but it is not something
// `execute` can act on.
export function validateTaskExists(state: TaskState): ValidationResult {
  if (state.taskId === null) {
    return {
      ok: false,
      reason: "No active task. Run `cookvideo-agent task` to check current state, or record a task before executing.",
    };
  }
  return { ok: true };
}

// A task can be executed while it is already IMPLEMENTING (a run continuing
// or re-attempting implementation), or from any phase the lifecycle engine
// says can validly move into IMPLEMENTING next (PLANNED, or recovering from
// FAILED/BLOCKED). Anything else -- e.g. a task already in REVIEW,
// APPROVED, or a terminal phase -- is not a valid place to start an
// implementation execution from. This reuses the same transition table
// approve/reset are built on (src/lib/taskState.ts) rather than maintaining
// a second, separately-drifting notion of "which phases are executable."
export function validateExecutionTransition(state: TaskState): ValidationResult {
  if (state.phase === "IMPLEMENTING") {
    return { ok: true };
  }
  if (isValidTransition(state.phase, "IMPLEMENTING")) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Task is in phase ${state.phase}, which cannot move to IMPLEMENTING. Execution is only valid for a task that is already IMPLEMENTING, or in a phase that can transition there (e.g. PLANNED, FAILED, BLOCKED).`,
  };
}

// Execution here means "let Claude attempt the implementation work," which
// APPROVAL_POLICY.md classifies as AUTOMATIC (editing source, running local
// tests) -- it is not the same as commit/push/deploy, which stay gated by
// `cookvideo-agent approve` regardless of execution mode. The one thing this
// check refuses is a task a human has explicitly REJECTED: that is a stop
// sign the execution module must never drive past on its own.
export function checkApprovalForExecution(state: TaskState): ValidationResult {
  if (state.approvalStatus === "REJECTED") {
    return {
      ok: false,
      reason: `Task ${state.taskId ?? "(unknown)"} has approvalStatus REJECTED. Execution will not proceed until this is resolved (see .cookvideo/APPROVAL_POLICY.md).`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Target verification (stale/mismatched task targets)
// ---------------------------------------------------------------------------

// Resolves one of a task's filesExpectedToChange against the selected target
// repository's root. Returns null (treated the same as "missing" by
// validateExpectedTargets) rather than a path outside that root -- this
// check exists to catch a stale or mismatched task target, not to grant
// Claude any access it doesn't already have via the approved-targets
// allowlist in src/config.ts, and it must never itself be tricked by a
// "../" path into reporting something outside the repository as found.
function resolveExpectedTargetPath(cwd: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(cwd);
  const resolved = path.resolve(cwd, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  return resolved;
}

export interface ExpectedTargetsValidation {
  ok: boolean;
  missingPaths: string[];
}

// A task's filesExpectedToChange is the planner's own record of what should
// already exist in the selected target repository. If any of them are
// missing -- a stale task, a target repository picked in error, a typo in
// the planner's JSON -- this control plane must never let Claude quietly
// substitute a different file and proceed; see .cookvideo/EXECUTION_POLICY.md.
// An empty filesExpectedToChange list has nothing to verify and always
// passes, matching the existing "(none listed)" treatment elsewhere.
export function validateExpectedTargets(filesExpectedToChange: string[], cwd: string): ExpectedTargetsValidation {
  const missingPaths = filesExpectedToChange.filter((relativePath) => {
    const resolved = resolveExpectedTargetPath(cwd, relativePath);
    return resolved === null || !fs.existsSync(resolved);
  });
  return { ok: missingPaths.length === 0, missingPaths };
}

// ---------------------------------------------------------------------------
// Implementation brief
// ---------------------------------------------------------------------------

// Builds the brief purely from what TASK_STATE.json already records. Never
// invents an objective, scope, or file list that isn't already there --
// unset fields are rendered as explicit placeholders by
// formatImplementationBrief, not guessed here.
export function buildImplementationBrief(state: TaskState): ImplementationBrief {
  return {
    taskId: state.taskId ?? "(unknown)",
    objective: state.objective ?? "(not set -- no objective recorded for this task)",
    scope: state.scope ?? "(not set -- no scope recorded for this task)",
    filesExpectedToChange: state.filesExpectedToChange,
    testsRequired: state.testsRequired,
    riskLevel: state.riskLevel,
    approvalStatus: state.approvalStatus,
  };
}

// ---------------------------------------------------------------------------
// Execution log
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  timestamp: string;
  taskId: string | null;
  phase: TaskState["phase"];
  executionMode: ExecutionMode;
  executeFlagSet: boolean;
  dryRun: boolean;
  command: ClaudeExecutionCommand | null;
  briefFilePath: string | null;
  outcome: string;
  exitCode: number | null;
  spawnError: string | null;
}

function readExecutionLog(logPath: string): ExecutionRecord[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ExecutionRecord[]) : [];
  } catch {
    // A corrupt or unreadable log should never block execution reporting --
    // it's a diagnostic trail, not the source of truth (TASK_STATE.json is).
    return [];
  }
}

// Appends one record to the execution log, creating the file (and its
// containing directory) if this is the first execution ever recorded.
export function appendExecutionRecord(logPath: string, record: ExecutionRecord): void {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = readExecutionLog(logPath);
  existing.push(record);
  fs.writeFileSync(logPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ExecuteContext {
  taskStatePath: string;
  executionLogPath: string;
  briefsDir: string;
  claudeCommand: string;
  executionMode: ExecutionMode;
  executeFlag: boolean;
  cwd: string;
  // Injectable so tests can assert "never invoked" (dry-run safety) or
  // supply a mock result (success/failure) without spawning a real process.
  // Defaults to the real adapter's invokeClaude.
  invoke?: (command: ClaudeExecutionCommand) => Promise<ClaudeExecutionResult>;
}

// Produced instead of a normal refusal when the task's filesExpectedToChange
// don't exist in the selected target repository. Distinct from a plain
// `message` string so callers (src/commands/execute.ts, and tests) can
// assert on the missing paths and target repository directly, rather than
// pattern-matching prose -- and so the "human approval required" statement
// is a structured fact, not just wording that could drift.
export interface TargetMismatchInfo {
  missingPaths: string[];
  targetPath: string;
  requiresHumanApproval: true;
}

export interface RunExecuteResult {
  ok: boolean;
  dryRun: boolean;
  state: TaskState;
  brief: ImplementationBrief | null;
  briefFilePath: string | null;
  command: ClaudeExecutionCommand | null;
  result: ClaudeExecutionResult | null;
  message: string;
  // null except in the one scenario where filesExpectedToChange failed
  // target verification -- see validateExpectedTargets.
  targetMismatch: TargetMismatchInfo | null;
}

function refusal(state: TaskState, message: string): RunExecuteResult {
  return {
    ok: false,
    dryRun: true,
    state,
    brief: null,
    briefFilePath: null,
    command: null,
    result: null,
    message,
    targetMismatch: null,
  };
}

// Stops the execution flow before the implementation brief is even written
// or Claude is invoked -- filesExpectedToChange failed target verification,
// so this control plane must not proceed on its own. Mirrors `refusal()` but
// also carries the structured TargetMismatchInfo callers need.
function targetMismatchRefusal(state: TaskState, targetPath: string, missingPaths: string[]): RunExecuteResult {
  const message =
    `TARGET MISMATCH: expected file(s) not found in target repository "${targetPath}": ` +
    `${missingPaths.join(", ")}. Execution stopped before invoking Claude -- human approval ` +
    "is required before changing the execution target or this task's expected files. " +
    "See .cookvideo/EXECUTION_POLICY.md.";
  return {
    ok: false,
    dryRun: true,
    state,
    brief: null,
    briefFilePath: null,
    command: null,
    result: null,
    message,
    targetMismatch: {
      missingPaths,
      targetPath,
      requiresHumanApproval: true,
    },
  };
}

// The full execute flow: load -> validate task exists -> validate the
// requested lifecycle transition -> check the approval policy -> prepare the
// implementation brief -> build the command that would run it -> decide,
// via the double gate (executeFlag AND executionMode === "local"), whether
// to actually invoke it -> record what happened -> return a full report.
//
// This function never throws. Every failure mode (no task, invalid
// transition, rejected approval, a process that failed to spawn or exited
// non-zero) is represented in the returned RunExecuteResult so callers
// (src/commands/execute.ts, and tests) can always render or assert on it
// directly.
export async function runExecution(ctx: ExecuteContext): Promise<RunExecuteResult> {
  const state = loadTaskState(ctx.taskStatePath);

  const existsCheck = validateTaskExists(state);
  if (!existsCheck.ok) {
    return refusal(state, existsCheck.reason ?? "Task validation failed.");
  }

  const transitionCheck = validateExecutionTransition(state);
  if (!transitionCheck.ok) {
    return refusal(state, transitionCheck.reason ?? "Lifecycle transition validation failed.");
  }

  const approvalCheck = checkApprovalForExecution(state);
  if (!approvalCheck.ok) {
    return refusal(state, approvalCheck.reason ?? "Approval policy check failed.");
  }

  const targetsCheck = validateExpectedTargets(state.filesExpectedToChange, ctx.cwd);
  if (!targetsCheck.ok) {
    return targetMismatchRefusal(state, ctx.cwd, targetsCheck.missingPaths);
  }

  const brief = buildImplementationBrief(state);

  if (!fs.existsSync(ctx.briefsDir)) {
    fs.mkdirSync(ctx.briefsDir, { recursive: true });
  }
  const briefFilePath = path.join(ctx.briefsDir, `${brief.taskId}.md`);
  fs.writeFileSync(briefFilePath, formatImplementationBrief(brief), "utf8");

  const command = buildClaudeCommand({
    claudeCommand: ctx.claudeCommand,
    briefFilePath,
    cwd: ctx.cwd,
  });

  // The double gate: both an explicit --execute flag AND
  // COOKVIDEO_AGENT_EXECUTION_MODE=local must hold before any real process
  // is invoked. Either one missing means dry-run, no exceptions.
  const wantsRealExecution = ctx.executeFlag && ctx.executionMode === "local";
  const dryRun = !wantsRealExecution;

  let result: ClaudeExecutionResult | null = null;
  let message: string;
  let ok = true;

  if (dryRun) {
    const reason =
      !ctx.executeFlag && ctx.executionMode === "local"
        ? "the --execute flag was not passed"
        : ctx.executeFlag && ctx.executionMode !== "local"
          ? `COOKVIDEO_AGENT_EXECUTION_MODE is "${ctx.executionMode}", not "local"`
          : "the --execute flag was not passed and COOKVIDEO_AGENT_EXECUTION_MODE is not \"local\"";
    message = `DRY-RUN: no command was executed because ${reason}. This is the safe default -- see .cookvideo/EXECUTION_POLICY.md.`;
  } else {
    const invoke = ctx.invoke ?? invokeClaude;
    result = await invoke(command);
    if (result.spawnError !== null) {
      ok = false;
      message = `Execution failed to start: ${result.spawnError}`;
    } else if (result.exitCode !== 0) {
      ok = false;
      message = `Claude process exited with code ${String(result.exitCode)}.`;
    } else {
      message = "Claude process completed successfully (exit code 0).";
    }
  }

  const record: ExecutionRecord = {
    timestamp: new Date().toISOString(),
    taskId: state.taskId,
    phase: state.phase,
    executionMode: ctx.executionMode,
    executeFlagSet: ctx.executeFlag,
    dryRun,
    command,
    briefFilePath,
    outcome: message,
    exitCode: result?.exitCode ?? null,
    spawnError: result?.spawnError ?? null,
  };
  appendExecutionRecord(ctx.executionLogPath, record);

  return {
    ok,
    dryRun,
    state,
    brief,
    briefFilePath,
    command,
    result,
    message,
    targetMismatch: null,
  };
}
