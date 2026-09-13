import { TASK_HISTORY_PATH } from "../config.js";
import { readTaskHistoryEntries, type TaskHistoryEntry } from "../lib/taskHistory.js";

// Read-only: loads every task ever archived to .cookvideo/TASK_HISTORY.json
// (by `reset` or `plan --replace`). Never writes anything.
export function runHistory(historyPath: string = TASK_HISTORY_PATH): TaskHistoryEntry[] {
  return readTaskHistoryEntries(historyPath);
}

export function formatHistoryReport(entries: TaskHistoryEntry[]): string {
  if (entries.length === 0) {
    return [
      "CookVideo Agent -- Task History",
      "",
      "No archived tasks yet. Tasks are archived here by `cookvideo-agent reset` and",
      "`cookvideo-agent plan --replace`.",
    ].join("\n");
  }

  const lines: string[] = [
    "CookVideo Agent -- Task History",
    "",
    `${entries.length} archived task(s), oldest first:`,
    "",
  ];

  entries.forEach((entry, index) => {
    const { task } = entry;
    lines.push(
      `${index + 1}. ${task.taskId ?? "(unknown)"} -- final phase: ${task.phase}, archived via: ${entry.archivedVia}`,
    );
    lines.push(`   Risk level: ${task.riskLevel ?? "(not set)"}, approval status: ${task.approvalStatus}`);
    lines.push(`   Result: ${task.result ?? "(none)"}`);
    lines.push(`   Archived at: ${entry.archivedAt}`);
    lines.push("");
  });

  return lines.join("\n").replace(/\n+$/, "\n");
}
