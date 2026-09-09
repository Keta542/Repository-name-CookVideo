import fs from "node:fs";
import { RISK_LEVELS, type RiskLevel } from "./taskState.js";

// ---------------------------------------------------------------------------
// Task input contract (Milestone 4)
//
// This is the handoff boundary between an external planner (e.g. ChatGPT) and
// this control plane. It is deliberately a strict, minimal, structured
// contract -- not free text -- so `cookvideo-agent plan` can validate it
// mechanically rather than trusting prose. Nothing here executes anything;
// this module only decides whether a submitted JSON document is well-formed
// task input.
// ---------------------------------------------------------------------------

export interface TaskInput {
  taskId: string;
  objective: string;
  scope: string;
  // The planner's own description of what should change -- preserved
  // verbatim into TaskState.requestedChanges, never collapsed into
  // objective/scope.
  requestedChanges: string[];
  filesExpectedToChange: string[];
  testsRequired: string[];
  riskLevel: RiskLevel;
  // What the planner anticipates this task will need human approval for
  // once it reaches APPROVAL_REQUIRED (e.g. "git commit", "git push",
  // "production Supabase migration"). Informational at PLANNED time -- see
  // src/lib/plan.ts for why this does not, by itself, set approvalStatus.
  approvalRequirements: string[];
}

export interface TaskInputValidation {
  ok: boolean;
  value: TaskInput | null;
  // One entry per problem found. Deliberately collects every problem in a
  // single pass rather than stopping at the first, so a planner submitting a
  // bad document gets one clear, complete error report instead of playing
  // whack-a-mole one field at a time.
  errors: string[];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0;
}

// Validates an already-parsed JSON value against the TaskInput contract.
// Pure and side-effect-free -- takes no file path, so it's trivially
// unit-testable with hand-built values, and reusable anywhere a task input
// document shows up (a file today, potentially a different transport later).
export function validateTaskInput(value: unknown): TaskInputValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      value: null,
      errors: ["Task input must be a JSON object, not an array, string, number, or null."],
    };
  }

  const v = value as Record<string, unknown>;
  const errors: string[] = [];

  if (!isNonEmptyString(v["taskId"])) {
    errors.push("taskId is required and must be a non-empty string.");
  }
  if (!isNonEmptyString(v["objective"])) {
    errors.push("objective is required and must be a non-empty string.");
  }
  if (!isNonEmptyString(v["scope"])) {
    errors.push("scope is required and must be a non-empty string.");
  }
  if (!isNonEmptyStringArray(v["requestedChanges"])) {
    errors.push("requestedChanges is required and must be a non-empty array of strings.");
  }
  if (!isStringArray(v["filesExpectedToChange"])) {
    errors.push("filesExpectedToChange is required and must be an array of strings (may be empty).");
  }
  if (!isStringArray(v["testsRequired"])) {
    errors.push("testsRequired is required and must be an array of strings (may be empty).");
  }
  if (typeof v["riskLevel"] !== "string" || !(RISK_LEVELS as readonly string[]).includes(v["riskLevel"])) {
    errors.push(`riskLevel is required and must be one of: ${RISK_LEVELS.join(", ")}.`);
  }
  if (!isStringArray(v["approvalRequirements"])) {
    errors.push(
      "approvalRequirements is required and must be an array of strings (may be empty -- empty means no approval-gated actions are anticipated for this task).",
    );
  }

  if (errors.length > 0) {
    return { ok: false, value: null, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      taskId: v["taskId"] as string,
      objective: v["objective"] as string,
      scope: v["scope"] as string,
      requestedChanges: v["requestedChanges"] as string[],
      filesExpectedToChange: v["filesExpectedToChange"] as string[],
      testsRequired: v["testsRequired"] as string[],
      riskLevel: v["riskLevel"] as RiskLevel,
      approvalRequirements: v["approvalRequirements"] as string[],
    },
  };
}

// Reads and validates a task input file from disk. Every failure mode --
// missing file, malformed JSON, well-formed JSON that fails the schema --
// is returned as data (never thrown), so callers (src/lib/plan.ts, tests)
// can always render or assert on a TaskInputValidation directly.
export function readTaskInputFile(filePath: string): TaskInputValidation {
  if (!fs.existsSync(filePath)) {
    return { ok: false, value: null, errors: [`Task input file not found: ${filePath}`] };
  }

  const raw = fs.readFileSync(filePath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      value: null,
      errors: [`Task input file at ${filePath} is not valid JSON: ${reason}`],
    };
  }

  return validateTaskInput(parsed);
}
