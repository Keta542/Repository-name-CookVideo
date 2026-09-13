import crypto from "node:crypto";
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
import { formatActiveTaskMarkdown, prependBuildLogEntry } from "./plan.js";
import {
  applyExecutionOutcome,
  beginImplementing,
  isValidTransition,
  loadTaskState,
  saveTaskState,
  type TaskPhase,
  type TaskState,
} from "./taskState.js";
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
// Post-execution verification (did Claude actually change what it was asked to)
//
// A Claude process exiting 0 only means the process itself didn't error --
// it says nothing about whether Claude actually edited the file(s) the task
// named. Content hashes (not mtimes, which can be too coarse on some
// filesystems for two writes within the same execution) are taken of every
// filesExpectedToChange path before Claude runs and compared against the
// same paths afterward; any mismatch counts as a real change.
// ---------------------------------------------------------------------------

function hashFileIfExists(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Keyed by the task's original relative path (not the resolved absolute
// path) so callers never need to re-derive or re-validate it against cwd.
export function snapshotExpectedFiles(filesExpectedToChange: string[], cwd: string): Map<string, string | null> {
  const snapshot = new Map<string, string | null>();
  for (const relativePath of filesExpectedToChange) {
    const resolved = resolveExpectedTargetPath(cwd, relativePath);
    snapshot.set(relativePath, resolved !== null ? hashFileIfExists(resolved) : null);
  }
  return snapshot;
}

export interface ExpectedFilesChangeCheck {
  changed: boolean;
  changedPaths: string[];
}

// Compares a snapshot taken before Claude ran against the current state of
// the same paths. filesExpectedToChange has already passed
// validateExpectedTargets by the time this runs, so every path existed
// beforehand -- but this makes no assumption about that, since a hash of
// `null` (path missing) still compares correctly either way.
export function verifyExpectedFilesChanged(
  before: Map<string, string | null>,
  filesExpectedToChange: string[],
  cwd: string,
): ExpectedFilesChangeCheck {
  const changedPaths = filesExpectedToChange.filter((relativePath) => {
    const resolved = resolveExpectedTargetPath(cwd, relativePath);
    const after = resolved !== null ? hashFileIfExists(resolved) : null;
    return after !== before.get(relativePath);
  });
  return { changed: changedPaths.length > 0, changedPaths };
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
  // null when verification never ran (dry-run, a failed/non-zero attempt, or
  // no filesExpectedToChange to check); otherwise the expected paths that
  // were actually found to differ from their pre-execution state.
  filesChanged: string[] | null;
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
// Persisted lifecycle transitions (Milestone 8)
//
// Real execution only -- dry-run never calls saveTaskState/writes
// ACTIVE_TASK.md/BUILD_LOG.md, matching EXECUTION_POLICY.md's "DRY-RUN
// prepares and displays only." Each hop writes all three control-plane
// documents together (mirroring src/commands/approve.ts and
// src/commands/complete.ts) so they can never be left disagreeing --
// including the intermediate IMPLEMENTING hop, so a crash mid-Claude-call
// still leaves TASK_STATE.json/ACTIVE_TASK.md showing the true in-flight
// phase rather than a stale PLANNED.
// ---------------------------------------------------------------------------

function executeStartBuildLogEntry(state: TaskState, previousPhase: TaskPhase): string {
  return [
    `## ${new Date().toISOString().slice(0, 10)} — Task execution started via \`cookvideo-agent execute\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Phase: ${previousPhase} -> ${state.phase}.`,
    "- Claude is being invoked locally against the approved execution target; this control plane",
    "  has not committed, pushed, or deployed anything.",
    "",
  ].join("\n");
}

function executeOutcomeBuildLogEntry(state: TaskState, previousPhase: TaskPhase): string {
  return [
    `## ${new Date().toISOString().slice(0, 10)} — Task execution outcome via \`cookvideo-agent execute\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Phase: ${previousPhase} -> ${state.phase}.`,
    `- Result: ${state.result ?? "(none)"}`,
    "- No commit, push, or deployment was performed by this command.",
    "",
  ].join("\n");
}

// Persists a transition -- TASK_STATE.json, ACTIVE_TASK.md, and a
// BUILD_LOG.md entry together -- only when it actually changed anything
// (mirrors the `result.state !== state` guard approve.ts/complete.ts
// already use, so a no-op transition never writes a duplicate entry).
function persistTransition(
  ctx: ExecuteContext,
  from: TaskState,
  to: TaskState,
  entryMarkdown: (state: TaskState, previousPhase: TaskPhase) => string,
): void {
  if (to === from) {
    return;
  }
  saveTaskState(ctx.taskStatePath, to);
  fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(to), "utf8");
  prependBuildLogEntry(ctx.buildLogPath, entryMarkdown(to, from.phase));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface ExecuteContext {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
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
  // Mirrors ExecutionRecord.filesChanged -- see there for when this is null.
  filesChanged: string[] | null;
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
    filesChanged: null,
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
    filesChanged: null,
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
  const briefContent = formatImplementationBrief(brief);
  // The brief file on disk (briefFilePath) is kept purely as an auditable
  // record of exactly what was prepared for this attempt -- it is never
  // itself read back or passed to Claude. The actual instructions Claude
  // receives are the brief's rendered contents, given directly to
  // buildClaudeCommand below.
  fs.writeFileSync(briefFilePath, briefContent, "utf8");

  const command = buildClaudeCommand({
    claudeCommand: ctx.claudeCommand,
    briefContent,
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
  let filesChanged: string[] | null = null;
  // Tracks the persisted TaskState across the two transition points below.
  // Stays exactly equal to `state` for a dry-run (never mutated, never
  // saved) -- only real execution advances it.
  let currentState = state;

  if (dryRun) {
    const reason =
      !ctx.executeFlag && ctx.executionMode === "local"
        ? "the --execute flag was not passed"
        : ctx.executeFlag && ctx.executionMode !== "local"
          ? `COOKVIDEO_AGENT_EXECUTION_MODE is "${ctx.executionMode}", not "local"`
          : "the --execute flag was not passed and COOKVIDEO_AGENT_EXECUTION_MODE is not \"local\"";
    message = `DRY-RUN: no command was executed because ${reason}. This is the safe default -- see .cookvideo/EXECUTION_POLICY.md.`;
  } else {
    // Persist the move into IMPLEMENTING *before* invoking Claude, not
    // after -- so a crash mid-invocation still leaves TASK_STATE.json
    // showing the true in-flight phase rather than a stale PLANNED. Never
    // expected to fail here (validateExecutionTransition above already
    // confirmed this exact move is legal), but never invoked from a phase
    // this control plane hasn't itself just validated either.
    const beginResult = beginImplementing(currentState);
    persistTransition(ctx, currentState, beginResult.state, executeStartBuildLogEntry);
    currentState = beginResult.state;

    const invoke = ctx.invoke ?? invokeClaude;
    // Taken before invoking, not after -- this has to capture the state
    // Claude found the files in, not whatever they happen to look like once
    // the process has already run.
    const beforeSnapshot = snapshotExpectedFiles(brief.filesExpectedToChange, ctx.cwd);
    result = await invoke(command);
    if (result.spawnError !== null) {
      ok = false;
      message = `Execution failed to start: ${result.spawnError}`;
    } else if (result.exitCode !== 0) {
      ok = false;
      message = `Claude process exited with code ${String(result.exitCode)}.`;
    } else if (brief.filesExpectedToChange.length === 0) {
      // Nothing to verify -- matches validateExpectedTargets' existing
      // "empty list always passes" treatment.
      message = "Claude process completed successfully (exit code 0). No filesExpectedToChange were recorded to verify.";
    } else {
      const verification = verifyExpectedFilesChanged(beforeSnapshot, brief.filesExpectedToChange, ctx.cwd);
      filesChanged = verification.changedPaths;
      if (!verification.changed) {
        // This is the core bug this module exists to catch: exit code 0
        // alone is not proof of implementation work. If none of the files
        // the task named actually changed, Claude did not do the work,
        // regardless of what its exit code says.
        ok = false;
        message =
          `Claude process exited with code 0, but completed without producing the expected ` +
          `file changes. None of the following changed: ${brief.filesExpectedToChange.join(", ")}.`;
      } else {
        message = `Claude process completed successfully and changed the expected file(s): ${filesChanged.join(", ")}.`;
      }
    }

    // Persist the outcome -- verified success advances to TESTING; a spawn
    // error, non-zero exit, or exit 0 with nothing actually changed all move
    // the task to FAILED (recoverable back to PLANNED/IMPLEMENTING).
    const outcomeResult = applyExecutionOutcome(currentState, ok, message);
    persistTransition(ctx, currentState, outcomeResult.state, executeOutcomeBuildLogEntry);
    currentState = outcomeResult.state;
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
    filesChanged,
  };
  appendExecutionRecord(ctx.executionLogPath, record);

  return {
    ok,
    dryRun,
    state: currentState,
    brief,
    briefFilePath,
    command,
    result,
    message,
    targetMismatch: null,
    filesChanged,
  };
}
