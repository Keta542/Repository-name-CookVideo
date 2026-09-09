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
`APPROVAL_REQUIRED` to `APPROVED` — and, as of this milestone, that is *all*
it does. Approving a task does not commit, push, deploy, or perform the
approved action; it only records that a human said yes. Performing the
approved action itself is future work, out of scope for this milestone.
