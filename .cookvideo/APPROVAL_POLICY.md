# Approval Policy

This file defines what CookVideo Agent may do on its own, and what it must
stop and ask a human for. It is the reference the task/approval engine
(`src/lib/taskState.ts`) is built around, and the source of truth if the
code and this document ever disagree — the code should be fixed to match
this file, not the other way around.

## AUTOMATIC (no approval needed)

These actions may happen without asking:

- Read files
- Inspect repository
- Edit source files
- Create files
- Run local tests
- Run lint/typecheck
- Inspect git diff/status

## REQUIRES USER APPROVAL

These actions require an explicit human approval before they happen:

- Git commit
- Git push
- Production Supabase migration
- Production Vercel deployment
- Production Mux configuration changes

## ALWAYS REQUIRES USER APPROVAL

These actions require explicit human approval every time, with no
exceptions and no way to pre-authorize them in bulk:

- Deleting production data
- Destructive database operations
- Deleting large groups of project files
- Changing production secrets

## How this maps to the task lifecycle

A task's `phase` field (see `TASK_STATE.json` and `ACTIVE_TASK.md`) tracks
where a unit of work is in its lifecycle. A task only reaches
`APPROVAL_REQUIRED` when it needs to perform an action from the "REQUIRES
USER APPROVAL" or "ALWAYS REQUIRES USER APPROVAL" lists above. The
`cookvideo-agent approve` command is the only way to move a task from
`APPROVAL_REQUIRED` to `APPROVED` — and that is *all* it does. Approving a
task does not commit, push, deploy, or perform the approved action; it only
records that a human said yes.

Performing the approved git commit/push is now built (Milestone 12):
`cookvideo-agent commit`/`cookvideo-agent push`, gated by their own double
gate (an explicit `--execute` flag and `COOKVIDEO_AGENT_GIT_WRITE_MODE=local`)
**on top of** requiring the task to already be `APPROVED` here. See
`.cookvideo/GIT_WRITE_POLICY.md` for the full detail. Production deployment
(Vercel/Supabase/Mux) is still future work, not yet built — nothing added in
Milestone 12 can move a task to `DEPLOYING` or beyond.

## Enforcement: which tasks the gate actually applies to (Milestone 7)

A task's declared `riskLevel` and `approvalRequirements` (set once, by the
planner, via `cookvideo-agent plan` — see `.cookvideo/ARCHITECTURE.md`) are
what decide whether it needs a human's sign-off before it can be considered
done:

- **`riskLevel: LOW`, empty `approvalRequirements`** — no gate. A task like
  this can move all the way through the lifecycle to `COMPLETED` (via
  `cookvideo-agent complete`) without ever passing through
  `APPROVAL_REQUIRED`, exactly as it always has.
- **`riskLevel: MEDIUM` or `HIGH`, or any non-empty `approvalRequirements`**
  — the gate is real, not just descriptive. `cookvideo-agent complete`
  (`completeTask` in `src/lib/taskState.ts`) refuses to move such a task to
  `COMPLETED` unless `approvalStatus` is `APPROVED`. If it isn't, `complete`
  itself moves the task as far as `APPROVAL_REQUIRED` (`approvalStatus:
  PENDING`) and stops — recording, in `TASK_STATE.json`, `ACTIVE_TASK.md`,
  and `BUILD_LOG.md`, that the task is now waiting on a human. A human must
  then run `cookvideo-agent approve` before re-running `cookvideo-agent
  complete` to actually reach `COMPLETED`.

This closes a gap that existed through Milestone 6: nothing previously
*required* a risk-bearing task to ever pass through `APPROVAL_REQUIRED` at
all, so a `HIGH`-risk task could in principle reach `COMPLETED` with no human
approval ever recorded. `riskLevel`/`approvalRequirements` are the only
signals this enforcement looks at — see `src/lib/taskState.ts`'s
`requiresApprovalGate` for the exact rule.
