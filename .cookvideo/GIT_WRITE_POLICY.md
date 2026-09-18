# CookVideo Agent — Git Write Policy

This document governs `cookvideo-agent commit` and `cookvideo-agent push` (Milestone 12) --
the only two places in this control plane that ever run a real `git add`/`git commit`/
`git push`. It is a companion to `APPROVAL_POLICY.md` (which still governs *whether* a
commit/push may happen at all -- both remain in the "REQUIRES USER APPROVAL" list) and to
`EXECUTION_POLICY.md` (which governs invoking Claude, a separate action). Nothing in this
document loosens either of those.

## Two separate, explicit commands -- never chained

`commit` and `push` are deliberately distinct commands with their own `--execute` flags.
`cookvideo-agent commit --execute` may create a real local commit; it never pushes.
`cookvideo-agent push --execute` may push an already-committed change; it is never invoked
automatically by `commit`. There is no flag or environment variable that makes one command
perform the other's action.

## Eligible target: CookVideo only

Real git writes are permitted only against the `CookVideo` execution target
(`GIT_WRITE_TARGET_NAME` in `src/config.ts`), resolved through the same `EXECUTION_TARGETS`
registry `execute --target` uses. Unlike `execute`, this target is **not** operator-selectable
-- `commit`/`push` hardcode `GIT_WRITE_TARGET_NAME` internally, so there is no flag or input
that can point a real git write at CookVideoAgent's own repository.

## Double gate

Git write mode is controlled by the `COOKVIDEO_AGENT_GIT_WRITE_MODE` environment variable
(`dry-run` or `local`; defaults to `dry-run` if unset or set to anything else, exactly like
`COOKVIDEO_AGENT_EXECUTION_MODE`) and, per invocation, the `--execute` CLI flag. **Both** must
be present for a real git command to run -- either one missing means dry-run, no exceptions.

`commit` additionally requires the active task's `phase` to be exactly `APPROVED` and
`approvalStatus` to be exactly `APPROVED` -- this is on top of the double gate, not instead of
it. `push` requires `phase` to be exactly `COMMITTING`.

## Commit message: deterministic, not overridable

`commit` never accepts a free-form message. The subject and body are always derived from the
task itself:

- Subject: `CookVideoAgent: <taskId>`
- Body: the task's `objective`, verbatim

Dry-run always shows the exact message real execution would use.

## What `commit --execute` does

1. Refuses immediately (no repository access) unless `phase=APPROVED` and
   `approvalStatus=APPROVED`.
2. Refuses if CookVideo is in a detached HEAD state (nothing to attach the commit to).
3. Reads the real `git status --porcelain` of the CookVideo repository and refuses -- staging
   nothing -- if any changed path falls outside the task's `filesExpectedToChange` (a "scope
   mismatch"), or if nothing has changed at all ("nothing to commit").
4. Stages exactly the changed paths that passed the scope check (`git add --  <paths>` --
   never `git add -A`/`.`).
5. Commits with the deterministic message above.
6. Reads the resulting commit hash back from git itself (`git rev-parse HEAD`) -- never trusts
   a self-reported value.
7. On success, moves the task `APPROVED -> COMMITTING`. On any failure above, moves the task to
   `FAILED` (recoverable back to `PLANNED`/`IMPLEMENTING`, same as a failed `execute` attempt).

## What `push --execute` does

1. Refuses immediately unless `phase=COMMITTING`.
2. Reads git's own record of how many local commits on the current branch are ahead of its
   upstream. Refuses if there is no upstream configured, if that can't be determined, or if
   there is nothing to push.
3. Runs a plain `git push` -- current branch only, no explicit refspec, no `-u`, no `--force`,
   no branch creation/checkout/deletion/rebase/PR of any kind.
4. A rejected or non-fast-forward push fails visibly, with git's own error surfaced verbatim.
   It is **never** force-resolved, retried automatically, or silently swallowed.
5. **A successful push does not advance the task's phase.** `COMMITTING` already accurately
   means "committed locally"; `DEPLOYING` means a real production deployment elsewhere in this
   project's vocabulary (`APPROVAL_POLICY.md` lists "Git push" and "Production Vercel
   deployment" as separate items) -- advancing to `DEPLOYING` on a mere `git push` would
   falsely claim a production deploy happened. Only `result`/`updatedAt` record the confirmed
   push; the phase stays `COMMITTING`.
6. A failed push moves the task to `FAILED` -- the already-recorded local commit hash from the
   prior `commit` is preserved in `result`, so the task is never falsely treated as pushed and
   remains recoverable.

## Deployment stays out of scope

Neither `commit` nor `push` can move a task to `DEPLOYING` or beyond. `advance --to DEPLOYING`
remains exactly as manual/descriptive as it always has been, for whenever a real deployment
happens outside this control plane.

## Audit trail

Every `commit`/`push` attempt -- dry-run or real, success or failure -- is appended to
`.cookvideo/GIT_WRITE_LOG.json` (mirroring `EXECUTION_LOG.json`'s exact pattern), recording the
literal git argv considered or run, the outcome, and (for a real commit or push) the verified
commit hash.

## What this milestone does *not* do

`COOKVIDEO_AGENT_GIT_WRITE_MODE` defaults to `dry-run` everywhere this project is actually
configured, and no milestone has yet set it to `local` in any real environment. `local` mode
exists as a documented, tested code path -- not as something currently enabled. Enabling it for
real is a deliberate future decision, to be recorded in `.cookvideo/DECISIONS.md` when it
happens, exactly like `EXECUTION_POLICY.md`'s own equivalent statement for Claude execution.
