import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendTaskHistoryEntry, readTaskHistoryEntries } from "../lib/taskHistory.js";
import { formatHistoryReport, runHistory } from "../commands/history.js";
import { EMPTY_TASK_STATE, type TaskState } from "../lib/taskState.js";

function tempHistoryPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-taskhistory-"));
  return path.join(dir, "TASK_HISTORY.json");
}

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...EMPTY_TASK_STATE,
    taskId: "T-001",
    phase: "COMPLETED",
    result: "Completed.",
    ...overrides,
  };
}

test("readTaskHistoryEntries returns an empty array when the file does not exist", () => {
  const historyPath = tempHistoryPath();
  assert.deepEqual(readTaskHistoryEntries(historyPath), []);
});

test("readTaskHistoryEntries returns an empty array for a corrupt file rather than throwing", () => {
  const historyPath = tempHistoryPath();
  fs.writeFileSync(historyPath, "{ not valid json", "utf8");
  assert.deepEqual(readTaskHistoryEntries(historyPath), []);
});

test("appendTaskHistoryEntry creates the file and directory on the first archive", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookvideo-agent-taskhistory-"));
  const historyPath = path.join(dir, "nested", "TASK_HISTORY.json");

  appendTaskHistoryEntry(historyPath, task(), "reset");

  const entries = readTaskHistoryEntries(historyPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.archivedVia, "reset");
  assert.equal(entries[0]?.task.taskId, "T-001");
  assert.match(entries[0]?.archivedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

test("appendTaskHistoryEntry appends, preserving insertion order and both archive reasons", () => {
  const historyPath = tempHistoryPath();

  appendTaskHistoryEntry(historyPath, task({ taskId: "FIRST" }), "reset");
  appendTaskHistoryEntry(historyPath, task({ taskId: "SECOND" }), "plan --replace");

  const entries = readTaskHistoryEntries(historyPath);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.task.taskId, "FIRST");
  assert.equal(entries[0]?.archivedVia, "reset");
  assert.equal(entries[1]?.task.taskId, "SECOND");
  assert.equal(entries[1]?.archivedVia, "plan --replace");
});

// ---------------------------------------------------------------------------
// runHistory / formatHistoryReport (cookvideo-agent history)
// ---------------------------------------------------------------------------

test("formatHistoryReport reports no archived tasks when the log is empty", () => {
  const report = formatHistoryReport([]);
  assert.match(report, /No archived tasks yet/);
});

test("runHistory reads whatever appendTaskHistoryEntry wrote, and formatHistoryReport lists it", () => {
  const historyPath = tempHistoryPath();
  appendTaskHistoryEntry(historyPath, task({ taskId: "T-REPORTED", phase: "COMPLETED", result: "Completed. CookVideo commit: abc123" }), "reset");

  const entries = runHistory(historyPath);
  const report = formatHistoryReport(entries);

  assert.match(report, /T-REPORTED/);
  assert.match(report, /final phase: COMPLETED/);
  assert.match(report, /archived via: reset/);
  assert.match(report, /CookVideo commit: abc123/);
});
