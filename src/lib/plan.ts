import fs from "node:fs";
import { readTaskInputFile } from "./taskInput.js";
import { appendTaskHistoryEntry } from "./taskHistory.js";
import { loadTaskState, saveTaskState, type TaskPhase, type TaskState } from "./taskState.js";

// ---------------------------------------------------------------------------
// Task creation / planning engine (Milestone 4)
//
// This is the orchestration behind `cookvideo-agent plan`, mirroring the
// existing split between orchestration (src/lib/*.ts) and thin CLI wiring
// (src/commands/*.ts) already used for `execute` (src/lib/execution.ts <->
// src/commands/execute.ts). It is the only thing that decides whether a
// submitted task input is allowed to become the new TASK_STATE.json.
// ---------------------------------------------------------------------------

// A task in one of these phases is mid-flight -- work, review, or a
// production-facing action either is or was about to be underway. Replacing
// it out from under itself (even with --replace) would silently discard
// that in-progress state, so these phases refuse replacement outright.
// Everything else (PLANNED -- nothing has started yet -- or a genuinely
// terminal outcome: COMPLETED, FAILED, BLOCKED, CANCELLED) is safe to
// replace.
export const REPLACEMENT_BLOCKED_PHASES: readonly TaskPhase[] = [
  "IMPLEMENTING",
  "TESTING",
  "REVIEW",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "COMMITTING",
  "DEPLOYING",
  "VERIFYING",
];

export function isSafeToReplace(phase: TaskPhase): boolean {
  return !REPLACEMENT_BLOCKED_PHASES.includes(phase);
}

// Builds a fresh TaskState from validated planner input. Every field traces
// directly back to what the planner submitted -- nothing invented. The
// lifecycle phase always starts at PLANNED (planning creates work, it never
// starts it), and approvalStatus always starts NOT_REQUIRED: the approval
// workflow itself only begins once a task reaches APPROVAL_REQUIRED (an
// execution-time concern, Milestone 2/3's territory) -- `plan` recording the
// planner's *anticipated* approvalRequirements does not, by itself, mean an
// approval is currently pending.
export function buildTaskStateFromInput(input: {
  taskId: string;
  objective: string;
  scope: string;
  requestedChanges: string[];
  filesExpectedToChange: string[];
  testsRequired: string[];
  riskLevel: TaskState["riskLevel"];
  approvalRequirements: string[];
}): TaskState {
  const now = new Date().toISOString();
  return {
    taskId: input.taskId,
    objective: input.objective,
    scope: input.scope,
    phase: "PLANNED",
    riskLevel: input.riskLevel,
    approvalStatus: "NOT_REQUIRED",
    filesExpectedToChange: input.filesExpectedToChange,
    testsRequired: input.testsRequired,
    requestedChanges: input.requestedChanges,
    approvalRequirements: input.approvalRequirements,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "_(none)_";
}

// Renders the human-readable mirror of TASK_STATE.json. Always fully
// replaces ACTIVE_TASK.md's content (this *is* "create/update ACTIVE_TASK.md"
// -- there is no partial-edit mode), matching the same information
// TASK_STATE.json holds so the two never have a chance to silently diverge.
export function formatActiveTaskMarkdown(state: TaskState): string {
  const header = [
    "# CookVideo Agent — Active Task",
    "",
    "This file is the human-readable view of the current task. The machine-readable",
    "equivalent is `.cookvideo/TASK_STATE.json`; both should always agree. See",
    "`APPROVAL_POLICY.md` for what does and doesn't require approval, and `README.md`",
    "for the full lifecycle diagram.",
    "",
  ];

  if (state.taskId === null) {
    return [...header, "**Status: no active task.**", ""].join("\n");
  }

  return [
    ...header,
    "**Status: active task recorded via `cookvideo-agent plan`.**",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Task ID | ${state.taskId} |`,
    `| Objective | ${state.objective ?? "_(none)_"} |`,
    `| Scope | ${state.scope ?? "_(none)_"} |`,
    `| Phase | ${state.phase} |`,
    `| Risk level | ${state.riskLevel ?? "_(none)_"} |`,
    `| Approval status | ${state.approvalStatus} |`,
    "",
    "**Requested changes:**",
    "",
    bulletList(state.requestedChanges),
    "",
    "**Files expected to change:**",
    "",
    bulletList(state.filesExpectedToChange),
    "",
    "**Tests required:**",
    "",
    bulletList(state.testsRequired),
    "",
    "**Approval requirements (anticipated for later phases -- not yet requested):**",
    "",
    bulletList(state.approvalRequirements),
    "",
    `Created at: ${state.createdAt ?? "(unknown)"} · Updated at: ${state.updatedAt ?? "(unknown)"}`,
    "",
    "Nothing about this record executes anything: `plan` never edits CookVideo, invokes Claude,",
    "runs `git commit`/`git push`, or touches Supabase/Vercel/Mux/GitHub.",
    "",
  ].join("\n");
}

function buildLogEntryMarkdown(state: TaskState, replaced: boolean, previousTaskId: string | null): string {
  const lines: string[] = [
    `## ${new Date().toISOString().slice(0, 10)} — Task planned via \`cookvideo-agent plan\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Objective: ${state.objective ?? "(not set)"}`,
    `- Risk level: ${state.riskLevel ?? "(not set)"}`,
    "- Phase set to PLANNED; approvalStatus set to NOT_REQUIRED (approvalRequirements recorded for",
    "  later -- the approval workflow itself has not started).",
  ];
  if (replaced) {
    lines.push(
      `- Replaced previous task ${previousTaskId ?? "(unknown)"} (was in a safe-to-replace phase).`,
    );
  }
  lines.push(
    "- Read-only with respect to CookVideo; did not invoke Claude, run `git commit`/`git push`, or",
    "  touch Supabase, Vercel, Mux, or GitHub.",
    "",
  );
  return lines.join("\n");
}

// Inserts a new entry directly under the "Newest entries at the top" marker
// (the first "---" line), rather than appending at end-of-file, so
// BUILD_LOG.md's documented ordering convention (see its own header) keeps
// holding after `plan` writes to it. Falls back to prepending at the very
// top if the file is missing or doesn't have the expected marker, rather
// than silently dropping the entry.
export function prependBuildLogEntry(buildLogPath: string, entryMarkdown: string): void {
  if (!fs.existsSync(buildLogPath)) {
    fs.writeFileSync(
      buildLogPath,
      "# CookVideo Agent — Build Log\n\nChronological record of what was built or changed in this " +
        `project. Newest entries at the\ntop.\n\n---\n\n${entryMarkdown}\n`,
      "utf8",
    );
    return;
  }

  const raw = fs.readFileSync(buildLogPath, "utf8");
  const marker = "---\n";
  const idx = raw.indexOf(marker);

  if (idx === -1) {
    fs.writeFileSync(buildLogPath, `${entryMarkdown}\n\n${raw}`, "utf8");
    return;
  }

  const insertAt = idx + marker.length;
  const before = raw.slice(0, insertAt);
  const after = raw.slice(insertAt).replace(/^\n+/, "");
  fs.writeFileSync(buildLogPath, `${before}\n${entryMarkdown}\n\n${after}`, "utf8");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface PlanContext {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
  // Milestone 11: where the outgoing task is archived when --replace
  // overwrites it -- see the archiving step in runPlan below.
  taskHistoryPath: string;
  inputFilePath: string;
  replace: boolean;
}

export interface RunPlanResult {
  ok: boolean;
  message: string;
  errors: string[];
  state: TaskState | null;
  replaced: boolean;
  previousTaskId: string | null;
  previousPhase: TaskPhase | null;
}

// The full plan flow: read + validate the task input file -> check for an
// existing active task (refuse without --replace) -> if replacing, check the
// existing task is in a safe-to-replace phase -> build the new TaskState ->
// write TASK_STATE.json, ACTIVE_TASK.md, and a BUILD_LOG.md entry.
//
// Never throws. Every refusal (bad input, existing task without --replace,
// existing task in a blocked phase) is returned as data with `state: null` --
// and, critically, TASK_STATE.json is never touched in any of those cases:
// `saveTaskState` is only ever called once, at the very end, after every
// check has already passed.
export function runPlan(ctx: PlanContext): RunPlanResult {
  const inputResult = readTaskInputFile(ctx.inputFilePath);
  if (!inputResult.ok || inputResult.value === null) {
    return {
      ok: false,
      message: "Task input validation failed. TASK_STATE.json was not modified.",
      errors: inputResult.errors,
      state: null,
      replaced: false,
      previousTaskId: null,
      previousPhase: null,
    };
  }

  const existing = loadTaskState(ctx.taskStatePath);
  const hasExistingTask = existing.taskId !== null;

  if (hasExistingTask && !ctx.replace) {
    return {
      ok: false,
      message:
        `An active task already exists: ${existing.taskId} (phase: ${existing.phase}). Pass --replace ` +
        "to replace it, or run `cookvideo-agent reset` first. TASK_STATE.json was not modified.",
      errors: [],
      state: null,
      replaced: false,
      previousTaskId: existing.taskId,
      previousPhase: existing.phase,
    };
  }

  if (hasExistingTask && ctx.replace && !isSafeToReplace(existing.phase)) {
    return {
      ok: false,
      message:
        `Existing task ${existing.taskId} is in phase ${existing.phase}, which is not a safe state to ` +
        `replace (blocked phases: ${REPLACEMENT_BLOCKED_PHASES.join(", ")}). Let it reach PLANNED, ` +
        "COMPLETED, FAILED, BLOCKED, or CANCELLED, or run `cookvideo-agent reset`, before replacing it. " +
        "TASK_STATE.json was not modified.",
      errors: [],
      state: null,
      replaced: false,
      previousTaskId: existing.taskId,
      previousPhase: existing.phase,
    };
  }

  const newState = buildTaskStateFromInput(inputResult.value);

  // Milestone 11: --replace is about to overwrite the existing task's
  // TASK_STATE.json content wholesale -- archive its full final state first,
  // so it isn't silently lost the same way `reset` used to discard it.
  // isSafeToReplace already guarantees `existing` is PLANNED or genuinely
  // terminal at this point (the blocked-phase check above already returned
  // if not), never a mid-flight snapshot.
  if (hasExistingTask) {
    appendTaskHistoryEntry(ctx.taskHistoryPath, existing, "plan --replace");
  }

  saveTaskState(ctx.taskStatePath, newState);
  fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(newState), "utf8");

  const replaced = hasExistingTask;
  prependBuildLogEntry(ctx.buildLogPath, buildLogEntryMarkdown(newState, replaced, existing.taskId));

  return {
    ok: true,
    message: replaced
      ? `Replaced task ${existing.taskId ?? "(unknown)"} (was ${existing.phase}) with ${newState.taskId}. Phase: PLANNED.`
      : `Task ${newState.taskId} planned. Phase: PLANNED.`,
    errors: [],
    state: newState,
    replaced,
    previousTaskId: existing.taskId,
    previousPhase: hasExistingTask ? existing.phase : null,
  };
}
