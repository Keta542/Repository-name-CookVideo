# CookVideo Agent — Architecture

This document describes the control plane itself (CookVideoAgent), not the CookVideo
application. See the CookVideo repository's own docs for the application's architecture.

## Roles

- **ChatGPT** — the planner. Decides what should happen next at a product and task level,
  and submits that decision to this control plane as a structured JSON task definition
  (`src/lib/taskInput.ts`) via `cookvideo-agent plan`. ChatGPT never talks to Claude, git,
  or CookVideo directly — the JSON task contract is the entire handoff boundary.
- **Claude (Claude Code)** — the implementation engineer. Reads a task's implementation
  brief (`src/agents/claude.ts`, Milestone 3) and, only when explicitly allowed to
  (`cookvideo-agent execute --execute` with `COOKVIDEO_AGENT_EXECUTION_MODE=local`), makes
  the actual code/infrastructure changes in the CookVideo repository, runs checks, and
  reports back.
- **CookVideo Agent** (this project) — the control plane. A local CLI that gives both of the
  above a shared, verifiable view of ground truth: what state the CookVideo repository is
  actually in, and what state the current task is in, right now — rather than what anyone
  remembers or assumes.
- **Git** — source of truth / transaction history for the CookVideo repository. Branch,
  commit, and working-tree-clean/dirty state are read directly from git, never inferred.
- **Tools** — what the control plane (and the agents it coordinates) can act through today:
  the filesystem and Git (read-only with respect to CookVideo), a local task/approval state
  machine, and a Claude execution adapter that defaults to dry-run-only. Later, deliberately
  and one at a time: authenticated integrations with Supabase, Vercel, Mux, and GitHub, each
  added only when a concrete task needs it — not speculatively.

## Two separate repositories

- `C:\Users\aesfm\CookVideo` — the CookVideo application. Owned by its own engineering
  process; this control plane only ever reads it.
- `C:\Users\aesfm\CookVideoAgent` — this project. Owned independently, with its own git
  history, dependencies, and lifecycle.

CookVideoAgent must never write into, commit to, or push the CookVideo repository. Every
command through Milestone 4 is read-only with respect to CookVideo.

Both repositories are registered, by name, as the only two entries in `EXECUTION_TARGETS`
(`src/config.ts`) — the closed list `cookvideo-agent execute --target <name>` selects a
Claude working directory from (see `.cookvideo/EXECUTION_POLICY.md`). CookVideoAgent remains
the default target, so existing invocations without `--target` are unaffected. Naming
CookVideo as a target only changes where Claude's working directory may point when a human
explicitly asks for it; it does not grant write access to `C:\Users\aesfm` generally, and it
does not change anything in `APPROVAL_POLICY.md` about commit, push, or production actions.

## The planner → task → execution pipeline

```
ChatGPT (planner)
   │  writes a JSON task definition matching src/lib/taskInput.ts
   ▼
cookvideo-agent plan --file <path> [--replace]
   │  validates the JSON, refuses on any schema violation or an unsafe
   │  existing-task replacement, and — only once every check passes —
   │  writes TASK_STATE.json + ACTIVE_TASK.md + a BUILD_LOG.md entry
   ▼
TASK_STATE.json  (phase: PLANNED, approvalStatus: NOT_REQUIRED)
   ▼
cookvideo-agent execute [--execute]
   │  prepares an implementation brief from the current TASK_STATE.json; only with the
   │  double gate (--execute AND EXECUTION_MODE=local) does it persist
   │  PLANNED/FAILED/BLOCKED → IMPLEMENTING and invoke Claude locally via
   │  src/agents/claude.ts, then persist the outcome as IMPLEMENTING → TESTING
   │  (verified success) or → FAILED (spawn error, non-zero exit, or no verified file
   │  change) — see src/lib/taskState.ts's beginImplementing/applyExecutionOutcome.
   │  Dry-run persists nothing.
   ▼
Claude (implementation engineer) — reads/edits CookVideo, runs tests, reports back
   ▼
TASK_STATE.json  (phase: TESTING or FAILED)
   │  a human (or a future milestone's own automation) advances a TESTING task through
   │  REVIEW → APPROVAL_REQUIRED → APPROVED (`cookvideo-agent advance` / `approve`)
   ▼
cookvideo-agent commit [--execute]
   │  requires phase APPROVED + approvalStatus APPROVED; only with its own double gate
   │  (--execute AND COOKVIDEO_AGENT_GIT_WRITE_MODE=local) does it run a real `git add`/
   │  `git commit` against the CookVideo repository, then persist APPROVED → COMMITTING
   │  (or → FAILED on any doubt). Dry-run persists nothing. See GIT_WRITE_POLICY.md.
   ▼
cookvideo-agent push [--execute]
   │  requires phase COMMITTING; its own separate double gate runs a real `git push`
   │  (never chained from `commit`). A successful push stays at COMMITTING (it is not a
   │  deploy); a failed push moves to FAILED, preserving the local commit hash.
   ▼
TASK_STATE.json  (phase: COMMITTING)
   │  DEPLOYING → VERIFYING → COMPLETED remain exactly as manual/descriptive as before —
   │  `cookvideo-agent advance`/`complete` — for whenever a real deploy happens outside
   │  this control plane.
```

`plan` only ever produces a `PLANNED` task. It never edits CookVideo, never invokes Claude,
never runs `git commit`/`git push`, and never touches Supabase, Vercel, Mux, GitHub, or any
production secret — by construction, since `src/lib/plan.ts` only writes to the three
configured control-plane paths (`TASK_STATE.json`, `ACTIVE_TASK.md`, `BUILD_LOG.md`).
Execution (invoking Claude for real) and real git commit/push (`cookvideo-agent commit`/
`cookvideo-agent push`, Milestone 12) each remain their own, separately gated steps, each
behind its own double gate plus the task's own approval status — planning a task creates
work; it never starts it, and approving it never performs anything by itself either.

## Control-plane state (`.cookvideo/`)

Living documents and machine-readable state, read and updated over time as the coordination
process actually runs:

- `PROJECT_STATE.md` — current known facts about the CookVideo project (dated, with unknowns
  marked explicitly rather than guessed)
- `ARCHITECTURE.md` — this file
- `DECISIONS.md` — decisions made about the control plane itself (not CookVideo's own
  decisions, which live in CookVideo's own `DECISIONS.md`)
- `ACTIVE_TASK.md` — the human-readable mirror of `TASK_STATE.json`, written by `plan` and
  restored to "no active task" by `reset` — the two are kept from disagreeing by
  construction, both driven off the same `formatActiveTaskMarkdown` renderer
- `BUILD_LOG.md` — chronological record of what was built/changed in CookVideoAgent itself
- `APPROVAL_POLICY.md` — what CookVideo Agent may do automatically vs. what requires human
  approval (commit, push, production Supabase/Vercel/Mux actions)
- `EXECUTION_POLICY.md` — the narrower DRY-RUN/LOCAL policy specifically for invoking Claude
  through `cookvideo-agent execute`
- `GIT_WRITE_POLICY.md` — the narrower DRY-RUN/LOCAL policy specifically for real git
  commit/push through `cookvideo-agent commit`/`cookvideo-agent push`
- `TASK_STATE.json` — machine-readable current task state, written only by `plan`, `approve`,
  `reset`, and (for its own bookkeeping) `execute`, `commit`, `push`
- `EXECUTION_LOG.json` — append-only record of every `execute` attempt (dry-run or real)
- `TASK_HISTORY.json` — append-only archive of every task that has left the active
  `TASK_STATE.json` slot, via `reset` or `plan --replace`
- `GIT_WRITE_LOG.json` — append-only record of every `commit`/`push` attempt (dry-run or real)

## Task input contract (`src/lib/taskInput.ts`)

The planner-facing schema `cookvideo-agent plan` validates every submission against:

| Field | Type | Notes |
|---|---|---|
| `taskId` | non-empty string | |
| `objective` | non-empty string | |
| `scope` | non-empty string | |
| `requestedChanges` | non-empty string[] | the planner's own description of the work |
| `filesExpectedToChange` | string[] | may be empty |
| `testsRequired` | string[] | may be empty |
| `riskLevel` | `"LOW" \| "MEDIUM" \| "HIGH"` | same enum `src/lib/taskState.ts` already defines |
| `approvalRequirements` | string[] | anticipated future approval needs; may be empty |

Every problem with a submission is collected and reported at once (not just the first),
and a submission that fails validation never touches `TASK_STATE.json` — see
`src/lib/plan.ts`'s `runPlan` for the exact ordering (validate → check existing task →
check replacement safety → write).

## Verification claims

A milestone's `.cookvideo/BUILD_LOG.md` entry may only report `npm run verify` (or the
equivalent `npm run typecheck` / `npm run lint` / `npm test` run separately) results against a
**clean `git status`** -- i.e. describing what is actually committed at `HEAD`, never a dirty
working tree that hasn't been committed and pushed yet. This exists because Milestones 6-8's
"Verified: npm run typecheck (clean)... npm test (all passing)" claims were true only of an
uncommitted local working tree: the pushed `master` HEAD they were recorded against did not
actually compile (see Milestone 9's `.cookvideo/DECISIONS.md` entry). When in doubt, verify
against an isolated `git worktree` checkout of the commit in question, not the working
directory the milestone was developed in.

As of Milestone 14, this is also checked automatically: `.github/workflows/verify.yml` runs
`npm ci && npm run verify` on every push to `master` and every pull request targeting it, on
GitHub's own infrastructure -- independent of whatever is or isn't configured on any
contributor's machine. This narrows the gap Milestone 9 left open ("enforced by discipline,
not tooling") but does not close it completely: the workflow reports pass/fail on GitHub, it
does not by itself block a push to `master` on failure -- that would additionally require
enabling branch protection on `master` as a required status check, which was deliberately not
turned on as part of Milestone 14 (see `.cookvideo/DECISIONS.md` for why).

## Current milestone

**Milestone 14 (this one):** CI enforcement of `npm run verify`. Previously,
Milestone 9's "Verification claims" rule above was, by its own admission, "enforced by
discipline, not tooling" -- nothing blocked a commit or push if `git status` was dirty or
`verify` was never actually run. Added `.github/workflows/verify.yml`: a single job
(`actions/checkout` -> `actions/setup-node` pinned to Node 20.x -> `npm ci` -> `npm run
verify`) that runs on every push to `master` and every pull request targeting it, using this
repository's existing `origin` GitHub remote. No new npm script -- it runs the exact same
`npm run verify` a human already runs locally, against CookVideoAgent's own source only.
Requires no secrets or credentials: `verify` never touches CookVideo, git write operations,
or any production system. Branch protection making this a *required* (blocking) check was
considered and deliberately deferred -- the workflow is report-only for now. See
`.cookvideo/DECISIONS.md` and `.cookvideo/MILESTONE_14_PROPOSAL.md` for the full design and
the options considered.

**Milestone 13:** real CookVideo test suite execution via `cookvideo-agent test`. See
`.cookvideo/DECISIONS.md` for the full rationale.

**Milestone 12:** real git commit/push for `APPROVED` tasks. Previously,
`APPROVAL_POLICY.md` described commit and push as requiring approval but stated that
performing the approved action was "future work, not yet built" — `approve`/`advance --to
COMMITTING`/`complete --commit <hash>` only ever *recorded* that a commit happened, via
free-text a human supplied; nothing in this control plane had ever run `git add`/`git commit`/
`git push` for real. Added two new, deliberately separate commands: `cookvideo-agent commit
[--execute]` (requires phase `APPROVED` + approvalStatus `APPROVED`; stages and commits with a
deterministic, non-overridable message -- `CookVideoAgent: <taskId>` / the task's objective as
body -- then persists `APPROVED → COMMITTING`, or `→ FAILED` on any doubt) and `cookvideo-agent
push [--execute]` (requires phase `COMMITTING`; runs a plain `git push`, never chained from
`commit`; a successful push stays at `COMMITTING` since it is not a deploy, a failed push moves
to `FAILED` while preserving the already-recorded local commit hash). Both are gated by their
own double gate (`--execute` AND a new `COOKVIDEO_AGENT_GIT_WRITE_MODE=local`, mirroring
`COOKVIDEO_AGENT_EXECUTION_MODE`'s exact fail-safe-to-dry-run parsing) and are hardcoded to the
`CookVideo` execution target only -- neither command accepts a `--target` flag, so
CookVideoAgent's own repository can never become a real git-write target through this feature.
A real commit refuses (staging nothing) unless the CookVideo working tree's changes are
entirely within the task's `filesExpectedToChange` (`validateGitWriteScope`, reusing
`execute`'s existing "verify against ground truth" philosophy), and a real push refuses if
there's no upstream configured or nothing to push, and is never force-resolved on a rejected/
diverged push. Added `src/lib/gitWrite.ts`, `src/commands/commit.ts`, `src/commands/push.ts`,
`applyCommitOutcome`/`applyPushOutcome` in `src/lib/taskState.ts` (reusing the existing
`TRANSITIONS` table -- no new lifecycle phase or transition), `.cookvideo/GIT_WRITE_POLICY.md`,
and `.cookvideo/GIT_WRITE_LOG.json` (append-only, mirroring `EXECUTION_LOG.json`'s exact
pattern). Deployment (Vercel/Supabase/Mux) remains completely out of scope -- neither command
can move a task to `DEPLOYING` or beyond. See `.cookvideo/DECISIONS.md` for the full rationale
and the judgment calls it records.

**Milestone 11:** preserve completed/abandoned task history. Previously, `reset`
(`src/commands/reset.ts`) unconditionally overwrote `TASK_STATE.json` with an empty state,
and `plan --replace` (`src/lib/plan.ts`) overwrote it with the new task -- both silently
discarding the outgoing task's full structured record forever, with nothing surviving except
whatever `BUILD_LOG.md` prose happened to be written along the way. Added
`.cookvideo/TASK_HISTORY.json`, append-only, mirroring `EXECUTION_LOG.json`'s exact existing
read/append pattern (`src/lib/taskHistory.ts`: `TaskHistoryEntry { archivedAt, archivedVia:
"reset" | "plan --replace", task: TaskState }`). `runReset` now archives the current task (if
any -- nothing to archive from an already-empty state) before clearing it; `runPlan`'s
`--replace` path archives the outgoing task the same way before overwriting it (always
`PLANNED` or genuinely terminal at that point, since `isSafeToReplace` already refused
mid-flight phases earlier in the same call). Added a new read-only `cookvideo-agent history`
command. `TASK_HISTORY.json` was added to `STATE_FILES` so `inspect`/`status` report on it
like every other state file. Neither `reset` nor `plan --replace`'s existing behavior toward
`TASK_STATE.json`/`ACTIVE_TASK.md`/`BUILD_LOG.md` changed -- this milestone only adds a
preservation step before each command's existing overwrite. See `.cookvideo/DECISIONS.md` for
the full rationale.

**Milestone 10:** granular, single-hop lifecycle tracking. Previously,
`completeTask` was the only way past `TESTING` -- it validates and applies the *entire*
remaining walk to `COMPLETED` in one call, including `COMMITTING` and `DEPLOYING`, exactly
the two phases `.cookvideo/APPROVAL_POLICY.md`'s "REQUIRES USER APPROVAL" list is about (git
commit, git push, production deploys) -- with no individual, timestamped record of when each
of those real-world actions actually happened. Added `advanceTaskPhase`
(`src/lib/taskState.ts`) and `cookvideo-agent advance --to <phase> [--note <text>]`
(`src/commands/advance.ts`), restricted to exactly five single hops --
`TESTING`→`REVIEW`→`APPROVAL_REQUIRED` and `APPROVED`→`COMMITTING`→`DEPLOYING`→`VERIFYING` --
reusing the same `TRANSITIONS` table every other lifecycle check already reads (no new phase
or transition). `IMPLEMENTING`/`TESTING` remain exclusively `execute`'s territory,
`APPROVAL_REQUIRED`→`APPROVED` remains exclusively `approve`'s, and →`COMPLETED` remains
exclusively `complete`'s -- `advance` refuses all three even though `TRANSITIONS` itself would
technically permit them. `--note` is optional, free-text, and purely descriptive (stored
verbatim, trimmed, in `result`), exactly like `completeTask`'s existing `commitHash` option --
never verified against git or any external system. `advance` deliberately never touches
`approvalStatus`, even when landing on `APPROVAL_REQUIRED` for a task that doesn't actually
require approval (`requiresApprovalGate` false) -- that stays exclusively `completeTask`'s
call (Milestone 7). Each hop writes `TASK_STATE.json`, `ACTIVE_TASK.md`, and its own
`BUILD_LOG.md` entry together, via the same `formatActiveTaskMarkdown`/`prependBuildLogEntry`
helpers every other mutating command already uses. `completeTask` itself is completely
unchanged -- it remains a valid single-call path for the common LOW-risk case and for any
task whose granular history nobody needs recorded. See `.cookvideo/DECISIONS.md` for the full
rationale and the two judgment calls it records.

**Milestone 9:** restore build integrity and add the verification-claims rule above.
Committed a Claude CLI invocation fix (`src/agents/claude.ts`) that had been fully written,
tested, and live-verified against the real CookVideo repository but never actually committed
-- `src/lib/execution.ts`/`src/commands/execute.ts` had already been committed against its
new stdin-based interface, leaving the pushed `master` HEAD in a non-compiling state. Added
`npm run verify` (`package.json`) and the rule above so a milestone's recorded verification
claims can't silently diverge from what's actually pushed again. See `.cookvideo/DECISIONS.md`
for the full account.

**Milestone 8:** persistent execute lifecycle transitions. Previously, `execute`
only *validated* that a move into `IMPLEMENTING` would be legal
(`validateExecutionTransition`, `src/lib/execution.ts`) but never persisted it —
`TASK_STATE.json` stayed frozen at whatever phase a task was already in no matter what
execution actually did, which was the direct cause of the `ACTIVE_TASK.md`/`TASK_STATE.json`
drift observed on the real `MILESTONE-6-SEARCH-EMPTY-STATE-001` task (fixed as part of this
milestone). `runExecution` now persists two real transitions during a genuine (non-dry-run)
attempt, via two new `src/lib/taskState.ts` functions built on the same `TRANSITIONS` table
every other lifecycle check already reads: `beginImplementing` moves
`PLANNED`/`FAILED`/`BLOCKED` → `IMPLEMENTING` immediately *before* Claude is invoked (so a
crash mid-invocation still leaves `TASK_STATE.json` showing the true in-flight phase, not a
stale `PLANNED`), and `applyExecutionOutcome` moves `IMPLEMENTING` → `TESTING` on a verified
success or → `FAILED` on a spawn error, non-zero exit, or exit 0 with none of the expected
files actually changed (`FAILED` remains recoverable back to `PLANNED`/`IMPLEMENTING`). Each
hop that actually changes the phase writes `TASK_STATE.json`, `ACTIVE_TASK.md`, and a
`BUILD_LOG.md` entry together (via the same `formatActiveTaskMarkdown`/
`prependBuildLogEntry` helpers `plan`/`approve`/`complete` already use), so the three
documents can never be left disagreeing; dry-run remains fully read-only, unchanged from
`.cookvideo/EXECUTION_POLICY.md`. Every existing refusal path (no task, invalid transition,
`REJECTED` approval, target mismatch) still short-circuits before any write. See
`.cookvideo/BUILD_LOG.md` for the full change list and live-verification notes.

**Milestone 7:** risk-based approval gate enforcement. Previously, nothing ever
forced a task into `APPROVAL_REQUIRED`/`PENDING`, so `completeTask` (`src/lib/taskState.ts`)
could move any task straight to `COMPLETED` regardless of its declared `riskLevel` or
`approvalRequirements` — the approval gate existed in the data model but was never actually
enforced. `completeTask` is now risk/approval aware: a `MEDIUM`/`HIGH`-risk task, or one with
any non-empty `approvalRequirements`, is refused unless `approvalStatus` is `APPROVED`; if it
isn't, `complete` itself drives the task as far as `APPROVAL_REQUIRED`/`PENDING` (reusing the
existing `isValidTransition`/`FORWARD_PATH_TO_COMPLETION` machinery, not a new state machine)
and stops there, requiring `cookvideo-agent approve` before a subsequent `complete` can reach
`COMPLETED`. A plain `LOW`/`NOT_REQUIRED` task (the Milestone 6 shape) is unaffected and still
completes in one step. `cookvideo-agent approve` and `cookvideo-agent complete` now both write
`TASK_STATE.json`, `ACTIVE_TASK.md`, and a `BUILD_LOG.md` entry via the same helpers `plan`/
`reset` already use (`formatActiveTaskMarkdown`/`prependBuildLogEntry` in `src/lib/plan.ts`),
closing a gap where those two commands previously only updated `TASK_STATE.json`. See
`.cookvideo/APPROVAL_POLICY.md` for the enforced rule and `.cookvideo/DECISIONS.md` for why
`completeTask` (rather than `execute`) was chosen as the enforcement point.

**Milestone 4:** the planner → task creation interface. A deterministic JSON
handoff boundary (`src/lib/taskInput.ts`) an external planner (ChatGPT) submits through
`cookvideo-agent plan`, which validates it, protects any existing active task (refusing
replacement without `--replace`, and refusing `--replace` itself while that task is
mid-flight), and — only once every check passes — records a new `PLANNED` task. No write
access to CookVideo, no Claude invocation, no git commit/push, no production-system access —
`plan` cannot reach any of them by construction.

**Milestone 3:** the Claude execution adapter (`src/agents/claude.ts`, `src/lib/execution.ts`,
`cookvideo-agent execute`). Defaults to SAFE/DRY-RUN; real execution requires an explicit
`--execute` flag *and* `COOKVIDEO_AGENT_EXECUTION_MODE=local`, both together.

**Milestone 2:** the task and approval engine — structured task state, the lifecycle
(`PLANNED` → … → `COMPLETED`, with `FAILED`/`BLOCKED`/`CANCELLED` escape hatches), the
three-category approval policy, and the `task`/`approve`/`reset` commands. `approve` only
changes state; it does not commit, push, or deploy.

**Milestone 1:** a read-only scaffold — `inspect` and `status` only.

Do not expand scope beyond what a given milestone explicitly approves without a deliberate
decision recorded in `.cookvideo/DECISIONS.md`.
