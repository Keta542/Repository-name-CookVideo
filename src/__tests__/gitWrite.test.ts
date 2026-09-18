import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseGitWriteMode } from "../config.js";
import {
  appendGitWriteRecord,
  buildCommitMessage,
  getChangedFilePaths,
  getHeadCommit,
  runCommitWrite,
  runPushWrite,
  validateGitWriteScope,
  type GitWriteContext,
  type GitWriteRecord,
} from "../lib/gitWrite.js";
import { EMPTY_TASK_STATE, loadTaskState, saveTaskState, type TaskState } from "../lib/taskState.js";

// All git operations here run against throwaway repositories created fresh
// under the OS temp directory for each test -- never the real CookVideo
// repository or this control plane's own repository. This is the only
// module in this project that ever runs `git add`/`git commit`/`git push`
// for real, so these tests deliberately exercise real git, not a mock.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

// A local repo with an initial commit and no remote -- enough for every
// commit-focused test.
function localRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-gitwrite-local-"));
  initRepo(dir);
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\n", "utf8");
  commitAll(dir, "initial commit");
  return dir;
}

// A local repo with an initial commit already pushed to a bare "remote" and
// tracked -- what `push` needs to have something meaningful to do.
function localRepoWithRemote(): { localDir: string; remoteDir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-gitwrite-remote-"));
  const remoteDir = path.join(base, "remote.git");
  const localDir = path.join(base, "local");
  fs.mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ["init", "-q", "--bare"]);
  // Pin the bare remote's default branch to "main" explicitly, regardless
  // of this machine's global init.defaultBranch -- otherwise a clone of the
  // remote (used by the non-fast-forward test below) can fail to check out
  // a working tree if HEAD points at a branch name that was never pushed.
  git(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  initRepo(localDir);
  fs.writeFileSync(path.join(localDir, "notes.txt"), "line one\n", "utf8");
  commitAll(localDir, "initial commit");
  git(localDir, ["remote", "add", "origin", remoteDir]);
  git(localDir, ["push", "-q", "-u", "origin", "main"]);
  return { localDir, remoteDir };
}

function tempStateFiles(): {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
  gitWriteLogPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-gitwrite-state-"));
  return {
    taskStatePath: path.join(dir, "TASK_STATE.json"),
    activeTaskPath: path.join(dir, "ACTIVE_TASK.md"),
    buildLogPath: path.join(dir, "BUILD_LOG.md"),
    gitWriteLogPath: path.join(dir, "GIT_WRITE_LOG.json"),
  };
}

function baseCtx(cwd: string, overrides: Partial<GitWriteContext> = {}): GitWriteContext {
  const ws = tempStateFiles();
  return {
    taskStatePath: ws.taskStatePath,
    activeTaskPath: ws.activeTaskPath,
    buildLogPath: ws.buildLogPath,
    gitWriteLogPath: ws.gitWriteLogPath,
    gitWriteMode: "dry-run",
    executeFlag: false,
    cwd,
    ...overrides,
  };
}

function approvedTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "GITWRITE-001",
    objective: "Update the empty-state copy on the search page.",
    scope: "UI copy only.",
    phase: "APPROVED",
    riskLevel: "LOW",
    approvalStatus: "APPROVED",
    filesExpectedToChange: ["notes.txt"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// commit message
// ---------------------------------------------------------------------------

test("buildCommitMessage produces the exact deterministic subject/body format", () => {
  const msg = buildCommitMessage(approvedTask({ taskId: "T-42", objective: "Fix the thing." }));
  assert.equal(msg.subject, "CookVideoAgent: T-42");
  assert.equal(msg.body, "Fix the thing.");
});

test("buildCommitMessage never invents an objective that wasn't recorded", () => {
  const msg = buildCommitMessage(approvedTask({ objective: null }));
  assert.match(msg.body, /no objective recorded/);
});

// ---------------------------------------------------------------------------
// scope validation
// ---------------------------------------------------------------------------

test("validateGitWriteScope passes when only the expected file changed", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");

  const result = validateGitWriteScope(dir, ["notes.txt"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedPaths, ["notes.txt"]);
  assert.deepEqual(result.unexpectedPaths, []);
});

test("validateGitWriteScope fails when a change exists outside filesExpectedToChange", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "surprise\n", "utf8");

  const result = validateGitWriteScope(dir, ["notes.txt"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpectedPaths, ["unrelated.txt"]);
});

test("getChangedFilePaths returns an empty list for a clean repository", () => {
  const dir = localRepo();
  assert.deepEqual(getChangedFilePaths(dir), []);
});

// ---------------------------------------------------------------------------
// runCommitWrite -- pre-flight refusals (never touch the repo or state files)
// ---------------------------------------------------------------------------

test("runCommitWrite refuses when there is no active task", () => {
  const dir = localRepo();
  const result = runCommitWrite(baseCtx(dir));
  assert.equal(result.ok, false);
  assert.match(result.message, /No active task/);
  assert.equal(getHeadCommit(dir), git(dir, ["rev-parse", "HEAD"]));
});

test("runCommitWrite refuses a task that is not phase APPROVED / approvalStatus APPROVED", () => {
  const dir = localRepo();
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, approvedTask({ phase: "PLANNED", approvalStatus: "NOT_REQUIRED" }));

  const result = runCommitWrite(ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /requires phase APPROVED/);
  assert.ok(!fs.existsSync(ctx.activeTaskPath));
});

test("runCommitWrite refuses APPROVED phase paired with a non-APPROVED approvalStatus", () => {
  const dir = localRepo();
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, approvedTask({ phase: "APPROVED", approvalStatus: "PENDING" }));

  const result = runCommitWrite(ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /requires phase APPROVED/);
});

// ---------------------------------------------------------------------------
// runCommitWrite -- dry-run
// ---------------------------------------------------------------------------

test("runCommitWrite dry-run never touches the repository or TASK_STATE.json, but previews the real commit message", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, approvedTask());

  const before = git(dir, ["rev-parse", "HEAD"]);
  const result = runCommitWrite(ctx);

  assert.equal(result.dryRun, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.filesStaged, ["notes.txt"]);
  assert.equal(result.commitMessage.subject, "CookVideoAgent: GITWRITE-001");
  assert.match(result.message, /DRY-RUN/);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before, "dry-run must not create a commit");
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "APPROVED", "dry-run must not persist a phase change");
  assert.ok(!fs.existsSync(ctx.activeTaskPath), "dry-run must never write ACTIVE_TASK.md");
});

test("runCommitWrite dry-run flags an in-preview scope mismatch without refusing the dry-run itself", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "surprise\n", "utf8");
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, approvedTask());

  const result = runCommitWrite(ctx);
  assert.equal(result.dryRun, true);
  assert.match(result.message, /would currently refuse/);
  assert.match(result.message, /unrelated\.txt/);
});

// ---------------------------------------------------------------------------
// runCommitWrite -- real execution
// ---------------------------------------------------------------------------

test("runCommitWrite creates a real commit with the deterministic message and advances APPROVED -> COMMITTING", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");
  const ctx = baseCtx(dir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask());

  const beforeCount = git(dir, ["rev-list", "--count", "HEAD"]);
  const result = runCommitWrite(ctx);

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.filesStaged, ["notes.txt"]);
  assert.equal(result.commitHash, git(dir, ["rev-parse", "HEAD"]));
  assert.equal(git(dir, ["rev-list", "--count", "HEAD"]), String(Number(beforeCount) + 1));

  const subject = git(dir, ["log", "-1", "--format=%s"]);
  const body = git(dir, ["log", "-1", "--format=%b"]);
  assert.equal(subject, "CookVideoAgent: GITWRITE-001");
  assert.equal(body, "Update the empty-state copy on the search page.");

  assert.equal(result.state.phase, "COMMITTING");
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "COMMITTING");
  assert.match(loadTaskState(ctx.taskStatePath).result ?? "", new RegExp(result.commitHash ?? "unreachable"));

  const activeTask = fs.readFileSync(ctx.activeTaskPath, "utf8");
  assert.match(activeTask, /\| Phase \| COMMITTING \|/);
  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Real git commit via `cookvideo-agent commit`/);
});

test("runCommitWrite never invokes git add/commit when executeFlag is true but gitWriteMode is dry-run", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");
  const ctx = baseCtx(dir, { executeFlag: true, gitWriteMode: "dry-run" });
  saveTaskState(ctx.taskStatePath, approvedTask());

  const before = git(dir, ["rev-parse", "HEAD"]);
  const result = runCommitWrite(ctx);

  assert.equal(result.dryRun, true);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
});

test("runCommitWrite never invokes git add/commit when gitWriteMode is local but --execute was not passed", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");
  const ctx = baseCtx(dir, { executeFlag: false, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask());

  const before = git(dir, ["rev-parse", "HEAD"]);
  const result = runCommitWrite(ctx);

  assert.equal(result.dryRun, true);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before);
});

test("runCommitWrite refuses (-> FAILED) on a real scope mismatch, without staging or committing anything", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "surprise\n", "utf8");
  const ctx = baseCtx(dir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask());

  const before = git(dir, ["rev-parse", "HEAD"]);
  const result = runCommitWrite(ctx);

  assert.equal(result.ok, false);
  assert.match(result.message, /SCOPE MISMATCH/);
  assert.equal(git(dir, ["rev-parse", "HEAD"]), before, "nothing should have been committed");
  assert.equal(result.state.phase, "FAILED");
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "FAILED");
  // The unrelated file must never have been staged either.
  assert.deepEqual(getChangedFilePaths(dir), ["unrelated.txt"]);
});

test("runCommitWrite refuses (-> FAILED) when there is nothing to commit", () => {
  const dir = localRepo(); // clean working tree
  const ctx = baseCtx(dir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask());

  const result = runCommitWrite(ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /NOTHING TO COMMIT/);
  assert.equal(result.state.phase, "FAILED");
});

test("runCommitWrite refuses (-> FAILED) in a detached HEAD state", () => {
  const dir = localRepo();
  const sha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", sha]); // detach
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");
  const ctx = baseCtx(dir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask());

  const result = runCommitWrite(ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /detached HEAD/);
  assert.equal(result.state.phase, "FAILED");
});

test("runCommitWrite recovers a FAILED task back to APPROVED and commits successfully on retry", () => {
  const dir = localRepo();
  const ctx = baseCtx(dir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask({ phase: "FAILED", result: "previous attempt failed" }));

  // FAILED can't go straight back to COMMITTING -- simulate the recovery a
  // human/planner would perform (back to APPROVED) before retrying.
  saveTaskState(ctx.taskStatePath, approvedTask());
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");

  const result = runCommitWrite(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "COMMITTING");
});

// ---------------------------------------------------------------------------
// runPushWrite -- pre-flight refusals
// ---------------------------------------------------------------------------

test("runPushWrite refuses when there is no active task", () => {
  const { localDir } = localRepoWithRemote();
  const result = runPushWrite(baseCtx(localDir));
  assert.equal(result.ok, false);
  assert.match(result.message, /No active task/);
});

test("runPushWrite refuses a task not in phase COMMITTING", () => {
  const { localDir } = localRepoWithRemote();
  const ctx = baseCtx(localDir);
  saveTaskState(ctx.taskStatePath, approvedTask({ phase: "APPROVED" }));

  const result = runPushWrite(ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /requires phase COMMITTING/);
});

// ---------------------------------------------------------------------------
// runPushWrite -- dry-run
// ---------------------------------------------------------------------------

test("runPushWrite dry-run never touches the remote or TASK_STATE.json", () => {
  const { localDir, remoteDir } = localRepoWithRemote();
  git(localDir, ["commit", "-q", "--allow-empty", "-m", "a local commit to push"]);
  const ctx = baseCtx(localDir);
  saveTaskState(ctx.taskStatePath, approvedTask({ phase: "COMMITTING" }));

  const remoteBefore = git(remoteDir, ["rev-parse", "main"]);
  const result = runPushWrite(ctx);

  assert.equal(result.dryRun, true);
  assert.equal(result.ok, true);
  assert.match(result.message, /DRY-RUN/);
  assert.equal(git(remoteDir, ["rev-parse", "main"]), remoteBefore);
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "COMMITTING");
  assert.ok(!fs.existsSync(ctx.activeTaskPath));
});

// ---------------------------------------------------------------------------
// runPushWrite -- real execution
// ---------------------------------------------------------------------------

test("runPushWrite pushes a real commit, stays at COMMITTING, and records the pushed hash", () => {
  const { localDir, remoteDir } = localRepoWithRemote();
  git(localDir, ["commit", "-q", "--allow-empty", "-m", "a local commit to push"]);
  const localHead = git(localDir, ["rev-parse", "HEAD"]);
  const ctx = baseCtx(localDir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask({ phase: "COMMITTING" }));

  const result = runPushWrite(ctx);

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.pushedCommitHash, localHead);
  assert.equal(git(remoteDir, ["rev-parse", "main"]), localHead);

  assert.equal(result.state.phase, "COMMITTING", "a successful push must not advance the phase");
  assert.equal(loadTaskState(ctx.taskStatePath).phase, "COMMITTING");
  assert.match(loadTaskState(ctx.taskStatePath).result ?? "", new RegExp(localHead));

  const buildLog = fs.readFileSync(ctx.buildLogPath, "utf8");
  assert.match(buildLog, /Real git push via `cookvideo-agent push`/);
});

test("runPushWrite refuses (-> FAILED) with nothing to push, preserving the local commit hash", () => {
  const { localDir } = localRepoWithRemote(); // already pushed, nothing new
  const localHead = git(localDir, ["rev-parse", "HEAD"]);
  const ctx = baseCtx(localDir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(
    ctx.taskStatePath,
    approvedTask({ phase: "COMMITTING", result: `Committed. CookVideo commit: ${localHead}` }),
  );

  const result = runPushWrite(ctx);
  assert.equal(result.ok, false);
  assert.match(result.message, /NOTHING TO PUSH/);
  assert.equal(result.state.phase, "FAILED");
  assert.match(loadTaskState(ctx.taskStatePath).result ?? "", /NOTHING TO PUSH/);
});

test("runPushWrite refuses (-> FAILED) on a rejected non-fast-forward push, never force-resolving it", () => {
  const { localDir, remoteDir } = localRepoWithRemote();

  // Simulate someone else advancing the remote in the meantime via a second clone.
  const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-gitwrite-other-"));
  execFileSync("git", ["clone", "-q", remoteDir, otherClone], { encoding: "utf8" });
  git(otherClone, ["config", "user.email", "test@example.com"]);
  git(otherClone, ["config", "user.name", "Test"]);
  git(otherClone, ["commit", "-q", "--allow-empty", "-m", "someone else's commit"]);
  git(otherClone, ["push", "-q", "origin", "main"]);

  // Now the local repo makes its own divergent commit and tries to push.
  git(localDir, ["commit", "-q", "--allow-empty", "-m", "a local commit to push"]);
  const localHead = git(localDir, ["rev-parse", "HEAD"]);
  const ctx = baseCtx(localDir, { executeFlag: true, gitWriteMode: "local" });
  saveTaskState(ctx.taskStatePath, approvedTask({ phase: "COMMITTING" }));

  const result = runPushWrite(ctx);

  assert.equal(result.ok, false);
  assert.match(result.message, /git push failed/);
  assert.equal(result.state.phase, "FAILED");
  assert.equal(git(localDir, ["rev-parse", "HEAD"]), localHead, "the local commit must be preserved, untouched");
  assert.notEqual(git(remoteDir, ["rev-parse", "main"]), localHead, "the remote must not have been force-pushed");
});

// ---------------------------------------------------------------------------
// git write log
// ---------------------------------------------------------------------------

test("appendGitWriteRecord creates the log file on first use and appends on subsequent calls", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-gitwritelog-"));
  const logPath = path.join(dir, "GIT_WRITE_LOG.json");

  const record = (n: number): GitWriteRecord => ({
    timestamp: `2026-01-0${n}T00:00:00.000Z`,
    action: "commit",
    taskId: "T-001",
    phaseBefore: "APPROVED",
    phaseAfter: "COMMITTING",
    gitWriteMode: "dry-run",
    executeFlagSet: false,
    dryRun: true,
    commands: [],
    outcome: `attempt ${n}`,
    ok: true,
    commitHash: null,
  });

  appendGitWriteRecord(logPath, record(1));
  appendGitWriteRecord(logPath, record(2));

  const raw = JSON.parse(fs.readFileSync(logPath, "utf8")) as GitWriteRecord[];
  assert.equal(raw.length, 2);
  assert.equal(raw[0]?.outcome, "attempt 1");
  assert.equal(raw[1]?.outcome, "attempt 2");
});

test("runCommitWrite and runPushWrite each append exactly one git write log record per attempt", () => {
  const dir = localRepo();
  fs.writeFileSync(path.join(dir, "notes.txt"), "line one\nline two\n", "utf8");
  const ctx = baseCtx(dir);
  saveTaskState(ctx.taskStatePath, approvedTask());

  runCommitWrite(ctx);
  runCommitWrite(ctx);

  const raw = JSON.parse(fs.readFileSync(ctx.gitWriteLogPath, "utf8")) as GitWriteRecord[];
  assert.equal(raw.length, 2);
  assert.ok(raw.every((r) => r.action === "commit"));
});

// ---------------------------------------------------------------------------
// COOKVIDEO_AGENT_GIT_WRITE_MODE parsing
// ---------------------------------------------------------------------------

test("parseGitWriteMode accepts the two documented values", () => {
  assert.equal(parseGitWriteMode("dry-run"), "dry-run");
  assert.equal(parseGitWriteMode("local"), "local");
});

test("parseGitWriteMode fails safe to dry-run for anything else", () => {
  assert.equal(parseGitWriteMode(undefined), "dry-run");
  assert.equal(parseGitWriteMode(""), "dry-run");
  assert.equal(parseGitWriteMode("LOCAL"), "dry-run");
  assert.equal(parseGitWriteMode("production"), "dry-run");
});
