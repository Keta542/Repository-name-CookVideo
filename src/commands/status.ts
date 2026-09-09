import path from "node:path";
import { STATE_DIR, TASK_STATE_PATH } from "../config.js";
import { readFirstContentLine } from "../lib/stateDir.js";
import { loadTaskState } from "../lib/taskState.js";
import { runInspect, type InspectResult } from "./inspect.js";

export function runStatus(): InspectResult {
  return runInspect();
}

export function formatStatusReport(result: InspectResult): string {
  const { repo, git, stateDir } = result;
  const lines: string[] = [];

  lines.push("CookVideo Agent — status");
  lines.push("");

  lines.push(`Control plane state:   ${stateDir.exists ? "present" : "MISSING"} (${stateDir.path})`);
  const missingFiles = Object.entries(stateDir.files)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (missingFiles.length > 0) {
    lines.push(`  Missing state files:  ${missingFiles.join(", ")}`);
  }

  const activeTaskLine = readFirstContentLine(path.join(STATE_DIR, "ACTIVE_TASK.md"));
  if (activeTaskLine) {
    lines.push(`  Active task:          ${activeTaskLine}`);
  }

  const taskState = loadTaskState(TASK_STATE_PATH);
  const taskLabel = taskState.taskId === null ? "none" : taskState.taskId;
  lines.push(`  Task:                 ${taskState.phase} (${taskLabel})`);

  lines.push("");

  if (!repo.exists || !repo.isDirectory) {
    lines.push(`CookVideo repository:   NOT FOUND at ${repo.repoPath}`);
    return lines.join("\n");
  }

  lines.push(`CookVideo repository:   reachable (${repo.repoPath})`);

  if (!git.isRepo || git.error) {
    lines.push(`  Git status:           unavailable (${git.error ?? "not a git repository"})`);
  } else {
    lines.push(`  Branch:               ${git.branch}`);
    lines.push(`  Commit:               ${git.commitShort}`);
    lines.push(
      `  Working tree:         ${git.isClean ? "clean" : `dirty (${git.changedFileCount} changed file(s))`}`
    );
  }

  const appStatus = !repo.app.exists
    ? "not found"
    : repo.app.hasNextDependency
      ? "found, Next.js confirmed"
      : "found, but no Next.js dependency detected";
  lines.push(`  App (${repo.app.relativePath}):        ${appStatus}`);

  return lines.join("\n");
}
