import { execFileSync } from "node:child_process";

export interface GitInfo {
  isRepo: boolean;
  branch?: string;
  commit?: string;
  commitShort?: string;
  isClean?: boolean;
  changedFileCount?: number;
  error?: string;
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Reads branch/commit/dirty state from a repository at repoPath. Never throws -- any
// failure (git not installed, path not a repo, detached HEAD edge cases, etc.) is reported
// in the returned object's `error` field instead, so callers (inspect/status/tests) can
// always render something useful rather than crashing.
export function getGitInfo(repoPath: string): GitInfo {
  try {
    runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    return { isRepo: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const branch = runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const commit = runGit(repoPath, ["rev-parse", "HEAD"]);
    const commitShort = runGit(repoPath, ["rev-parse", "--short", "HEAD"]);
    const statusOutput = runGit(repoPath, ["status", "--porcelain"]);
    const changedFileCount = statusOutput.length === 0 ? 0 : statusOutput.split("\n").length;

    return {
      isRepo: true,
      branch,
      commit,
      commitShort,
      isClean: changedFileCount === 0,
      changedFileCount,
    };
  } catch (err) {
    return { isRepo: true, error: err instanceof Error ? err.message : String(err) };
  }
}
