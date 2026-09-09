import { TASK_STATE_PATH } from "../config.js";
import { loadTaskState, type TaskState } from "../lib/taskState.js";

export function runTask(): TaskState {
  return loadTaskState(TASK_STATE_PATH);
}

export function formatTaskReport(state: TaskState): string {
  if (state.taskId === null) {
    return [
      "CookVideo Agent -- Current Task",
      "",
      "No active task.",
      `Phase: ${state.phase}`,
      `Approval status: ${state.approvalStatus}`,
    ].join("\n");
  }

  const lines: string[] = [
    "CookVideo Agent -- Current Task",
    "",
    `Task ID:          ${state.taskId}`,
    `Objective:        ${state.objective ?? "(not set)"}`,
    `Scope:             ${state.scope ?? "(not set)"}`,
    `Phase:             ${state.phase}`,
    `Risk level:        ${state.riskLevel ?? "(not set)"}`,
    `Approval status:   ${state.approvalStatus}`,
  ];

  lines.push(
    `Files expected to change: ${
      state.filesExpectedToChange.length > 0 ? state.filesExpectedToChange.join(", ") : "(none listed)"
    }`,
  );
  lines.push(
    `Tests required:    ${state.testsRequired.length > 0 ? state.testsRequired.join(", ") : "(none listed)"}`,
  );
  lines.push(`Created at:        ${state.createdAt ?? "(unknown)"}`);
  lines.push(`Updated at:        ${state.updatedAt ?? "(unknown)"}`);
  lines.push(`Result:            ${state.result ?? "(no result yet)"}`);

  return lines.join("\n");
}
