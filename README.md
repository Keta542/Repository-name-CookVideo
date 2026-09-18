# CookVideo Agent

A local engineering orchestration control plane for the CookVideo project. This is
infrastructure, not part of the CookVideo application — it lives in its own repository at
`C:\Users\aesfm\CookVideoAgent`, entirely separate from `C:\Users\aesfm\CookVideo`.

## What this is

CookVideo development is coordinated across three actors:

- **ChatGPT** — the planner. Decides what should happen next at a product and task level,
  and hands that decision to this control plane as a structured JSON task definition (see
  "Planner → task creation interface" below) — never by talking to Claude, git, or
  CookVideo directly.
- **Claude** (Claude Code) — the implementation engineer. Reads a task's implementation
  brief and, only when explicitly allowed to, does the actual work in the CookVideo
  repository: writes code, runs checks, reports results.
- **CookVideo Agent** (this project) — the control plane. Gives both of the above a shared,
  verifiable view of the CookVideo repository's actual current state and the current task's
  actual state, instead of relying on memory or assumption carried between separate
  sessions.

The **JSON task contract** (`src/lib/taskInput.ts`) is the handoff boundary between the
planner and this control plane: ChatGPT never edits `TASK_STATE.json` by hand or talks to
Claude directly — it submits a task definition, `cookvideo-agent plan` validates and
records it, and everything downstream (execution, approval, commit) reads from that one
recorded state. `plan` only ever creates a task in the `PLANNED` phase; it never starts
work. Actually invoking Claude (`cookvideo-agent execute --execute`) and actually
committing/pushing (gated behind `cookvideo-agent approve`) are each their own, separately
approval-gated steps — planning is deliberately the only ungated step in the whole
pipeline, because it only ever records intent, never acts on it.

Two more pieces the control plane is built around:

- **Git** is the source of truth / transaction history for the CookVideo repository —
  branch, commit, and clean/dirty state are always read directly from git, never inferred
  or guessed.
- **Tools** are what the control plane (and eventually the agents it coordinates) can act
  through. Today: the filesystem and Git, read-only; a local task/approval state machine (see
  below); and, as of Milestone 13, running CookVideo's own real test suite (`cookvideo-agent
  test`). Planned, not yet built — later, deliberately, one at a time, only when a concrete
  task needs it — authenticated access to Supabase, Vercel, Mux, and GitHub.

## What this is not

- Not part of the CookVideo Next.js application.
- Not a place that holds production credentials of any kind.
- Not (yet) able to write to the CookVideo repository's source files, or to Supabase,
  Vercel, or Mux.
- Not (yet) able to deploy anything, even with approval recorded. Real `git commit`/`git
  push` against the CookVideo repository *is* built (Milestone 12, `cookvideo-agent
  commit`/`cookvideo-agent push`) but stays behind its own double gate and only ever
  targets `APPROVED` tasks — see "Git commit/push" below.
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
npm run history   # List every task archived to TASK_HISTORY.json by reset/plan --replace
npm run approve   # Move a task from APPROVAL_REQUIRED to APPROVED (no commit/push/deploy)
npm run advance -- --to <phase> [--note <text>]   # Record a single real-world lifecycle step
npm run reset     # Reset task state to empty (does not delete source or repo files)
npm run execute   # Prepare (SAFE/DRY-RUN by default) a Claude implementation attempt
npm run plan -- --file <path> [--replace]   # Submit a planner's JSON task definition
npm run commit -- [--execute]   # Requires phase APPROVED; real git commit is SAFE/DRY-RUN by default
npm run push -- [--execute]     # Requires phase COMMITTING; real git push is SAFE/DRY-RUN by default
npm run cookvideo-test -- [--execute]   # Requires phase TESTING; real CookVideo `npm test` is SAFE/DRY-RUN by default
```

Equivalently, once built, invoke the local CLI entry point directly:

```sh
node dist/cli.js inspect
node dist/cli.js status
node dist/cli.js task
node dist/cli.js history
node dist/cli.js approve
node dist/cli.js advance --to <phase> [--note <text>]
node dist/cli.js reset
node dist/cli.js execute [--execute]
node dist/cli.js plan --file <path> [--replace]
node dist/cli.js commit [--execute]
node dist/cli.js push [--execute]
node dist/cli.js test [--execute]
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

### `history`

Read-only. Lists every task ever archived to `.cookvideo/TASK_HISTORY.json` — appended to by
`reset` and `plan --replace` (see below) whenever a task leaves the active `TASK_STATE.json`
slot, so its final structured state (phase reached, risk level, approval status, result,
timestamps) survives being overwritten. Prints "No archived tasks yet" if the log is empty.

### `advance`

Records a single real-world lifecycle step, one hop at a time: `TESTING`→`REVIEW`,
`REVIEW`→`APPROVAL_REQUIRED`, `APPROVED`→`COMMITTING`, `COMMITTING`→`DEPLOYING`, or
`DEPLOYING`→`VERIFYING`. Refuses (non-zero exit) unless the task is already in the exact
phase that hop requires — no skipping ahead, and it never touches the phases `execute`
(`IMPLEMENTING`/`TESTING`), `approve` (`APPROVAL_REQUIRED`→`APPROVED`), or `complete`
(→`COMPLETED`) already own. An optional `--note <text>` is stored verbatim (trimmed) in
`TASK_STATE.json`'s `result` field — free-text and purely descriptive (e.g. a commit hash or
a deploy ID), never verified against git or any external system, exactly like `complete
--commit`'s existing `commitHash` option. **It never edits CookVideo, runs git commit/push,
or deploys anything** — it only records that a human says a step happened. `cookvideo-agent
complete` still works exactly as it always has as a single-call shortcut through every
remaining phase at once; `advance` is additive, for anyone who wants a per-step audit trail
instead. See "Task lifecycle and approval gates" below.

### `reset`

If there is a currently active task, archives its full state to
`.cookvideo/TASK_HISTORY.json` first (nothing is archived if there is no active task).
Overwrites `.cookvideo/TASK_STATE.json` with a fresh empty state (phase `PLANNED`, no task
ID), and rewrites `.cookvideo/ACTIVE_TASK.md` to match (its "no active task" form) — the two
are always driven by the same renderer, so they can't be left disagreeing with each other.
Never deletes source code, repository files, or any other `.cookvideo/` document.

### `plan`

Submits a planner's structured JSON task definition and records it as the new `PLANNED`
task. See "Planner → task creation interface" below for the full input contract and safety
model — in short: validates the submitted file against a strict schema (rejecting it with
every problem listed if it doesn't match, and never touching `TASK_STATE.json` on a
rejection), refuses to overwrite an existing active task unless `--replace` is passed, and
refuses `--replace` itself while that existing task is mid-flight
(`IMPLEMENTING`/`TESTING`/`REVIEW`/`APPROVAL_REQUIRED`/`APPROVED`/`COMMITTING`/`DEPLOYING`/`VERIFYING`).
A `--replace` archives the outgoing task to `.cookvideo/TASK_HISTORY.json` first (see
`history` above), the same as `reset` does. Never edits CookVideo, invokes Claude, runs
`git commit`/`git push`, or touches Supabase, Vercel, Mux, GitHub, or any production secret.

### `execute`

Prepares (and, only when explicitly allowed, runs) a Claude implementation attempt for the
current task. See "Claude execution adapter" below for the full architecture and safety
model — in short: **defaults to SAFE/DRY-RUN**, prints everything about the proposed
execution, and never invokes an external process unless both `--execute` is passed on the
command line *and* `COOKVIDEO_AGENT_EXECUTION_MODE=local` is set in the environment.

### `commit`

Requires the active task to be exactly `phase: APPROVED` and `approvalStatus: APPROVED`;
refuses otherwise. Prepares (and, only when explicitly allowed, runs) a real `git add`/`git
commit` against the CookVideo repository — never this repository, and never
CLI-selectable to another target. Defaults to **SAFE/DRY-RUN**: previews the exact
deterministic commit message (`CookVideoAgent: <taskId>` subject, the task's `objective` as
body — never a free-form override) and the files that would be staged, without touching the
repository. Real execution requires both `--execute` on the command line *and*
`COOKVIDEO_AGENT_GIT_WRITE_MODE=local` in the environment. Refuses (moving the task to
`FAILED`) on a detached HEAD, a change outside the task's `filesExpectedToChange` ("scope
mismatch"), or nothing to commit. On success, reads the new commit hash back from git itself
and persists `APPROVED → COMMITTING`. Never pushes. See "Git commit/push" below and
`.cookvideo/GIT_WRITE_POLICY.md`.

### `push`

Requires the active task to be exactly `phase: COMMITTING`; refuses otherwise. Prepares
(and, only when explicitly allowed, runs) a plain `git push` of the current branch against
the CookVideo repository. Defaults to **SAFE/DRY-RUN**; real execution requires the same
double gate as `commit` (`--execute` *and* `COOKVIDEO_AGENT_GIT_WRITE_MODE=local`). Refuses
if there's no upstream configured or nothing to push. A rejected/non-fast-forward push
surfaces git's own error verbatim and is never force-resolved, retried, or silently
swallowed. **Never chained from `commit`** — always its own separate, explicit action. A
successful push leaves the phase at `COMMITTING` (it is not a deploy); a failed push moves
the task to `FAILED`, preserving the already-recorded local commit hash. See "Git
commit/push" below and `.cookvideo/GIT_WRITE_POLICY.md`.

### `test`

Requires the active task to be exactly `phase: TESTING`; refuses otherwise. Prepares (and,
only when explicitly allowed, runs) a real `npm test` against the CookVideo repository —
never this repository, and never CLI-selectable to another target. The test command is read
from CookVideo's own `package.json` (`scripts.test`), never assumed. Defaults to
**SAFE/DRY-RUN**: previews the resolved test command without running it. Real execution
requires both `--execute` on the command line *and* `COOKVIDEO_AGENT_TEST_MODE=local` in the
environment. On a genuine pass (real exit code 0), persists `TESTING → REVIEW`. On any
failure (no resolvable `scripts.test`, a spawn error, or a real non-zero exit), moves the task
to `FAILED` — the same "any doubt → FAILED" handling as a failed `commit`/`push`. See "Real
CookVideo test suite execution" below and `.cookvideo/TEST_POLICY.md`.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src
npm test             # builds, then runs the integration + unit test suite
```

`npm test` includes an integration test against the real, configured CookVideo repository
(`src/__tests__/inspect.test.ts`, read-only) alongside unit tests for the task/approval
engine (`src/__tests__/taskState.test.ts`), the Claude adapter and execution engine
(`src/__tests__/claude.test.ts`, `src/__tests__/execution.test.ts`), the task input
contract and planning engine (`src/__tests__/taskInput.test.ts`), the `approve`/
`advance`/`complete`/`reset` commands (`src/__tests__/approve.test.ts`,
`src/__tests__/advance.test.ts`, `src/__tests__/complete.test.ts`,
`src/__tests__/reset.test.ts`), the task history archive
(`src/__tests__/taskHistory.test.ts`), the real git commit/push module
(`src/__tests__/gitWrite.test.ts`, which runs real `git` against throwaway temp
repositories, never the real CookVideo repository or this one), and the real CookVideo test
suite runner (`src/__tests__/testRun.test.ts`, which runs real `npm test` against throwaway
temp `npm` projects, never the real CookVideo repository or this one) — all of which use
temporary files and never touch the real `.cookvideo/TASK_STATE.json`. `npm run verify`
chains `typecheck` + `lint` + `test` in one command — see "Verification claims" in
`.cookvideo/ARCHITECTURE.md` for the rule around what a milestone may claim it covers.

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
| `GIT_WRITE_POLICY.md` | What `commit`/`push` may do in DRY-RUN vs. LOCAL mode |
| `TEST_POLICY.md` | What `test` may do in DRY-RUN vs. LOCAL mode |
| `TASK_STATE.json` | Machine-readable current task state — the source `task`/`approve`/`reset` operate on |
| `EXECUTION_LOG.json` | Append-only record of every `execute` attempt (dry-run or real), one entry per run |
| `TASK_HISTORY.json` | Append-only archive of every task that has left the active slot, via `reset` or `plan --replace` |
| `GIT_WRITE_LOG.json` | Append-only record of every `commit`/`push` attempt (dry-run or real), one entry per run |
| `TEST_LOG.json` | Append-only record of every `test` attempt (dry-run or real), one entry per run |

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

`approve` only flips `APPROVAL_REQUIRED` → `APPROVED`. It does not itself commit, push,
deploy, or perform the approved action — that separation is deliberate, establishing the
safety/approval model itself before this control plane was given the ability to perform any
consequential action. Real `git commit`/`git push` for an `APPROVED` task is now built
(Milestone 12) as two separate commands, `cookvideo-agent commit`/`cookvideo-agent push` —
see "Git commit/push" below. Wiring a task up to an actual production deployment remains
future work, not yet built.

`cookvideo-agent advance` (Milestone 10) lets a human record each remaining step
individually as it actually happens — `TESTING`→`REVIEW`→`APPROVAL_REQUIRED`, then, once
`approve`d, `APPROVED`→`COMMITTING`→`DEPLOYING`→`VERIFYING` — instead of only ever seeing one
bulk `cookvideo-agent complete` call assert the whole remaining walk occurred. This matters
most for `COMMITTING`/`DEPLOYING`, exactly the two phases the "REQUIRES USER APPROVAL" list
above is about: `advance` gives each of those its own dated `.cookvideo/BUILD_LOG.md` entry
(optionally carrying a `--note`, e.g. a commit hash), without granting this control plane any
new ability to actually perform them. `complete` is unchanged and still works as a one-call
shortcut for anyone who doesn't need the granular trail.

## Git commit/push

Milestone 12 adds the last mile between an `APPROVED` task and a real change landing in the
CookVideo repository: `src/lib/gitWrite.ts`, and the `cookvideo-agent commit`/`cookvideo-agent
push` commands built on it. This is the only module in this control plane that ever runs a
real `git add`/`git commit`/`git push`.

- **Two separate commands, never chained.** `commit` may create a real local commit; it never
  pushes. `push` may push an already-committed change; it is never invoked automatically by
  `commit`, and cannot invoke `commit`. There is no flag or environment variable that makes
  one perform the other's action.
- **Eligible target: CookVideo only, not CLI-selectable.** Unlike `execute --target`, neither
  command accepts a `--target` flag — both are hardcoded to the `CookVideo` execution target,
  so there is no input by which a real git write can ever be pointed at CookVideoAgent's own
  repository.
- **A second, separate double gate.** `COOKVIDEO_AGENT_GIT_WRITE_MODE` (`dry-run` or `local`;
  defaults to `dry-run` if unset or set to anything else, exactly like
  `COOKVIDEO_AGENT_EXECUTION_MODE`) plus the `--execute` CLI flag — both required, or the
  command stays dry-run. This is deliberately independent of `COOKVIDEO_AGENT_EXECUTION_MODE`:
  enabling real Claude execution and enabling real git writes are two separate decisions an
  operator must each make.
- **Phase-gated on top of the double gate.** `commit` additionally requires `phase: APPROVED`
  and `approvalStatus: APPROVED`. `push` additionally requires `phase: COMMITTING`.
- **Deterministic commit message, not overridable.** Subject `CookVideoAgent: <taskId>`, body
  the task's `objective` verbatim — no free-form message exists in this milestone.
- **Scope-checked before staging anything.** `commit` reads the real CookVideo `git status
  --porcelain` and refuses (staging nothing) if any changed path falls outside the task's
  `filesExpectedToChange`, or if nothing has changed — never `git add -A`/`.`.
- **Never force-resolves a push.** `push` reads git's own upstream-ahead count first, refuses
  cleanly if there's no upstream or nothing to push, and surfaces a rejected/non-fast-forward
  push's error verbatim rather than retrying or force-pushing.
- **A successful push does not advance the phase to `DEPLOYING`.** `DEPLOYING` means a real
  production deployment elsewhere in this project's vocabulary
  (`.cookvideo/APPROVAL_POLICY.md` lists "Git push" and "Production Vercel deployment"
  separately) — a git push alone must never be recorded as though it were one.
  `advance --to DEPLOYING` remains exactly as manual/descriptive as it always has been.
- **Every attempt is logged.** Dry-run or real, success or failure, each `commit`/`push`
  attempt is appended to `.cookvideo/GIT_WRITE_LOG.json`, mirroring
  `.cookvideo/EXECUTION_LOG.json`'s exact pattern.

See `.cookvideo/GIT_WRITE_POLICY.md` for the full policy text and
`.cookvideo/DECISIONS.md` for the design rationale, including the explicit choice that a
failed push (after a successful commit) still moves the task to `FAILED` rather than staying
at `COMMITTING` for a cheaper retry.

## Real CookVideo test suite execution

Milestone 13 closes a gap this document itself used to name as outstanding: nothing before
this milestone ever independently ran CookVideo's real test suite and checked a genuine
result — `src/lib/testRun.ts`, and the `cookvideo-agent test` command built on it.

- **Read from CookVideo, never guessed.** Before running anything, `test` reads CookVideo's
  own `package.json` and confirms a non-empty `scripts.test` entry exists
  (`resolveCookVideoTestCommand`) — it never assumes `npm test` will work, and refuses cleanly
  rather than spawning `npm test` and hoping npm's own "missing script" error is clear.
- **Eligible target: CookVideo only, not CLI-selectable.** Like `commit`/`push`, `test` is
  hardcoded to the `CookVideo` execution target — no `--target` flag, so there is no input by
  which a real test run can ever be pointed at CookVideoAgent's own repository.
- **A third, separate double gate.** `COOKVIDEO_AGENT_TEST_MODE` (`dry-run` or `local`;
  same fail-safe-to-dry-run parsing as `COOKVIDEO_AGENT_EXECUTION_MODE`/
  `COOKVIDEO_AGENT_GIT_WRITE_MODE`) plus the `--execute` CLI flag — both required, or the
  command stays dry-run. Deliberately independent of the other two: invoking Claude, writing
  git history, and running CookVideo's own tests are three separate decisions an operator must
  each make.
- **Phase-gated on top of the double gate.** `test` additionally requires `phase: TESTING`.
- **Genuine result, never self-reported.** The real process exit code is read straight from
  the spawned `npm test`. A genuine pass (`exitCode === 0`) moves `TESTING → REVIEW`. Any
  failure — no resolvable `scripts.test`, a spawn error, or a real non-zero exit — moves the
  task to `FAILED`, the same "any doubt → FAILED" handling Milestone 12 established for a
  failed `commit`/`push`, per explicit direction to keep that meaning consistent.
- **Bounded state, unbounded log.** `TASK_STATE.json`'s `result` field only ever holds a
  2000-character tail of a failing run's output; the full, untruncated stdout/stderr always
  survives in `.cookvideo/TEST_LOG.json`.
- **Every attempt is logged.** Dry-run or real, pass or fail, each `test` attempt is appended
  to `.cookvideo/TEST_LOG.json`, mirroring `.cookvideo/EXECUTION_LOG.json`/
  `.cookvideo/GIT_WRITE_LOG.json`'s exact pattern.

See `.cookvideo/TEST_POLICY.md` for the full policy text, `.cookvideo/MILESTONE_13_PROPOSAL.md`
for the design discussion and options considered before any code was written, and
`.cookvideo/DECISIONS.md` for the recorded decision.

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

## Planner → task creation interface

Milestone 4 adds the deterministic handoff boundary an external planner (ChatGPT) uses to
submit a structured engineering task to this control plane — `src/lib/taskInput.ts` (the
schema) and `src/lib/plan.ts` (the orchestration behind `cookvideo-agent plan`).

### The JSON task contract

A task input file must be a JSON object with:

| Field | Type | Notes |
|---|---|---|
| `taskId` | non-empty string | |
| `objective` | non-empty string | |
| `scope` | non-empty string | |
| `requestedChanges` | non-empty string[] | the planner's own description of the work |
| `filesExpectedToChange` | string[] | may be empty |
| `testsRequired` | string[] | may be empty |
| `riskLevel` | `"LOW" \| "MEDIUM" \| "HIGH"` | |
| `approvalRequirements` | string[] | what the planner anticipates this task will need approval for later; may be empty |

`validateTaskInput` collects *every* problem with a bad submission in one pass (not just
the first), so a rejected task input comes back with a complete error report. Nothing about
validation touches `TASK_STATE.json` — see `examples/implement-ui-copy.json` for a
harmless, fully worked example.

### What `plan` does

1. Reads and validates the JSON file. On any schema violation, refuses with every error
   listed and does not modify `TASK_STATE.json`.
2. If an active task already exists (`TASK_STATE.json` has a `taskId`), refuses unless
   `--replace` is passed — printing the existing task's ID and phase either way.
3. Even with `--replace`, refuses while that existing task is in a blocked, mid-flight phase
   (`IMPLEMENTING`, `TESTING`, `REVIEW`, `APPROVAL_REQUIRED`, `APPROVED`, `COMMITTING`,
   `DEPLOYING`, `VERIFYING`) — replacement is only allowed from `PLANNED` or a genuinely
   terminal phase (`COMPLETED`, `FAILED`, `BLOCKED`, `CANCELLED`).
4. Only once every check passes: writes `TASK_STATE.json` (phase `PLANNED`, approvalStatus
   `NOT_REQUIRED` — the approval workflow itself hasn't started yet; `approvalRequirements`
   is preserved as the planner's anticipated future need, not a live request),
   `ACTIVE_TASK.md` (the human-readable mirror), and a `BUILD_LOG.md` entry.

`plan` cannot edit CookVideo, invoke Claude, run `git commit`/`git push`, or touch Supabase,
Vercel, Mux, GitHub, or any production secret — by construction, since it only ever writes
to the three configured control-plane paths above.

### Execution remains separately approval-gated

Creating a `PLANNED` task via `plan` starts nothing. Advancing it through the lifecycle
(`IMPLEMENTING` → … → `COMPLETED`), actually invoking Claude (`cookvideo-agent execute
--execute` with `COOKVIDEO_AGENT_EXECUTION_MODE=local`), and actually committing/pushing
(gated behind `cookvideo-agent approve`, which still only flips state — it does not perform
the commit/push itself) are each their own, later, separately-gated steps. Planning and
execution are deliberately kept apart: a planner recording intent should never be
indistinguishable from an engineer acting on it.

## Current milestone

**Milestone 13 (this one):** real CookVideo test suite execution via `cookvideo-agent test`.
Previously, `TESTING → REVIEW` only ever happened via a human's free-text, unverified
`advance --to REVIEW`, or implicitly inside `execute --execute` based on Claude's own exit
code and whether expected files changed — nothing had ever independently run CookVideo's real
tests and checked a genuine result, exactly the gap this document's own "Tools" section used
to list as outstanding. Added `cookvideo-agent test [--execute]` (requires `phase: TESTING`;
reads CookVideo's real `package.json` for a `scripts.test` entry, never guessed; runs the real
`npm test`; on a genuine pass persists `TESTING → REVIEW`, or `→ FAILED` on any doubt —
no resolvable test command, a spawn error, or a real non-zero exit, matching Milestone 12's
`FAILED` handling for a failed push). Gated by its own double gate (`--execute` AND
`COOKVIDEO_AGENT_TEST_MODE=local`) and hardcoded to the `CookVideo` execution target only —
see "Real CookVideo test suite execution" above, `.cookvideo/TEST_POLICY.md`,
`.cookvideo/MILESTONE_13_PROPOSAL.md`, and `.cookvideo/DECISIONS.md` for the full design.

**Milestone 12:** real `git commit`/`git push` for `APPROVED` tasks, as two
separate commands. Previously, `.cookvideo/APPROVAL_POLICY.md` described commit/push as
requiring approval but stated that performing the approved action was "future work, not yet
built" — `approve`/`advance --to COMMITTING`/`complete --commit <hash>` only ever *recorded*
that a commit happened, via free-text a human supplied. Added `cookvideo-agent commit
[--execute]` (requires `phase: APPROVED` + `approvalStatus: APPROVED`; stages and commits with
a deterministic, non-overridable message, then persists `APPROVED → COMMITTING`, or `→
FAILED` on any doubt) and `cookvideo-agent push [--execute]` (requires `phase: COMMITTING`;
runs a plain `git push`, never chained from `commit`; a successful push stays at `COMMITTING`
since it is not a deploy, a failed push moves to `FAILED` while preserving the local commit
hash). Both are gated by their own double gate (`--execute` AND
`COOKVIDEO_AGENT_GIT_WRITE_MODE=local`) and hardcoded to the `CookVideo` execution target only
— see "Git commit/push" above, `.cookvideo/GIT_WRITE_POLICY.md`, and
`.cookvideo/DECISIONS.md` for the full design.

**Milestone 11:** preserves completed/abandoned task history. Previously, `reset`
unconditionally overwrote `.cookvideo/TASK_STATE.json` with an empty state, and `plan
--replace` overwrote it with the new task — both silently discarding the outgoing task's
full structured record forever, with nothing surviving except whatever `BUILD_LOG.md` prose
happened to be written along the way. Added `.cookvideo/TASK_HISTORY.json` (append-only,
mirroring `EXECUTION_LOG.json`'s existing pattern) and a new read-only `cookvideo-agent
history` command; `reset` and `plan --replace` now both archive the outgoing task there
before overwriting `TASK_STATE.json`. Purely additive: neither command's existing behavior
toward `TASK_STATE.json`/`ACTIVE_TASK.md` changed. See `.cookvideo/DECISIONS.md` and
`.cookvideo/BUILD_LOG.md` for the full rationale and for Milestones 5-9, which this section
of `README.md` had fallen behind on documenting individually.

**Milestone 10:** granular, single-hop lifecycle tracking via `cookvideo-agent
advance --to <phase> [--note <text>]` — records `TESTING`→`REVIEW`→`APPROVAL_REQUIRED` and,
once approved, `APPROVED`→`COMMITTING`→`DEPLOYING`→`VERIFYING` one real-world step at a time,
each with its own dated `BUILD_LOG.md` entry, instead of only ever seeing `complete` assert
the whole remaining walk in one call. Purely additive: `completeTask`'s existing single-call
behavior (Milestones 6-7) is unchanged, and `advance` never edits CookVideo or runs git
commit/push/deploy.

**Milestone 4:** the planner → task creation interface — `cookvideo-agent plan`.
A deterministic JSON handoff boundary (`src/lib/taskInput.ts`), existing-task and
replacement-safety protection, and a `PLANNED`-only task record. No write access to
CookVideo, no Claude invocation, no git commit/push, no production-system access — `plan`
cannot reach any of them by construction.

**Milestone 3:** the Claude execution adapter (`src/agents/claude.ts`) and the
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
