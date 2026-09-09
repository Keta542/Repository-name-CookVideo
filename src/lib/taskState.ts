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
