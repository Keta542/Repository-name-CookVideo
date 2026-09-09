import {
  COOKVIDEO_APP_RELATIVE_PATH,
  COOKVIDEO_REPO_PATH,
  STATE_DIR,
} from "../config.js";
import { checkCookVideoRepo, type CookVideoRepoInfo } from "../lib/cookvideoRepo.js";
import { getGitInfo, type GitInfo } from "../lib/git.js";
import { checkStateDir, type StateDirInfo } from "../lib/stateDir.js";

export interface InspectResult {
  repo: CookVideoRepoInfo;
  git: GitInfo;
  stateDir: StateDirInfo;
}

// Pure data-gathering step (no console output) so it can be reused by both the `inspect`
// CLI command and the automated test that proves this actually works against the real
// CookVideo repository.
export function runInspect(): InspectResult {
  const repo = checkCookVideoRepo(COOKVIDEO_REPO_PATH, COOKVIDEO_APP_RELATIVE_PATH);
  const git = getGitInfo(COOKVIDEO_REPO_PATH);
  const stateDir = checkStateDir(STATE_DIR);
  return { repo, git, stateDir };
}

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatInspectReport(result: InspectResult): string {
  const { repo, git, stateDir } = result;
  const lines: string[] = [];

  lines.push("CookVideo Agent — inspect");
  lines.push("");
  lines.push(`CookVideo repository path: ${repo.repoPath}`);
  lines.push(`  Exists:              ${yn(repo.exists && repo.isDirectory)}`);

  if (!repo.exists || !repo.isDirectory) {
    lines.push("");
    lines.push("Repository not found at the configured path — nothing further to report.");
    lines.push("Set COOKVIDEO_REPO_PATH to override the default location if it has moved.");
  } else {
    if (!git.isRepo) {
      lines.push(`  Git repository:      no (${git.error ?? "not a git repository"})`);
    } else if (git.error) {
      lines.push(`  Git repository:      yes, but a git command failed (${git.error})`);
    } else {
      lines.push(`  Git branch:          ${git.branch}`);
      lines.push(`  Git commit:          ${git.commitShort} (${git.commit})`);
      lines.push(
        `  Working tree:        ${git.isClean ? "clean" : `dirty (${git.changedFileCount} changed file(s))`}`
      );
    }

    lines.push(`  App location:        ${repo.app.relativePath}`);
    lines.push(`    Exists:            ${yn(repo.app.exists)}`);
    lines.push(`    package.json:      ${yn(repo.app.hasPackageJson)}`);
    lines.push(`    Next.js dependency: ${yn(repo.app.hasNextDependency)}`);
  }

  lines.push("");
  lines.push(`State directory: ${stateDir.path}`);
  lines.push(`  Exists:              ${yn(stateDir.exists)}`);
  for (const [fileName, present] of Object.entries(stateDir.files)) {
    lines.push(`    ${fileName.padEnd(18)} ${present ? "present" : "MISSING"}`);
  }

  return lines.join("\n");
}
