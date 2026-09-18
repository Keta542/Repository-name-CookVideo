import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatActiveTaskMarkdown, prependBuildLogEntry } from "./plan.js";
import {
  applyCommitOutcome,
  applyPushOutcome,
  loadTaskState,
  saveTaskState,
  type TaskPhase,
  type TaskState,
} from "./taskState.js";
import type { GitWriteMode } from "../config.js";

// ---------------------------------------------------------------------------
// Real git write module (Milestone 12)
//
// This is the orchestration layer behind `cookvideo-agent commit` and
// `cookvideo-agent push`, mirroring the existing split between orchestration
// (src/lib/*.ts) and thin CLI wiring (src/commands/*.ts) already used for
// `execute` (src/lib/execution.ts <-> src/commands/execute.ts). It is the
// only place that decides whether a real `git add`/`git commit`/`git push`
// runs, and it is the only place that ever calls those three subcommands --
// nothing else in this control plane runs a git write command.
//
// commit and push are deliberately two separate functions/commands, never
// chained: `runCommitWrite` never calls `runPushWrite`, and neither is
// reachable from the other's gate. See .cookvideo/GIT_WRITE_POLICY.md.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Low-level git step runner
// ---------------------------------------------------------------------------

interface GitStepResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError: string | null;
}

// Every real git write in this module goes through this one function --
// never execFileSync (which throws on a non-zero exit, awkward for a
// deliberately-rejected push) and never shell:true (no shell interpolation
// of any argument, ever). Mirrors src/lib/git.ts's own "never throws,
// report failure in the return value" discipline.
function runGitStep(repoPath: string, args: string[]): GitStepResult {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
  if (result.error) {
    return { ok: false, stdout: "", stderr: "", exitCode: null, spawnError: result.error.message };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
    spawnError: null,
  };
}

// True only when HEAD is a real branch (not detached) -- committing in a
// detached HEAD state would create a commit nothing can ever push, so
// `runCommitWrite` refuses before staging anything in that case.
function isOnBranch(repoPath: string): boolean {
  return runGitStep(repoPath, ["symbolic-ref", "-q", "HEAD"]).ok;
}

export function getHeadCommit(repoPath: string): string | null {
  const result = runGitStep(repoPath, ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() : null;
}

// `git status --porcelain` output, one path per changed entry. A rename
// line ("R  old -> new") contributes both the old and new path, so a
// scope check never under-reports what actually changed. This is a
// pragmatic parser (like resolveExpectedTargetPath in execution.ts, it does
// not attempt to handle quoted/escaped paths for filenames containing
// unusual characters) -- acceptable for this control plane's controlled,
// human-reviewed task inputs.
export function getChangedFilePaths(repoPath: string): string[] {
  const result = runGitStep(repoPath, ["status", "--porcelain"]);
  if (!result.ok) {
    return [];
  }
  const lines = result.stdout.split("\n").filter((line) => line.length > 0);
  const paths: string[] = [];
  for (const line of lines) {
    const spec = line.slice(3);
    const arrowIndex = spec.indexOf(" -> ");
    if (arrowIndex !== -1) {
      paths.push(spec.slice(0, arrowIndex));
      paths.push(spec.slice(arrowIndex + 4));
    } else {
      paths.push(spec);
    }
  }
  return paths;
}

export interface GitWriteScopeValidation {
  ok: boolean;
  changedPaths: string[];
  unexpectedPaths: string[];
}

// A real commit must never stage anything beyond what the task itself
// named. If the CookVideo working tree has any change outside
// filesExpectedToChange -- a leftover from unrelated work, a task that went
// stale, a target picked in error -- this control plane must never silently
// `git add -A`/`.` past it. Reuses the same philosophy
// validateExpectedTargets/verifyExpectedFilesChanged already established in
// src/lib/execution.ts for the analogous "does reality match what the task
// claims" question.
export function validateGitWriteScope(repoPath: string, filesExpectedToChange: string[]): GitWriteScopeValidation {
  const changedPaths = getChangedFilePaths(repoPath);
  const expected = new Set(filesExpectedToChange);
  const unexpectedPaths = changedPaths.filter((p) => !expected.has(p));
  return { ok: unexpectedPaths.length === 0, changedPaths, unexpectedPaths };
}

interface UpstreamAheadInfo {
  hasUpstream: boolean;
  ahead: number | null;
}

// Reads git's own notion of "how many local commits on the current branch
// aren't on its upstream yet," rather than trusting anything this control
// plane itself remembered from an earlier `commit` call. No upstream
// configured, or a count that can't be parsed, are both reported distinctly
// from "zero ahead" so runPushWrite can refuse with a precise reason instead
// of blindly attempting `git push` and hoping git's own error is clear.
function getUpstreamAheadCount(repoPath: string): UpstreamAheadInfo {
  const upstreamCheck = runGitStep(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstreamCheck.ok) {
    return { hasUpstream: false, ahead: null };
  }
  const countResult = runGitStep(repoPath, ["rev-list", "--count", "@{u}..HEAD"]);
  if (!countResult.ok) {
    return { hasUpstream: true, ahead: null };
  }
  const parsed = Number.parseInt(countResult.stdout.trim(), 10);
  return { hasUpstream: true, ahead: Number.isNaN(parsed) ? null : parsed };
}

// ---------------------------------------------------------------------------
// Commit message (deterministic -- Milestone 12 decision: no free-form
// override exists in this milestone)
// ---------------------------------------------------------------------------

export interface CommitMessage {
  subject: string;
  body: string;
}

export function buildCommitMessage(state: TaskState): CommitMessage {
  return {
    subject: `CookVideoAgent: ${state.taskId ?? "(unknown)"}`,
    body: state.objective ?? "(no objective recorded for this task)",
  };
}

function dryRunReason(executeFlag: boolean, gitWriteMode: GitWriteMode): string {
  if (!executeFlag && gitWriteMode !== "local") {
    return 'the --execute flag was not passed and COOKVIDEO_AGENT_GIT_WRITE_MODE is not "local"';
  }
  if (!executeFlag) {
    return "the --execute flag was not passed";
  }
  return `COOKVIDEO_AGENT_GIT_WRITE_MODE is "${gitWriteMode}", not "local"`;
}

// ---------------------------------------------------------------------------
// Git write log (append-only, mirrors EXECUTION_LOG.json's exact pattern)
// ---------------------------------------------------------------------------

export interface GitWriteRecord {
  timestamp: string;
  action: "commit" | "push";
  taskId: string | null;
  phaseBefore: TaskPhase;
  phaseAfter: TaskPhase;
  gitWriteMode: GitWriteMode;
  executeFlagSet: boolean;
  dryRun: boolean;
  // Every git subcommand's argv considered or run for this attempt, in
  // order -- populated even in dry-run, so the log always shows exactly
  // what real execution would run (or did run).
  commands: string[][];
  outcome: string;
  ok: boolean;
  // The new local commit hash (commit) or the pushed commit hash (push);
  // null for dry-run and for any attempt that never reached a real commit.
  commitHash: string | null;
}

function readGitWriteLog(logPath: string): GitWriteRecord[] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GitWriteRecord[]) : [];
  } catch {
    // A corrupt or unreadable log should never block commit/push reporting
    // -- it's a diagnostic trail, not the source of truth (TASK_STATE.json
    // is).
    return [];
  }
}

export function appendGitWriteRecord(logPath: string, record: GitWriteRecord): void {
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = readGitWriteLog(logPath);
  existing.push(record);
  fs.writeFileSync(logPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Persisted lifecycle transitions
// ---------------------------------------------------------------------------

function gitWriteBuildLogEntry(
  state: TaskState,
  previousPhase: TaskPhase,
  action: "commit" | "push",
  ok: boolean,
  commitMessage?: CommitMessage,
): string {
  const lines: string[] = [
    `## ${new Date().toISOString().slice(0, 10)} — Real git ${action} via \`cookvideo-agent ${action}\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Phase: ${previousPhase} -> ${state.phase}.`,
    `- Result: ${state.result ?? "(none)"}`,
  ];
  if (action === "commit" && commitMessage !== undefined) {
    lines.push(`- Commit message subject: ${commitMessage.subject}`);
  }
  lines.push(
    ok
      ? `- This was a real ${action} against the CookVideo repository, gated by \`--execute\` and ` +
          "COOKVIDEO_AGENT_GIT_WRITE_MODE=local."
      : `- This real ${action} attempt against the CookVideo repository failed -- see ` +
          ".cookvideo/GIT_WRITE_LOG.json for the full detail.",
    "",
  );
  return lines.join("\n");
}

function persistGitWriteTransition(
  ctx: GitWriteContext,
  from: TaskState,
  to: TaskState,
  action: "commit" | "push",
  ok: boolean,
  commitMessage?: CommitMessage,
): void {
  if (to === from) {
    return;
  }
  saveTaskState(ctx.taskStatePath, to);
  fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(to), "utf8");
  prependBuildLogEntry(ctx.buildLogPath, gitWriteBuildLogEntry(to, from.phase, action, ok, commitMessage));
}

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------

export interface GitWriteContext {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
  gitWriteLogPath: string;
  gitWriteMode: GitWriteMode;
  executeFlag: boolean;
  // Always the resolved CookVideo execution target's path -- src/commands/
  // commit.ts and src/commands/push.ts hardcode target resolution to
  // GIT_WRITE_TARGET_NAME before this context is ever built, so nothing in
  // this module itself chooses or validates which repository it's given.
  cwd: string;
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export interface RunCommitResult {
  ok: boolean;
  dryRun: boolean;
  state: TaskState;
  message: string;
  commitMessage: CommitMessage;
  // The files a real commit staged (or, in dry-run, the files that would
  // currently be staged) -- null only for a pre-flight refusal (no task,
  // wrong phase) that never got as far as checking the repository.
  filesStaged: string[] | null;
  // The new commit's hash, read back from git itself -- never set from
  // anything self-reported. Null for dry-run and for any failed attempt.
  commitHash: string | null;
}

function commitRefusal(state: TaskState, message: string): RunCommitResult {
  return {
    ok: false,
    dryRun: true,
    state,
    message,
    commitMessage: buildCommitMessage(state),
    filesStaged: null,
    commitHash: null,
  };
}

// The full commit flow: load -> require phase APPROVED and approvalStatus
// APPROVED -> build the deterministic commit message -> decide, via the
// double gate (executeFlag AND gitWriteMode === "local"), whether to
// actually stage/commit -> record what happened -> return a full report.
//
// Never throws. Every failure mode (no task, wrong phase, scope mismatch,
// nothing to commit, detached HEAD, a git add/commit failure) is
// represented in the returned RunCommitResult so callers
// (src/commands/commit.ts, and tests) can always render or assert on it
// directly.
export function runCommitWrite(ctx: GitWriteContext): RunCommitResult {
  const state = loadTaskState(ctx.taskStatePath);

  if (state.taskId === null) {
    return commitRefusal(state, "No active task to commit. Run `cookvideo-agent task` to check current state.");
  }
  if (state.phase !== "APPROVED" || state.approvalStatus !== "APPROVED") {
    return commitRefusal(
      state,
      `Task ${state.taskId} is in phase ${state.phase} (approvalStatus ${state.approvalStatus}). ` +
        "Committing requires phase APPROVED and approvalStatus APPROVED -- run `cookvideo-agent approve` " +
        "first if the task is awaiting approval. See .cookvideo/GIT_WRITE_POLICY.md.",
    );
  }

  const commitMessage = buildCommitMessage(state);
  const wantsReal = ctx.executeFlag && ctx.gitWriteMode === "local";
  const dryRun = !wantsReal;

  let ok = true;
  let message: string;
  let filesStaged: string[] | null = null;
  let commitHash: string | null = null;
  let currentState = state;
  const commands: string[][] = [];

  if (dryRun) {
    // Read-only even in dry-run, so the preview reflects the real
    // repository rather than an assumption -- exactly what real execution
    // would currently do, without doing it.
    const scope = validateGitWriteScope(ctx.cwd, state.filesExpectedToChange);
    filesStaged = scope.changedPaths;
    commands.push(["add", "--", ...scope.changedPaths]);
    commands.push(["commit", "-m", commitMessage.subject, "-m", commitMessage.body]);

    const reason = dryRunReason(ctx.executeFlag, ctx.gitWriteMode);
    if (!scope.ok) {
      message =
        `DRY-RUN: no commit was created (${reason}). Note: real execution would currently refuse -- ` +
        `unexpected changes outside filesExpectedToChange: ${scope.unexpectedPaths.join(", ")}.`;
    } else if (scope.changedPaths.length === 0) {
      message =
        `DRY-RUN: no commit was created (${reason}). Note: real execution would currently refuse -- ` +
        "nothing to commit in the CookVideo repository.";
    } else {
      message =
        `DRY-RUN: no commit was created because ${reason}. This is the safe default -- see ` +
        ".cookvideo/GIT_WRITE_POLICY.md.";
    }
  } else if (!isOnBranch(ctx.cwd)) {
    ok = false;
    message = "Refusing to commit: CookVideo is in a detached HEAD state, not on a branch.";
  } else {
    const scope = validateGitWriteScope(ctx.cwd, state.filesExpectedToChange);
    if (!scope.ok) {
      ok = false;
      message =
        "SCOPE MISMATCH: changes exist outside this task's filesExpectedToChange: " +
        `${scope.unexpectedPaths.join(", ")}. Nothing was staged or committed.`;
    } else if (scope.changedPaths.length === 0) {
      ok = false;
      message = "NOTHING TO COMMIT: no changes found in the CookVideo repository.";
    } else {
      const addArgs = ["add", "--", ...scope.changedPaths];
      commands.push(addArgs);
      const addResult = runGitStep(ctx.cwd, addArgs);
      if (!addResult.ok) {
        ok = false;
        message = `git add failed: ${addResult.spawnError ?? addResult.stderr.trim()}`;
      } else {
        const commitArgs = ["commit", "-m", commitMessage.subject, "-m", commitMessage.body];
        commands.push(commitArgs);
        const commitResult = runGitStep(ctx.cwd, commitArgs);
        if (!commitResult.ok) {
          ok = false;
          message = `git commit failed: ${commitResult.spawnError ?? commitResult.stderr.trim()}`;
        } else {
          commitHash = getHeadCommit(ctx.cwd);
          filesStaged = scope.changedPaths;
          message = `Committed ${String(scope.changedPaths.length)} file(s) as ${commitHash ?? "(unknown hash)"}.`;
        }
      }
    }
  }

  if (!dryRun) {
    const outcome = applyCommitOutcome(
      currentState,
      ok,
      ok ? `Committed. CookVideo commit: ${commitHash ?? "(unknown)"}` : message,
    );
    persistGitWriteTransition(ctx, currentState, outcome.state, "commit", ok, commitMessage);
    currentState = outcome.state;
  }

  appendGitWriteRecord(ctx.gitWriteLogPath, {
    timestamp: new Date().toISOString(),
    action: "commit",
    taskId: state.taskId,
    phaseBefore: state.phase,
    phaseAfter: currentState.phase,
    gitWriteMode: ctx.gitWriteMode,
    executeFlagSet: ctx.executeFlag,
    dryRun,
    commands,
    outcome: message,
    ok,
    commitHash,
  });

  return { ok, dryRun, state: currentState, message, commitMessage, filesStaged, commitHash };
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

export interface RunPushResult {
  ok: boolean;
  dryRun: boolean;
  state: TaskState;
  message: string;
  // The commit hash that was pushed, read back from git itself. Null for
  // dry-run and for any failed/refused attempt.
  pushedCommitHash: string | null;
}

function pushRefusal(state: TaskState, message: string): RunPushResult {
  return { ok: false, dryRun: true, state, message, pushedCommitHash: null };
}

// The full push flow: load -> require phase COMMITTING -> decide, via the
// double gate, whether to actually push -> record what happened -> return a
// full report. Never chained from runCommitWrite -- always its own,
// separately invoked attempt (see .cookvideo/GIT_WRITE_POLICY.md).
//
// A successful push does not advance the task's phase (see
// applyPushOutcome's own comment); a failed push -- rejected, diverged,
// network/auth failure, no upstream, or nothing to push -- moves the task
// to FAILED, preserving the already-recorded local commit hash in `result`
// from the prior real commit, so the task is never falsely treated as
// pushed and always remains recoverable.
export function runPushWrite(ctx: GitWriteContext): RunPushResult {
  const state = loadTaskState(ctx.taskStatePath);

  if (state.taskId === null) {
    return pushRefusal(state, "No active task to push. Run `cookvideo-agent task` to check current state.");
  }
  if (state.phase !== "COMMITTING") {
    return pushRefusal(
      state,
      `Task ${state.taskId} is in phase ${state.phase}. Pushing requires phase COMMITTING (a commit must ` +
        "already exist, via `cookvideo-agent commit` or a manually recorded `cookvideo-agent advance --to " +
        "COMMITTING`). See .cookvideo/GIT_WRITE_POLICY.md.",
    );
  }

  const wantsReal = ctx.executeFlag && ctx.gitWriteMode === "local";
  const dryRun = !wantsReal;

  let ok = true;
  let message: string;
  let pushedCommitHash: string | null = null;
  let currentState = state;
  const commands: string[][] = [["push"]];

  if (dryRun) {
    const reason = dryRunReason(ctx.executeFlag, ctx.gitWriteMode);
    message =
      `DRY-RUN: no push was performed because ${reason}. This is the safe default -- see ` +
      ".cookvideo/GIT_WRITE_POLICY.md.";
  } else {
    const upstream = getUpstreamAheadCount(ctx.cwd);
    if (!upstream.hasUpstream) {
      ok = false;
      message = "Refusing to push: the current CookVideo branch has no upstream tracking branch configured.";
    } else if (upstream.ahead === null) {
      ok = false;
      message = "Refusing to push: could not determine how many commits are ahead of the upstream branch.";
    } else if (upstream.ahead === 0) {
      ok = false;
      message = "NOTHING TO PUSH: the current CookVideo branch is already up to date with its upstream.";
    } else {
      const headBefore = getHeadCommit(ctx.cwd);
      const pushResult = runGitStep(ctx.cwd, ["push"]);
      if (!pushResult.ok) {
        ok = false;
        message =
          `git push failed (local commit ${headBefore ?? "(unknown)"} was not pushed -- no force-resolve ` +
          `was attempted): ${pushResult.spawnError ?? pushResult.stderr.trim()}`;
      } else {
        pushedCommitHash = headBefore;
        message =
          `Pushed ${String(upstream.ahead)} commit(s); CookVideo commit ${headBefore ?? "(unknown)"} is now ` +
          "on the remote.";
      }
    }
  }

  if (!dryRun) {
    const outcome = applyPushOutcome(
      currentState,
      ok,
      ok ? `Pushed. CookVideo commit: ${pushedCommitHash ?? "(unknown)"}` : message,
    );
    persistGitWriteTransition(ctx, currentState, outcome.state, "push", ok);
    currentState = outcome.state;
  }

  appendGitWriteRecord(ctx.gitWriteLogPath, {
    timestamp: new Date().toISOString(),
    action: "push",
    taskId: state.taskId,
    phaseBefore: state.phase,
    phaseAfter: currentState.phase,
    gitWriteMode: ctx.gitWriteMode,
    executeFlagSet: ctx.executeFlag,
    dryRun,
    commands,
    outcome: message,
    ok,
    commitHash: pushedCommitHash,
  });

  return { ok, dryRun, state: currentState, message, pushedCommitHash };
}
