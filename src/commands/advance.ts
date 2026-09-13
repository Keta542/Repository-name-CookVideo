import fs from "node:fs";
import { ACTIVE_TASK_PATH, BUILD_LOG_PATH, TASK_STATE_PATH } from "../config.js";
import { formatActiveTaskMarkdown, prependBuildLogEntry } from "../lib/plan.js";
import {
  ADVANCEABLE_TARGET_PHASES,
  advanceTaskPhase,
  isAdvanceableTargetPhase,
  loadTaskState,
  saveTaskState,
  type AdvanceOptions,
  type AdvanceableTargetPhase,
  type TaskPhase,
  type TaskState,
} from "../lib/taskState.js";

// Paths are injectable (mirroring ApproveContext/CompleteContext) so tests
// can exercise the full TASK_STATE.json + ACTIVE_TASK.md + BUILD_LOG.md
// write behavior against a temp directory, never the real .cookvideo/
// files. `cookvideo-agent advance` (src/cli.ts) calls this with only
// `toPhase`/`options`, which resolves the context to the real configured
// paths.
export interface AdvanceContext {
  taskStatePath: string;
  activeTaskPath: string;
  buildLogPath: string;
}

const DEFAULT_ADVANCE_CONTEXT: AdvanceContext = {
  taskStatePath: TASK_STATE_PATH,
  activeTaskPath: ACTIVE_TASK_PATH,
  buildLogPath: BUILD_LOG_PATH,
};

export interface RunAdvanceResult {
  ok: boolean;
  message: string;
}

// Parses `cookvideo-agent advance --to <PHASE> [--note <text>]`. Kept as its
// own pure function (rather than inlined in src/cli.ts) so it stays
// unit-testable -- importing src/cli.ts itself triggers process.exit as a
// side effect of module load, so nothing in that file can safely be
// imported from a test.
export interface ParsedAdvanceCliArgs {
  toPhase: AdvanceableTargetPhase | null;
  // Present (and non-null) only when --to was supplied but isn't one of the
  // five advanceable target phases -- distinct from `toPhase: null` (--to
  // omitted entirely) so the CLI can report a precise, distinct error either
  // way.
  invalidToValue: string | null;
  options: AdvanceOptions;
}

export function parseAdvanceCliArgs(rest: string[]): ParsedAdvanceCliArgs {
  const toFlagIndex = rest.indexOf("--to");
  const toValue = toFlagIndex !== -1 ? rest[toFlagIndex + 1] : undefined;

  const noteFlagIndex = rest.indexOf("--note");
  const note = noteFlagIndex !== -1 ? rest[noteFlagIndex + 1] : undefined;

  if (toValue === undefined) {
    return { toPhase: null, invalidToValue: null, options: note !== undefined ? { note } : {} };
  }
  if (!isAdvanceableTargetPhase(toValue)) {
    return { toPhase: null, invalidToValue: toValue, options: note !== undefined ? { note } : {} };
  }
  return { toPhase: toValue, invalidToValue: null, options: note !== undefined ? { note } : {} };
}

function advanceBuildLogEntry(state: TaskState, previousPhase: TaskPhase): string {
  const lines: string[] = [
    `## ${new Date().toISOString().slice(0, 10)} — Task advanced via \`cookvideo-agent advance\`: ${state.taskId ?? "(unknown)"}`,
    "",
    `- Phase: ${previousPhase} -> ${state.phase}.`,
  ];
  if (state.result !== null) {
    lines.push(`- Note: ${state.result}`);
  }
  lines.push(
    "- No commit, push, or deployment was performed by this command -- it only records that this",
    "  step happened.",
    "",
  );
  return lines.join("\n");
}

// Loads the real on-disk task state, attempts to advance it to `toPhase`,
// and -- only when the attempt actually changed the state (never on a
// refusal, which returns the exact same state reference it was given) --
// writes TASK_STATE.json, ACTIVE_TASK.md, and a BUILD_LOG.md entry, using
// the same helpers `plan`/`approve`/`complete` already use so the three
// documents can never be left disagreeing with each other. This command
// never edits CookVideo, never runs git commit/push, and never deploys
// anything -- it only records that a human says a lifecycle step happened.
export function runAdvance(
  toPhase: AdvanceableTargetPhase,
  options: AdvanceOptions = {},
  ctx: AdvanceContext = DEFAULT_ADVANCE_CONTEXT,
): RunAdvanceResult {
  const state = loadTaskState(ctx.taskStatePath);
  const previousPhase = state.phase;
  const result = advanceTaskPhase(state, toPhase, options);

  if (result.state !== state) {
    saveTaskState(ctx.taskStatePath, result.state);
    fs.writeFileSync(ctx.activeTaskPath, formatActiveTaskMarkdown(result.state), "utf8");
    prependBuildLogEntry(ctx.buildLogPath, advanceBuildLogEntry(result.state, previousPhase));
  }

  return { ok: result.ok, message: result.message };
}

export const ADVANCE_TARGET_PHASES_HELP = ADVANCEABLE_TARGET_PHASES.join("|");
