import fs from "node:fs";
import path from "node:path";
import type { TaskState } from "./taskState.js";

// ---------------------------------------------------------------------------
// Task history (Milestone 11)
//
// `reset` and `plan --replace` both overwrite TASK_STATE.json, discarding
// whatever task was previously active -- including one that just reached
// COMPLETED. This mirrors the exact append-only pattern EXECUTION_LOG.json
// already established (src/lib/execution.ts) for the same reason: a
// structured, machine-queryable record of what happened, kept separate from
// the "what's active right now" snapshot TASK_STATE.json is.
// ---------------------------------------------------------------------------

// Which command caused a task to leave the active slot. Both are the only
// two places that ever overwrite TASK_STATE.json's content wholesale --
// every other command (execute/approve/advance/complete) mutates the
// existing task in place, never removes it.
export type TaskHistoryArchiveReason = "reset" | "plan --replace";

export interface TaskHistoryEntry {
  archivedAt: string;
  archivedVia: TaskHistoryArchiveReason;
  // The full outgoing TaskState, verbatim -- nothing summarized or dropped,
  // matching ExecutionRecord's own "record exactly what happened" approach.
  task: TaskState;
}

function readTaskHistoryFile(historyPath: string): TaskHistoryEntry[] {
  if (!fs.existsSync(historyPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(historyPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TaskHistoryEntry[]) : [];
  } catch {
    // A corrupt or unreadable history file should never block reset/plan --
    // it's an audit trail, not the source of truth (TASK_STATE.json is).
    return [];
  }
}

export function readTaskHistoryEntries(historyPath: string): TaskHistoryEntry[] {
  return readTaskHistoryFile(historyPath);
}

// Appends one archived task, creating the file (and its containing
// directory) if this is the first archive ever recorded. Never called for a
// null-taskId (empty) state -- callers (reset/plan) check that first, since
// there is nothing meaningful to archive from an already-empty slot.
export function appendTaskHistoryEntry(
  historyPath: string,
  task: TaskState,
  archivedVia: TaskHistoryArchiveReason,
): void {
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const existing = readTaskHistoryFile(historyPath);
  existing.push({ archivedAt: new Date().toISOString(), archivedVia, task });
  fs.writeFileSync(historyPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}
