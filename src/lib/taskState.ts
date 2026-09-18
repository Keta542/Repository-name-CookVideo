import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// The main forward path plus the three phases that can be entered from
// (almost) anywhere a task is in flight: FAILED, BLOCKED, CANCELLED.
export const LIFECYCLE_PHASES = [
  "PLANNED",
  "IMPLEMENTING",
  "TESTING",
  "REVIEW",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "COMMITTING",
  "DEPLOYING",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
] as const;

export type TaskPhase = (typeof LIFECYCLE_PHASES)[number];

// A task in one of these phases is done: nothing else should happen to it
// without a reset (or, eventually, a deliberate "start a new task" action).
export const TERMINAL_PHASES: readonly TaskPhase[] = [
  "COMPLETED",
  "CANCELLED",
] as const;

export function isTerminalPhase(phase: TaskPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

// The main forward path, expressed as "what can this phase move to next".
// FAILED / BLOCKED / CANCELLED are reachable from every non-terminal phase
// (a task can go wrong, get stuck, or get called off at any point before it
// finishes) but are not listed on every line below for that reason alone --
// they're added programmatically just below the literal map instead, so the
// "happy path" stays readable here.
const FORWARD_TRANSITIONS: Record<TaskPhase, readonly TaskPhase[]> = {
  PLANNED: ["IMPLEMENTING"],
  IMPLEMENTING: ["TESTING"],
  TESTING: ["REVIEW"],
  REVIEW: ["APPROVAL_REQUIRED"],
  APPROVAL_REQUIRED: ["APPROVED"],
  APPROVED: ["COMMITTING"],
  COMMITTING: ["DEPLOYING"],
  DEPLOYING: ["VERIFYING"],
  VERIFYING: ["COMPLETED"],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
};

const RECOVERABLE_FROM_STUCK: readonly TaskPhase[] = ["PLANNED", "IMPLEMENTING"];

// The full adjacency map: forward path + "can always go wrong/stuck/cancelled"
// from any non-terminal phase, plus a narrow recovery path back into the
// forward flow from FAILED/BLOCKED (re-planning or resuming implementation).
// Nothing is reachable from a terminal phase -- that's what terminal means.
export const TRANSITIONS: Record<TaskPhase, readonly TaskPhase[]> = Object.fromEntries(
  LIFECYCLE_PHASES.map((phase) => {
    if (isTerminalPhase(phase)) {
      return [phase, []];
    }
    const forward = FORWARD_TRANSITIONS[phase];
    const escapeHatches: TaskPhase[] = ["FAILED", "BLOCKED", "CANCELLED"].filter(
      (p): p is TaskPhase => p !== phase,
    );
    return [phase, [...forward, ...escapeHatches]];
  }),
) as unknown as Record<TaskPhase, readonly TaskPhase[]>;

// FAILED and BLOCKED are recoverable: allow re-entering the forward flow near
// the start rather than being dead ends like the true terminal phases.
for (const stuckPhase of ["FAILED", "BLOCKED"] as const) {
  TRANSITIONS[stuckPhase] = [...TRANSITIONS[stuckPhase], ...RECOVERABLE_FROM_STUCK];
}

export function isValidTransition(from: TaskPhase, to: TaskPhase): boolean {
  return TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Risk / approval
// ---------------------------------------------------------------------------

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const APPROVAL_STATUSES = [
  "NOT_REQUIRED",
  "PENDING",
  "APPROVED",
  "REJECTED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

export interface TaskState {
  taskId: string | null;
  objective: string | null;
  scope: string | null;
  phase: TaskPhase;
  riskLevel: RiskLevel | null;
  approvalStatus: ApprovalStatus;
  filesExpectedToChange: string[];
  testsRequired: string[];
  // Added in Milestone 4, alongside the `plan` command's task input contract
  // (src/lib/taskInput.ts). Preserved verbatim from whatever the planner
  // submitted, rather than dropped -- requestedChanges is the planner's own
  // description of the work; approvalRequirements is what the planner
  // anticipates this task will need approval for once it reaches
  // APPROVAL_REQUIRED (informational at PLANNED time -- it does not, by
  // itself, change approvalStatus; see src/lib/plan.ts).
  requestedChanges: string[];
  approvalRequirements: string[];
  result: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const EMPTY_TASK_STATE: TaskState = {
  taskId: null,
  objective: null,
  scope: null,
  phase: "PLANNED",
  riskLevel: null,
  approvalStatus: "NOT_REQUIRED",
  filesExpectedToChange: [],
  testsRequired: [],
  requestedChanges: [],
  approvalRequirements: [],
  result: null,
  createdAt: null,
  updatedAt: null,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Runtime shape check -- deliberately conservative. A hand-edited or
// corrupted TASK_STATE.json should be caught here with a clear error rather
// than silently coerced into something the rest of the CLI misinterprets.
export function isValidTaskState(value: unknown): value is TaskState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;

  const taskIdOk = v["taskId"] === null || typeof v["taskId"] === "string";
  const objectiveOk = v["objective"] === null || typeof v["objective"] === "string";
  const scopeOk = v["scope"] === null || typeof v["scope"] === "string";
  const phaseOk =
    typeof v["phase"] === "string" &&
    (LIFECYCLE_PHASES as readonly string[]).includes(v["phase"]);
  const riskLevelOk =
    v["riskLevel"] === null ||
    (typeof v["riskLevel"] === "string" &&
      (RISK_LEVELS as readonly string[]).includes(v["riskLevel"]));
  const approvalStatusOk =
    typeof v["approvalStatus"] === "string" &&
    (APPROVAL_STATUSES as readonly string[]).includes(v["approvalStatus"]);
  const filesOk = isStringArray(v["filesExpectedToChange"]);
  const testsOk = isStringArray(v["testsRequired"]);
  const requestedChangesOk = isStringArray(v["requestedChanges"]);
  const approvalRequirementsOk = isStringArray(v["approvalRequirements"]);
  const resultOk = v["result"] === null || typeof v["result"] === "string";
  const createdAtOk = v["createdAt"] === null || typeof v["createdAt"] === "string";
  const updatedAtOk = v["updatedAt"] === null || typeof v["updatedAt"] === "string";

  return (
    taskIdOk &&
    objectiveOk &&
    scopeOk &&
    phaseOk &&
    riskLevelOk &&
    approvalStatusOk &&
    filesOk &&
    testsOk &&
    requestedChangesOk &&
    approvalRequirementsOk &&
    resultOk &&
    createdAtOk &&
    updatedAtOk
  );
}

// Loads task state from disk. A missing file is not an error -- it means
// "no task has ever run yet" -- and returns a fresh EMPTY_TASK_STATE. A
// present-but-corrupt or wrong-shaped file *is* an error: we never want to
// silently paper over a broken state file and let the CLI report something
// misleading.
export function loadTaskState(filePath: string): TaskState {
  if (!fs.existsSync(filePath)) {
    return { ...EMPTY_TASK_STATE };
  }

  const raw = fs.readFileSync(filePath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Task state file at ${filePath} is not valid JSON: ${reason}`);
  }

  // Backward compatibility: TASK_STATE.json files written before Milestone 4
  // don't have requestedChanges/approvalRequirements. Their absence isn't
  // corruption -- default them to empty arrays *before* shape-validating, so
  // every pre-existing state file on disk keeps loading exactly as it did
  // before this milestone. A field that IS present but wrong-shaped is still
  // a real error, caught by isValidTaskState right below.
  const normalized: unknown =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { requestedChanges: [], approvalRequirements: [], ...(parsed as Record<string, unknown>) }
      : parsed;

  if (!isValidTaskState(normalized)) {
    throw new Error(
      `Task state file at ${filePath} does not match the expected TaskState shape.`,
    );
  }

  return normalized;
}

export function saveTaskState(filePath: string, state: TaskState): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// approve / reset
// ---------------------------------------------------------------------------

export interface ApproveResult {
  ok: boolean;
  state: TaskState;
  message: string;
}

// Moves a task from APPROVAL_REQUIRED to APPROVED. This is the *only* thing
// this command does: it does not commit, push, deploy, or touch CookVideo or
// any external system. That's deliberate -- Milestone 2 is establishing the
// approval gate itself, not the actions that happen after it.
export function approveTask(state: TaskState): ApproveResult {
  if (state.taskId === null) {
    return {
      ok: false,
      state,
      message: "No active task to approve. Run `cookvideo-agent task` to check current state.",
    };
  }

  if (state.phase === "APPROVED") {
    return {
      ok: true,
      state,
      message: `Task ${state.taskId} is already APPROVED. No change made.`,
    };
  }

  if (state.phase !== "APPROVAL_REQUIRED") {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId} is in phase ${state.phase}, not APPROVAL_REQUIRED. ` +
        "Only a task awaiting approval can be approved.",
    };
  }

  const nextState: TaskState = {
    ...state,
    phase: "APPROVED",
    approvalStatus: "APPROVED",
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    state: nextState,
    message:
      `Task ${state.taskId} approved (APPROVAL_REQUIRED -> APPROVED). ` +
      "No commit, push, or deployment has been performed -- approval only unlocks " +
      "those actions for a future step.",
  };
}

// Returns a fresh empty task state. Never touches source code or repository
// files -- callers are responsible for writing only TASK_STATE.json (and,
// per this milestone's spec, this function's return value is the only thing
// that should ever be written there by `reset`).
export function resetTaskState(): TaskState {
  return { ...EMPTY_TASK_STATE };
}

// ---------------------------------------------------------------------------
// execute (persisted lifecycle transitions -- Milestone 8)
// ---------------------------------------------------------------------------

// Prior to Milestone 8, `execute` only *validated* that a move into
// IMPLEMENTING would be legal (validateExecutionTransition in
// src/lib/execution.ts) -- it never actually persisted that transition, so
// TASK_STATE.json stayed frozen at whatever phase the task was already in,
// no matter how many times execution ran or what happened. These two
// functions are what src/lib/execution.ts now calls to make those
// transitions real, using the exact same TRANSITIONS table every other
// lifecycle check in this file already reads -- no parallel state machine.
export interface ExecutionTransitionResult {
  ok: boolean;
  state: TaskState;
  message: string;
}

// Called immediately before Claude is actually invoked (real execution
// only -- dry-run never calls this, since nothing is actually happening
// yet). A no-op if the task is already IMPLEMENTING (e.g. a retry of a
// previously-attempted task); otherwise moves it there. Defensively
// refuses if TRANSITIONS doesn't allow the move -- this should be
// unreachable in practice, since validateExecutionTransition already
// checked the exact same condition earlier in the same `execute` run, but
// this function never assumes that check happened and never invents a
// transition TRANSITIONS doesn't already define.
export function beginImplementing(state: TaskState): ExecutionTransitionResult {
  if (state.phase === "IMPLEMENTING") {
    return {
      ok: true,
      state,
      message: `Task ${state.taskId ?? "(unknown)"} is already IMPLEMENTING.`,
    };
  }
  if (!isValidTransition(state.phase, "IMPLEMENTING")) {
    return {
      ok: false,
      state,
      message: `Task ${state.taskId ?? "(unknown)"} is in phase ${state.phase}, which cannot move to IMPLEMENTING.`,
    };
  }
  const nextState: TaskState = {
    ...state,
    phase: "IMPLEMENTING",
    updatedAt: new Date().toISOString(),
  };
  return {
    ok: true,
    state: nextState,
    message: `Task ${state.taskId ?? "(unknown)"} moved ${state.phase} -> IMPLEMENTING.`,
  };
}

// Called once a real Claude invocation attempted from IMPLEMENTING has
// finished. Verified file changes (succeeded=true) advance the task to
// TESTING -- this does not mean any test actually ran; it only means
// "implementation attempted and confirmed, tests not yet run," matching the
// forward-path semantics IMPLEMENTING -> TESTING already documents.
// Anything else (a spawn error, a non-zero exit, or exit 0 with none of the
// expected files actually changed -- see verifyExpectedFilesChanged in
// src/lib/execution.ts) moves the task to FAILED, which stays recoverable
// back to PLANNED/IMPLEMENTING via the existing RECOVERABLE_FROM_STUCK path.
// `resultMessage` is stored verbatim in `result`, the same field
// `completeTask` already uses to record its own outcome.
export function applyExecutionOutcome(
  state: TaskState,
  succeeded: boolean,
  resultMessage: string,
): ExecutionTransitionResult {
  const nextPhase: TaskPhase = succeeded ? "TESTING" : "FAILED";
  if (!isValidTransition(state.phase, nextPhase)) {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId ?? "(unknown)"} is in phase ${state.phase}, which cannot move to ` +
        `${nextPhase}. Execution outcome was not persisted.`,
    };
  }
  const nextState: TaskState = {
    ...state,
    phase: nextPhase,
    result: resultMessage,
    updatedAt: new Date().toISOString(),
  };
  return {
    ok: true,
    state: nextState,
    message: `Task ${state.taskId ?? "(unknown)"} moved ${state.phase} -> ${nextPhase}.`,
  };
}

// ---------------------------------------------------------------------------
// commit / push (real git write outcomes -- Milestone 12)
//
// `cookvideo-agent commit`/`cookvideo-agent push` (src/lib/gitWrite.ts) call
// these once a real git attempt's outcome is known, exactly mirroring
// beginImplementing/applyExecutionOutcome's shape: no parallel state
// machine, every move checked against the same TRANSITIONS table every
// other lifecycle function in this file already reads.
// ---------------------------------------------------------------------------

// Called after a real `git commit` attempt (never during dry-run). A
// verified commit moves APPROVED -> COMMITTING; anything that stops a real
// commit from happening (scope mismatch, nothing to commit, detached HEAD,
// or a git add/commit failure) moves the task to FAILED, recoverable back to
// PLANNED/IMPLEMENTING via the existing RECOVERABLE_FROM_STUCK path -- the
// same "any doubt about whether the real action happened -> FAILED"
// philosophy applyExecutionOutcome already established for Claude
// invocation.
export function applyCommitOutcome(
  state: TaskState,
  succeeded: boolean,
  resultMessage: string,
): ExecutionTransitionResult {
  const nextPhase: TaskPhase = succeeded ? "COMMITTING" : "FAILED";
  if (!isValidTransition(state.phase, nextPhase)) {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId ?? "(unknown)"} is in phase ${state.phase}, which cannot move to ` +
        `${nextPhase}. Commit outcome was not persisted.`,
    };
  }
  const nextState: TaskState = {
    ...state,
    phase: nextPhase,
    result: resultMessage,
    updatedAt: new Date().toISOString(),
  };
  return {
    ok: true,
    state: nextState,
    message: `Task ${state.taskId ?? "(unknown)"} moved ${state.phase} -> ${nextPhase}.`,
  };
}

// Called after a real `git push` attempt (never during dry-run). Unlike
// applyCommitOutcome, a successful push does NOT advance the task's phase:
// COMMITTING already accurately means "committed locally," and DEPLOYING
// already means a real production deploy elsewhere in this project's
// vocabulary (.cookvideo/APPROVAL_POLICY.md lists "Git push" and "Production
// Vercel deployment" as separate items) -- advancing to DEPLOYING on a mere
// git push would falsely claim a production deploy happened. A successful
// push only updates `result`/`updatedAt` to record the confirmed push. A
// failed push (rejected, diverged, network/auth failure, or nothing to
// push) moves the task to FAILED, exactly like a failed commit -- the local
// commit itself (and its hash, already recorded in `result` by
// applyCommitOutcome) is preserved either way, since only `phase` and
// `result`/`updatedAt` change here.
export function applyPushOutcome(
  state: TaskState,
  succeeded: boolean,
  resultMessage: string,
): ExecutionTransitionResult {
  if (succeeded) {
    const nextState: TaskState = {
      ...state,
      result: resultMessage,
      updatedAt: new Date().toISOString(),
    };
    return {
      ok: true,
      state: nextState,
      message: `Task ${state.taskId ?? "(unknown)"} pushed successfully; phase remains COMMITTING.`,
    };
  }

  const nextPhase: TaskPhase = "FAILED";
  if (!isValidTransition(state.phase, nextPhase)) {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId ?? "(unknown)"} is in phase ${state.phase}, which cannot move to ` +
        "FAILED. Push outcome was not persisted.",
    };
  }
  const nextState: TaskState = {
    ...state,
    phase: nextPhase,
    result: resultMessage,
    updatedAt: new Date().toISOString(),
  };
  return {
    ok: true,
    state: nextState,
    message: `Task ${state.taskId ?? "(unknown)"} moved ${state.phase} -> FAILED.`,
  };
}

// ---------------------------------------------------------------------------
// advance (granular single-hop phase tracking -- Milestone 10)
//
// Before this, `completeTask` was the only way past TESTING: it validates
// and applies the entire remaining walk to COMPLETED in one call, including
// COMMITTING and DEPLOYING -- exactly the two phases APPROVAL_POLICY.md's
// "REQUIRES USER APPROVAL" list is about (git commit, git push, production
// deploys) -- with no individual, timestamped record of when each of those
// real-world actions actually happened. `advanceTaskPhase` lets a human
// record each one as its own hop, entirely additive: it never changes what
// `completeTask` does, and a task can still be completed in a single call
// exactly as it always could (see .cookvideo/APPROVAL_POLICY.md).
// ---------------------------------------------------------------------------

// The exact, closed set of single hops `advance` is allowed to make -- never
// the full TRANSITIONS adjacency (which would also let it claim IMPLEMENTING,
// APPROVED, or COMPLETED, each of which belongs exclusively to `execute`,
// `approve`, or `complete`). Expressed as "this target phase requires this
// exact source phase" so there is exactly one legal hop per listed target,
// never a skip-ahead.
export const ADVANCEABLE_TARGET_PHASES = [
  "REVIEW",
  "APPROVAL_REQUIRED",
  "COMMITTING",
  "DEPLOYING",
  "VERIFYING",
] as const;
export type AdvanceableTargetPhase = (typeof ADVANCEABLE_TARGET_PHASES)[number];

const ADVANCE_SOURCE_PHASE: Record<AdvanceableTargetPhase, TaskPhase> = {
  REVIEW: "TESTING",
  APPROVAL_REQUIRED: "REVIEW",
  COMMITTING: "APPROVED",
  DEPLOYING: "COMMITTING",
  VERIFYING: "DEPLOYING",
};

export function isAdvanceableTargetPhase(value: string): value is AdvanceableTargetPhase {
  return (ADVANCEABLE_TARGET_PHASES as readonly string[]).includes(value);
}

export interface AdvanceOptions {
  // Free-text, purely descriptive -- exactly like completeTask's commitHash,
  // this is never verified against git or any external system. Stored
  // verbatim (trimmed) in `result`, the same field completeTask/
  // applyExecutionOutcome already use to record their own outcome messages.
  note?: string;
}

export interface AdvanceResult {
  ok: boolean;
  state: TaskState;
  message: string;
}

// Moves a task exactly one hop along the narrow REVIEW/APPROVAL_REQUIRED/
// COMMITTING/DEPLOYING/VERIFYING seam. Unlike beginImplementing (which
// no-ops when already at the target phase), a repeated call with the same
// target on a task that has already moved past its required source phase is
// refused, not treated as idempotent -- "advance to REVIEW" only ever means
// "this task is at TESTING right now", not "get it to REVIEW somehow".
//
// Deliberately does not touch approvalStatus: whether a task actually needs
// human sign-off is entirely `requiresApprovalGate`/`completeTask`'s call
// (Milestone 7) -- a task can be walked into APPROVAL_REQUIRED here purely
// for its own audit trail without that alone ever creating an approval
// requirement that didn't already exist.
export function advanceTaskPhase(
  state: TaskState,
  toPhase: AdvanceableTargetPhase,
  options: AdvanceOptions = {},
): AdvanceResult {
  if (state.taskId === null) {
    return {
      ok: false,
      state,
      message: "No active task to advance. Run `cookvideo-agent task` to check current state.",
    };
  }

  const requiredSourcePhase = ADVANCE_SOURCE_PHASE[toPhase];
  if (state.phase !== requiredSourcePhase) {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId} is in phase ${state.phase}, but advancing to ${toPhase} requires it to ` +
        `already be in ${requiredSourcePhase}. \`cookvideo-agent advance\` only supports the single hops ` +
        "TESTING -> REVIEW, REVIEW -> APPROVAL_REQUIRED, APPROVED -> COMMITTING, COMMITTING -> DEPLOYING, " +
        "and DEPLOYING -> VERIFYING -- every other transition belongs to `execute`, `approve`, or `complete`.",
    };
  }

  // Defensive, not expected to ever differ from the check above: reuses the
  // same TRANSITIONS table every other lifecycle check in this file already
  // reads, rather than trusting ADVANCE_SOURCE_PHASE alone to be correct.
  if (!isValidTransition(state.phase, toPhase)) {
    return {
      ok: false,
      state,
      message: `Task ${state.taskId} cannot move ${state.phase} -> ${toPhase}: not a valid lifecycle transition.`,
    };
  }

  const note = options.note?.trim();
  const previousPhase = state.phase;
  const nextState: TaskState = {
    ...state,
    phase: toPhase,
    result: note && note.length > 0 ? note : state.result,
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    state: nextState,
    message:
      `Task ${state.taskId} advanced ${previousPhase} -> ${toPhase}.` +
      (note && note.length > 0 ? ` Note: ${note}` : "") +
      " No commit, push, or deployment was performed by this command -- it only records that this step happened.",
  };
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

// The canonical forward-only path from PLANNED to COMPLETED. `execute`
// (Milestone 8) now persists PLANNED/FAILED/BLOCKED -> IMPLEMENTING ->
// TESTING/FAILED via beginImplementing/applyExecutionOutcome just above, and
// `approve` only handles the single APPROVAL_REQUIRED -> APPROVED hop.
// Nothing yet persists REVIEW/APPROVAL_REQUIRED/COMMITTING/DEPLOYING/
// VERIFYING on its own, so a task that reached TESTING and was reviewed/
// committed outside this control plane still has no way to record every
// intermediate hop. `completeTask` closes that gap by validating the
// *entire* remaining walk to COMPLETED against the existing TRANSITIONS
// table (the same table isValidTransition already reads) -- it does not add
// any new transition, it only allows a single call to validate and apply
// the sequence of existing ones at once.
const FORWARD_PATH_TO_COMPLETION: readonly TaskPhase[] = [
  "PLANNED",
  "IMPLEMENTING",
  "TESTING",
  "REVIEW",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "COMMITTING",
  "DEPLOYING",
  "VERIFYING",
  "COMPLETED",
];

// A task whose declared riskLevel is above LOW, or that carries any
// planner-anticipated approvalRequirements, is exactly the kind of task
// .cookvideo/APPROVAL_POLICY.md describes as needing a human sign-off before
// it's done -- riskLevel MEDIUM/HIGH maps to "REQUIRES USER APPROVAL" /
// "ALWAYS REQUIRES USER APPROVAL" actions, and a non-empty
// approvalRequirements is the planner saying the same thing in its own
// words. A plain LOW/NOT_REQUIRED task (e.g. the Milestone 6 UI-copy shape)
// never triggers this.
export function requiresApprovalGate(state: TaskState): boolean {
  return state.riskLevel === "MEDIUM" || state.riskLevel === "HIGH" || state.approvalRequirements.length > 0;
}

// Index of APPROVAL_REQUIRED within the forward path -- used below to walk
// only *part* of FORWARD_PATH_TO_COMPLETION (up to the gate) rather than all
// the way to COMPLETED, without introducing any transition the TRANSITIONS
// table doesn't already define.
const APPROVAL_REQUIRED_INDEX = FORWARD_PATH_TO_COMPLETION.indexOf("APPROVAL_REQUIRED");

export interface CompleteOptions {
  // The CookVideo repository commit hash the human is vouching for as
  // "this is the committed implementation this task's completion refers
  // to." Purely descriptive -- completeTask never runs git itself and never
  // verifies the hash against CookVideo, since this control plane must
  // never write into, commit to, or otherwise touch that repository.
  commitHash?: string;
}

export interface CompleteResult {
  ok: boolean;
  state: TaskState;
  message: string;
}

// Moves a task all the way to COMPLETED in one step, the same load ->
// validate -> (caller) save shape as approveTask. This command performs no
// side effects of its own beyond the TaskState it returns: it never edits
// CookVideo, never runs git commit/push, and never deploys anything -- it
// only records that a task's already-committed implementation is done, and
// optionally which CookVideo commit that was.
export function completeTask(state: TaskState, options: CompleteOptions = {}): CompleteResult {
  if (state.taskId === null) {
    return {
      ok: false,
      state,
      message: "No active task to complete. Run `cookvideo-agent task` to check current state.",
    };
  }

  if (state.phase === "COMPLETED") {
    return {
      ok: true,
      state,
      message: `Task ${state.taskId} is already COMPLETED. No change made.`,
    };
  }

  // A task a human explicitly rejected, or one awaiting a human decision
  // that hasn't been made yet, must never be silently marked complete --
  // this mirrors the same REJECTED stop sign checkApprovalForExecution
  // enforces for `execute` (see src/lib/execution.ts).
  if (state.approvalStatus === "REJECTED") {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId} has approvalStatus REJECTED and cannot be completed. ` +
        "See .cookvideo/APPROVAL_POLICY.md.",
    };
  }
  if (state.approvalStatus === "PENDING") {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId} has approvalStatus PENDING. Run \`cookvideo-agent approve\` ` +
        "(or otherwise resolve the pending approval) before completing.",
    };
  }

  const pathIndex = FORWARD_PATH_TO_COMPLETION.indexOf(state.phase);
  if (pathIndex === -1) {
    return {
      ok: false,
      state,
      message:
        `Task ${state.taskId} is in phase ${state.phase}, which is not on the forward path to ` +
        "COMPLETED. Recover it to PLANNED or IMPLEMENTING first (see `cookvideo-agent plan` / " +
        "`cookvideo-agent execute`), or CANCELLED tasks cannot be completed at all.",
    };
  }

  // Risk/approval gate enforcement (Milestone 7). By this point
  // approvalStatus is either NOT_REQUIRED or APPROVED -- REJECTED and
  // PENDING were already refused above. A task that requiresApprovalGate
  // (riskLevel MEDIUM/HIGH, or a non-empty approvalRequirements) must not be
  // allowed to skip straight to COMPLETED just because nothing has ever
  // asked for its approval yet -- that would make the gate purely
  // decorative. If such a task isn't APPROVED, this drives it (using the
  // exact same isValidTransition machinery every other hop in this function
  // already relies on -- no parallel state machine) as far as
  // APPROVAL_REQUIRED/PENDING and stops there; a human must run
  // `cookvideo-agent approve` before completion can proceed.
  if (state.approvalStatus !== "APPROVED" && requiresApprovalGate(state)) {
    const riskDescription =
      `riskLevel: ${state.riskLevel ?? "not set"}` +
      (state.approvalRequirements.length > 0
        ? `, approvalRequirements: ${state.approvalRequirements.join(", ")}`
        : "");

    if (pathIndex >= APPROVAL_REQUIRED_INDEX) {
      // Already at or past the gate phase without ever being approved -- an
      // inconsistent combination no command in this control plane produces
      // on its own (APPROVED phase is only ever set alongside approvalStatus
      // APPROVED by approveTask), but still refused defensively rather than
      // silently completed.
      return {
        ok: false,
        state,
        message:
          `Task ${state.taskId} requires human approval (${riskDescription}) and has not been ` +
          "approved. Run `cookvideo-agent approve` if the task is in phase APPROVAL_REQUIRED, or " +
          "otherwise resolve this before completing. See .cookvideo/APPROVAL_POLICY.md.",
      };
    }

    for (let i = pathIndex; i < APPROVAL_REQUIRED_INDEX; i++) {
      const from = FORWARD_PATH_TO_COMPLETION[i];
      const to = FORWARD_PATH_TO_COMPLETION[i + 1];
      if (from === undefined || to === undefined || !isValidTransition(from, to)) {
        return {
          ok: false,
          state,
          message: `Task ${state.taskId} cannot reach APPROVAL_REQUIRED: ${from} -> ${to} is not a valid transition.`,
        };
      }
    }

    const gatedState: TaskState = {
      ...state,
      phase: "APPROVAL_REQUIRED",
      approvalStatus: "PENDING",
      updatedAt: new Date().toISOString(),
    };

    return {
      ok: false,
      state: gatedState,
      message:
        `Task ${state.taskId} requires human approval before it can complete (${riskDescription}). ` +
        `Moved ${state.phase} -> APPROVAL_REQUIRED (approvalStatus: PENDING). Run ` +
        "`cookvideo-agent approve` once reviewed, then re-run `cookvideo-agent complete`. " +
        "See .cookvideo/APPROVAL_POLICY.md.",
    };
  }

  // Validate every remaining hop against the existing transition table --
  // this is the same isValidTransition every other lifecycle check in this
  // file and in src/lib/execution.ts already uses, just walked across more
  // than one step. If TRANSITIONS is ever changed to no longer allow one of
  // these hops, completion correctly stops being possible too, rather than
  // silently drifting from the rest of the lifecycle engine.
  for (let i = pathIndex; i < FORWARD_PATH_TO_COMPLETION.length - 1; i++) {
    const from = FORWARD_PATH_TO_COMPLETION[i];
    const to = FORWARD_PATH_TO_COMPLETION[i + 1];
    if (from === undefined || to === undefined || !isValidTransition(from, to)) {
      return {
        ok: false,
        state,
        message: `Task ${state.taskId} cannot reach COMPLETED: ${from} -> ${to} is not a valid transition.`,
      };
    }
  }

  const result =
    options.commitHash && options.commitHash.trim().length > 0
      ? `Completed. CookVideo commit: ${options.commitHash.trim()}`
      : "Completed.";

  const nextState: TaskState = {
    ...state,
    phase: "COMPLETED",
    result,
    updatedAt: new Date().toISOString(),
  };

  return {
    ok: true,
    state: nextState,
    message:
      `Task ${state.taskId} completed (${state.phase} -> COMPLETED). ` +
      "No files were edited, and no commit, push, or deployment was performed by this command -- " +
      "it only records that already-committed work is done.",
  };
}
