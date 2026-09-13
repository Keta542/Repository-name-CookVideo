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
   │  a human (or a future milestone's own automation) advances the task
   │  through IMPLEMENTING → TESTING → REVIEW → APPROVAL_REQUIRED → APPROVED
   │  → COMMITTING → DEPLOYING → VERIFYING → COMPLETED (src/lib/taskState.ts)
   ▼
cookvideo-agent execute [--execute]
   │  prepares an implementation brief from the current TASK_STATE.json and,
   │  only with the double gate (--execute AND EXECUTION_MODE=local), invokes
   │  Claude locally via src/agents/claude.ts
   ▼
Claude (implementation engineer) — reads/edits CookVideo, runs tests, reports back
```

`plan` only ever produces a `PLANNED` task. It never edits CookVideo, never invokes Claude,
never runs `git commit`/`git push`, and never touches Supabase, Vercel, Mux, GitHub, or any
production secret — by construction, since `src/lib/plan.ts` only writes to the three
configured control-plane paths (`TASK_STATE.json`, `ACTIVE_TASK.md`, `BUILD_LOG.md`).
Execution (invoking Claude for real) and commit/push (via `approve`, still not itself wired
to perform the action) each remain their own, separately approval-gated steps — planning a
task creates work; it never starts it.

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
- `TASK_STATE.json` — machine-readable current task state, written only by `plan`, `approve`,
  `reset`, and (for its own bookkeeping) `execute`
- `EXECUTION_LOG.json` — append-only record of every `execute` attempt (dry-run or real)

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

## Current milestone

**Milestone 7 (this one):** risk-based approval gate enforcement. Previously, nothing ever
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
