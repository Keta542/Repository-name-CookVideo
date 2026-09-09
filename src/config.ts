import path from "node:path";
import { fileURLToPath } from "node:url";

// AGENT_ROOT is resolved from this file's own compiled location (dist/config.js -> ../),
// not from process.cwd() — so `cookvideo-agent` behaves the same no matter what directory
// it's invoked from once installed (e.g. via `npm link`).
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const AGENT_ROOT = path.resolve(__dirname, "..");

// The CookVideo application repository this agent coordinates against. Hardcoded to its
// known real location per the project brief, but overridable via COOKVIDEO_REPO_PATH for
// local testing/CI or a future multi-machine setup — never silently guessed.
const DEFAULT_COOKVIDEO_REPO_PATH = "C:\\Users\\aesfm\\CookVideo";
export const COOKVIDEO_REPO_PATH =
  process.env.COOKVIDEO_REPO_PATH && process.env.COOKVIDEO_REPO_PATH.trim().length > 0
    ? process.env.COOKVIDEO_REPO_PATH
    : DEFAULT_COOKVIDEO_REPO_PATH;

// Where the CookVideo Next.js application lives inside that repo. Known from direct
// inspection of the repo (a monorepo with the Next.js app under apps/web) — checked for
// real by lib/cookvideoRepo.ts rather than assumed.
export const COOKVIDEO_APP_RELATIVE_PATH = path.join("apps", "web");

// This control plane's own persistent state directory (see .cookvideo/README expectations
// in each file). Lives inside CookVideoAgent, never inside the CookVideo repo.
export const STATE_DIR = path.join(AGENT_ROOT, ".cookvideo");

// The five human-readable state documents (Milestone 1) plus the approval policy reference
// and the machine-readable task state file (Milestone 2) -- kept as one list so
// `inspect`/`status` report on everything actually expected to live in .cookvideo/.
export const STATE_FILES = [
  "PROJECT_STATE.md",
  "ARCHITECTURE.md",
  "DECISIONS.md",
  "ACTIVE_TASK.md",
  "BUILD_LOG.md",
  "APPROVAL_POLICY.md",
  "EXECUTION_POLICY.md",
  "TASK_STATE.json",
  "EXECUTION_LOG.json",
] as const;

// The machine-readable task/approval state file. Read and written only through
// src/lib/taskState.ts -- never edited by hand while the CLI is in use.
export const TASK_STATE_PATH = path.join(STATE_DIR, "TASK_STATE.json");

// ---------------------------------------------------------------------------
// Milestone 3: Claude execution adapter configuration
// ---------------------------------------------------------------------------

// The only two execution modes the adapter understands. "dry-run" never invokes any
// external process -- it only prepares and displays what *would* run. "local" allows the
// adapter to actually spawn the configured Claude command on this machine. Everything else
// (commit, push, deploy, production access) stays approval-gated regardless of mode; this
// setting only controls whether Claude itself may be invoked as a local process.
export const EXECUTION_MODES = ["dry-run", "local"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

const DEFAULT_EXECUTION_MODE: ExecutionMode = "dry-run";

// Fail-safe by construction: any value that isn't exactly "dry-run" or "local" -- unset,
// empty, misspelled, garbage -- resolves to "dry-run" rather than throwing or, worse,
// silently falling through to real execution. Getting this wrong in the "local" direction
// would mean a typo'd environment variable could let this control plane invoke a real
// process against the developer's machine; getting it wrong in the "dry-run" direction is
// merely inconvenient. So the fallback is always the safe one.
export function parseExecutionMode(raw: string | undefined): ExecutionMode {
  if (raw === "dry-run" || raw === "local") {
    return raw;
  }
  return DEFAULT_EXECUTION_MODE;
}

export const EXECUTION_MODE_ENV_VAR = "COOKVIDEO_AGENT_EXECUTION_MODE";
export const EXECUTION_MODE: ExecutionMode = parseExecutionMode(
  process.env[EXECUTION_MODE_ENV_VAR],
);

// The local command used to invoke Claude Code, configurable rather than assumed -- this
// project does not hardcode a specific executable name or install path. Only read/used when
// EXECUTION_MODE is "local" *and* the CLI was invoked with --execute; in dry-run mode this
// value is only ever displayed, never executed.
export const CLAUDE_COMMAND_ENV_VAR = "COOKVIDEO_AGENT_CLAUDE_COMMAND";
const DEFAULT_CLAUDE_COMMAND = "claude";
export const CLAUDE_COMMAND: string =
  process.env[CLAUDE_COMMAND_ENV_VAR] && process.env[CLAUDE_COMMAND_ENV_VAR]!.trim().length > 0
    ? process.env[CLAUDE_COMMAND_ENV_VAR]!
    : DEFAULT_CLAUDE_COMMAND;

// Where prepared implementation briefs are written before (or instead of) being handed to
// Claude. Kept inside .cookvideo/, out of CookVideo, and git-ignored (briefs are working
// artifacts, not source-controlled documents).
export const BRIEFS_DIR = path.join(STATE_DIR, "briefs");

// Append-only, machine-readable record of every execution attempt (dry-run or real),
// separate from TASK_STATE.json so task state stays a snapshot of "where is this task now"
// rather than a log of every execution attempt against it.
export const EXECUTION_LOG_PATH = path.join(STATE_DIR, "EXECUTION_LOG.json");
