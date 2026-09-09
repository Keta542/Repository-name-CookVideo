# CookVideo Agent

A local engineering orchestration control plane for the CookVideo project. This is
infrastructure, not part of the CookVideo application — it lives in its own repository at
`C:\Users\aesfm\CookVideoAgent`, entirely separate from `C:\Users\aesfm\CookVideo`.

## What this is

CookVideo development is coordinated across three actors:

- **ChatGPT** — planner / orchestrator. Decides what should happen next.
- **Claude** (Claude Code) — autonomous implementation engineer. Does the actual work in
  the CookVideo repository: writes code, runs checks, reports results.
- **CookVideo Agent** (this project) — the control plane. Gives both of the above a shared,
  verifiable view of the CookVideo repository's actual current state, instead of relying on
  memory or assumption carried between separate sessions.

Two more pieces the control plane is built around:

- **Git** is the source of truth / transaction history for the CookVideo repository —
  branch, commit, and clean/dirty state are always read directly from git, never inferred
  or guessed.
- **Tools** are what the control plane (and eventually the agents it coordinates) can act
  through. Today: the filesystem and Git, read-only, plus a local task/approval state
  machine (see below). Planned, not yet built: running the CookVideo test suite, and —
  later, deliberately, one at a time, only when a concrete task needs it — authenticated
  access to Supabase, Vercel, Mux, and GitHub.

## What this is not

- Not part of the CookVideo Next.js application.
- Not a place that holds production credentials of any kind.
- Not (yet) able to write to the CookVideo repository, or to Supabase, Vercel, or Mux.
- Not (yet) able to commit, push, or deploy anything, even with approval recorded — the
  approval gate exists now; the actions it will eventually unlock do not yet.
- Not, even with the Claude execution adapter (Milestone 3) added, able to invoke Claude for
  real by default — `execute` runs in SAFE/DRY-RUN mode unless both an explicit flag and an
  explicit environment variable are set (see "Claude execution adapter" below).

## Requirements

- Node.js 20+
- Git
- The CookVideo repository present at `C:\Users\aesfm\CookVideo` (or set
  `COOKVIDEO_REPO_PATH` to point elsewhere)

## Install

```sh
npm install
npm run build
```

No `npm link` or global install is required for development. Every command below runs
through an npm script or the local project CLI (`node dist/cli.js`) directly against the
`dist/` build in this repository.

## Usage

The supported way to run this CLI during development is through npm scripts (each builds
first, then runs):

```sh
npm run inspect   # Verify the CookVideo repo + this control plane's own state
npm run status    # Concise human-readable summary of current engineering state
npm run task      # Show the current task's lifecycle phase, risk and approval status
npm run approve   # Move a task from APPROVAL_REQUIRED to APPROVED (no commit/push/deploy)
npm run reset     # Reset task state to empty (does not delete source or repo files)
npm run execute   # Prepare (SAFE/DRY-RUN by default) a Claude implementation attempt
```

Equivalently, once built, invoke the local CLI entry point directly:

```sh
node dist/cli.js inspect
node dist/cli.js status
node dist/cli.js task
node dist/cli.js approve
node dist/cli.js reset
node dist/cli.js execute [--execute]
node dist/cli.js help
```

The package still declares a `cookvideo-agent` bin (see `package.json`), so `npm link` (or
a global install) remains available later if you want the bare `cookvideo-agent` command on
your PATH — e.g. on a normal Windows environment. It is optional and not part of the
supported development workflow in this repository.

### `inspect`

Read-only. Reports:

- Whether the CookVideo repository exists at the configured path
- Current git branch, commit, and whether the working tree is clean or dirty
- Whether the Next.js application (`apps/web`) exists there and genuinely declares a `next`
  dependency (checked by reading `package.json`, not assumed)
- Whether this control plane's own `.cookvideo/` state directory and its files exist

### `status`

A condensed version of the same information, meant to be glanced at: the first line of
`.cookvideo/ACTIVE_TASK.md` if one is recorded, plus a one-line task summary
(`Task: <phase> (<taskId or "none">)`) read from `.cookvideo/TASK_STATE.json`.

### `task`

Prints the current task's full state: task ID, objective, scope, phase, risk level,
approval status, files expected to change, tests required, timestamps, and result. Prints
"No active task" if `.cookvideo/TASK_STATE.json` has no task recorded.

### `approve`

The only thing this command does is move a task from `APPROVAL_REQUIRED` to `APPROVED` in
`.cookvideo/TASK_STATE.json`. It refuses (non-zero exit) if there is no active task or the
task isn't awaiting approval, and no-ops (still exit 0) if the task is already approved.
**It never commits, pushes, or deploys anything** — see "Task lifecycle and approval
gates" below for why that's deliberate at this stage.

### `reset`

Overwrites `.cookvideo/TASK_STATE.json` with a fresh empty state (phase `PLANNED`, no task
ID). Never deletes source code, repository files, or any other `.cookvideo/` document.

### `execute`

Prepares (and, only when explicitly allowed, runs) a Claude implementation attempt for the
current task. See "Claude execution adapter" below for the full architecture and safety
model — in short: **defaults to SAFE/DRY-RUN**, prints everything about the proposed
execution, and never invokes an external process unless both `--execute` is passed on the
command line *and* `COOKVIDEO_AGENT_EXECUTION_MODE=local` is set in the environment.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src
npm test             # builds, then runs the integration + unit test suite
```

`npm test` includes both an integration test against the real, configured CookVideo
repository (`src/__tests__/inspect.test.ts`, read-only) and unit tests for the task/approval
engine (`src/__tests__/taskState.test.ts`), which use temporary files and never touch the
real `.cookvideo/TASK_STATE.json`.

## Project state (`.cookvideo/`)

Living documents this control plane (and future sessions of Claude/ChatGPT working through
it) read and update over time:

| File | Purpose |
|---|---|
| `PROJECT_STATE.md` | Current known facts about CookVideo, dated, unknowns marked explicitly |
| `ARCHITECTURE.md` | This control plane's own architecture (longer version of the summary above) |
| `DECISIONS.md` | Decisions about the control plane itself |
| `ACTIVE_TASK.md` | Human-readable view of what's currently being worked on through this control plane |
| `BUILD_LOG.md` | Chronological record of what was built/changed here |
| `APPROVAL_POLICY.md` | What CookVideo Agent may do automatically vs. what requires human approval |
| `EXECUTION_POLICY.md` | What the Claude execution adapter may do in DRY-RUN vs. LOCAL mode |
| `TASK_STATE.json` | Machine-readable current task state — the source `task`/`approve`/`reset` operate on |
| `EXECUTION_LOG.json` | Append-only record of every `execute` attempt (dry-run or real), one entry per run |

## Task lifecycle and approval gates

Every unit of work this control plane tracks moves through a fixed set of phases,
recorded in `.cookvideo/TASK_STATE.json` (machine-readable) and mirrored in
`.cookvideo/ACTIVE_TASK.md` (human-readable):

```
PLANNED → IMPLEMENTING → TESTING → REVIEW → APPROVAL_REQUIRED → APPROVED
  → COMMITTING → DEPLOYING → VERIFYING → COMPLETED
```

Any non-terminal phase can also move to `FAILED`, `BLOCKED`, or `CANCELLED`; a task that
lands in `FAILED` or `BLOCKED` can re-enter the flow near the start (`PLANNED` or
`IMPLEMENTING`) rather than being a dead end. `COMPLETED` and `CANCELLED` are terminal —
nothing moves out of them; starting fresh means `npm run reset` (or `node dist/cli.js reset`).

The lifecycle exists to enforce `.cookvideo/APPROVAL_POLICY.md`'s three categories:

- **AUTOMATIC** — reading files, inspecting the repository, editing/creating source files,
  running local tests, lint, or typecheck, inspecting git diff/status. A task can move
  through `PLANNED` → `IMPLEMENTING` → `TESTING` → `REVIEW` on its own for actions like
  these.
- **REQUIRES USER APPROVAL** — git commit, git push, a production Supabase migration, a
  production Vercel deployment, production Mux configuration changes. A task needing any of
  these must reach `APPROVAL_REQUIRED` and stop there until a human runs
  `npm run approve` (or `node dist/cli.js approve`).
- **ALWAYS REQUIRES USER APPROVAL** — deleting production data, destructive database
  operations, deleting large groups of project files, changing production secrets. Same
  gate, no exceptions, ever.

As of this milestone, `approve` only flips `APPROVAL_REQUIRED` → `APPROVED`. It does not
commit, push, deploy, or perform the approved action — that's deliberate. The goal of this
milestone was to establish the safety/approval model itself before this control plane is
given the ability to perform any consequential action. Wiring `APPROVED` tasks up to
actually *doing* the commit/push/deploy step is future work, and will be its own
explicitly-scoped milestone.

## Claude execution adapter

Milestone 3 adds the first controlled bridge between this control plane and Claude Code —
`src/agents/claude.ts` — and the orchestration around it, `src/lib/execution.ts`.

### Architecture

- **`src/agents/claude.ts`** — the adapter. Deliberately *not* a clipboard/chat-window
  automation system; it is a command/process boundary. It knows how to:
  - render a `TaskState` into a structured, markdown `ImplementationBrief`
    (`formatImplementationBrief`) — objective, scope, files, tests, risk, approval status,
    each traced directly from `TASK_STATE.json`, never invented;
  - build the exact local command that would invoke Claude (`buildClaudeCommand`) — a pure
    function, so what dry-run prints is guaranteed to match what local mode would actually
    run;
  - invoke that command and capture its outcome (`invokeClaude`) — spawns via
    `node:child_process`, and, matching the same never-throws philosophy as
    `src/lib/git.ts`, always *resolves* with a structured result (`exitCode`, `stdout`,
    `stderr`, or a `spawnError` if the process couldn't even start) rather than throwing.
- **`src/lib/execution.ts`** — the orchestration/validation layer, and the only thing that
  ever decides whether `invokeClaude` gets called. Given the current task state, it:
  1. validates a task actually exists (`validateTaskExists`);
  2. validates the requested lifecycle transition, reusing the same transition table
     `approve`/`reset` are built on (`validateExecutionTransition`, via
     `isValidTransition` in `src/lib/taskState.ts`) — a task must already be
     `IMPLEMENTING`, or in a phase that can validly move there;
  3. checks the approval policy (`checkApprovalForExecution`) — refuses a task whose
     `approvalStatus` is `REJECTED`; everything else is allowed to proceed, since
     "let Claude attempt implementation" is an `AUTOMATIC` action under
     `APPROVAL_POLICY.md`, distinct from commit/push/deploy;
  4. prepares the implementation brief and writes it to `.cookvideo/briefs/`;
  5. builds the command that would run it;
  6. decides, via the double gate described below, whether to actually invoke it;
  7. appends one record of the attempt to `.cookvideo/EXECUTION_LOG.json`.
- **`src/commands/execute.ts`** — thin CLI wiring: reads configuration
  (`src/config.ts`), builds an `ExecuteContext`, calls `runExecution`, and formats the
  report `cookvideo-agent execute` prints.

### Dry-run behavior (default)

`COOKVIDEO_AGENT_EXECUTION_MODE` defaults to `dry-run` if unset or set to anything other
than exactly `dry-run` or `local` (`parseExecutionMode` in `src/config.ts` fails safe —
a typo or empty value can never accidentally enable real execution). In dry-run mode,
`cookvideo-agent execute`:

- loads the current task and prints its objective, allowed scope, expected files, required
  tests, and approval requirements;
- writes the implementation brief to `.cookvideo/briefs/<taskId>.md` (a working artifact,
  git-ignored — no change to CookVideo, and nothing outside this repository);
- prints the *exact* command that would be invoked;
- clearly states that no command was executed and why (dry-run mode, or the `--execute`
  flag not being passed);
- records the attempt in `.cookvideo/EXECUTION_LOG.json`.

No external process is ever spawned in this mode.

### Local execution behavior

Real execution requires a **double gate** — both of the following, together:

1. `COOKVIDEO_AGENT_EXECUTION_MODE=local` in the environment, and
2. the `--execute` flag passed on the command line (`cookvideo-agent execute --execute`).

Either one missing falls back to dry-run behavior. When both are set, the adapter spawns
the configured Claude command (`COOKVIDEO_AGENT_CLAUDE_COMMAND`, default `claude` — never a
hardcoded path or executable assumption) against the prepared brief, and captures its exit
code, stdout, and stderr. A process that fails to start (bad command, permission error) or
exits non-zero is reported as a failed execution, not thrown as an error — the CLI always
exits cleanly with a report, even on failure.

See `.cookvideo/EXECUTION_POLICY.md` for the full DRY-RUN/LOCAL policy text.

### Approval boundaries

Nothing about the execution adapter changes `.cookvideo/APPROVAL_POLICY.md`. Letting Claude
attempt an implementation (edit files, run tests, in the configured working directory) is
an `AUTOMATIC` action; commit, push, any production Supabase/Vercel/Mux/GitHub action, and
any destructive operation remain `REQUIRES USER APPROVAL` / `ALWAYS REQUIRES USER APPROVAL`
exactly as before, gated by `cookvideo-agent approve` — `execute` does not commit, push, or
deploy anything, in either dry-run or local mode. The only thing execution mode controls is
whether Claude itself may be invoked as a local process.

## Current milestone

**Milestone 3 (this one):** the Claude execution adapter (`src/agents/claude.ts`) and the
task execution module (`src/lib/execution.ts`) built around it, plus the `execute` CLI
command. Defaults to SAFE/DRY-RUN; real execution requires an explicit `--execute` flag
*and* `COOKVIDEO_AGENT_EXECUTION_MODE=local`, both together. No write access to CookVideo —
the adapter's working directory is always this repository, never CookVideo. No credentials
hardcoded anywhere. Commit/push/deploy and all production systems (Supabase, Vercel, Mux,
GitHub) remain exactly as approval-gated as they were before this milestone — this
milestone does not unlock any of them.

**Milestone 2:** the task and approval engine. Structured task state
(`TASK_STATE.json` + `ACTIVE_TASK.md`), the lifecycle and approval policy described above,
and the `task` / `approve` / `reset` CLI commands. `approve` only changes state — it does
not commit, push, or deploy anything. Completed and approved before this milestone began.

**Milestone 1:** a read-only scaffold — `inspect` and `status` only. Completed and
approved before Milestone 2 began.
