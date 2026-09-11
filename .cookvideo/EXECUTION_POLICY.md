# CookVideo Agent — Execution Policy

This document governs `cookvideo-agent execute` (the Claude execution adapter, Milestone 3)
— specifically, what is and isn't allowed to happen when this control plane prepares or runs
an implementation attempt through Claude. It is a companion to `APPROVAL_POLICY.md`, which
still governs everything about commit, push, deploy, and production systems: nothing in this
document changes or loosens that policy.

Execution mode is controlled by the `COOKVIDEO_AGENT_EXECUTION_MODE` environment variable
(`dry-run` or `local`; defaults to `dry-run` if unset or set to anything else) and, per
invocation, the `--execute` CLI flag. **Both** the environment variable set to `local` and
the `--execute` flag must be present for a real process to run — either one missing means
dry-run behavior, no exceptions.

## Approved execution targets

Claude's working directory for an execution attempt is never an arbitrary or guessed path —
it is always one of a fixed, explicitly configured list of repositories (`EXECUTION_TARGETS`
in `src/config.ts`), selected by name via `resolveExecutionTarget`:

| Target name | Path | Purpose |
|---|---|---|
| `CookVideoAgent` (default) | `C:\Users\aesfm\CookVideoAgent` | This control plane's own repository. |
| `CookVideo` | `C:\Users\aesfm\CookVideo` | The actual CookVideo application repository. |

`cookvideo-agent execute` accepts an optional `--target <name>` flag naming one of the
targets above; omitting it preserves the pre-Milestone-4 behavior of running against
CookVideoAgent itself. A name that isn't in this list is refused before anything is prepared
or invoked — this control plane never falls back to `process.cwd()`, an environment-supplied
path, or any other guess. Adding a new target is a deliberate config change, recorded in
`.cookvideo/DECISIONS.md`, never something a CLI invocation can conjure on its own — so
execution can never be pointed at `C:\Users\aesfm` generally or at any other repository on
this machine.

Registering `CookVideo` as an approved target changes only *where* Claude's working directory
may point when explicitly asked for via `--target CookVideo`. It does not loosen anything
below: commit, push, production Supabase/Vercel/Mux actions, and destructive operations
remain governed exactly as `APPROVAL_POLICY.md` describes, regardless of which target is
active.

## Target verification (stale/mismatched task targets)

Before any implementation brief is written or Claude is invoked -- in DRY-RUN or LOCAL mode,
regardless of the double gate above -- `runExecution` (`src/lib/execution.ts`) checks that
every path in the task's `filesExpectedToChange` actually exists in the selected execution
target's repository (resolved against `target.path`, i.e. `cwd`).

This exists because a task can go stale or be pointed at the wrong target: `filesExpectedToChange`
was recorded by the planner against one assumption about where the work would happen, and by
the time `execute` runs, that path may no longer exist there (a rename, a task meant for the
other repository, a typo in the planner's JSON). Nothing in this control plane may guess a
substitute file and proceed -- that would mean Claude editing something the task never actually
named.

If one or more expected paths are missing:

- Execution stops immediately -- no implementation brief is written, no Claude command is
  built, and Claude is never invoked, even if `--execute` and `COOKVIDEO_AGENT_EXECUTION_MODE=local`
  are both set.
- `cookvideo-agent execute` reports a structured target-mismatch result instead of the normal
  dry-run/local report: the missing path(s), the selected target repository, and an explicit
  statement that human approval is required before changing the execution target or the
  task's expected files.
- Nothing is recorded to `EXECUTION_LOG.json` for a target-mismatch attempt, matching the
  existing behavior for the other pre-brief refusals (no active task, invalid lifecycle
  transition, REJECTED approval status).

A task with an empty `filesExpectedToChange` has nothing to verify and is unaffected. A task
whose expected files all exist in the selected target proceeds exactly as before this check
was added.

## DRY-RUN (default)

- Prepare and display the proposed execution: the task objective, allowed scope, expected
  files, required tests, approval requirements, the implementation brief, and the exact
  Claude execution command that would be invoked.
- No external process execution. Nothing is spawned, nothing on disk outside
  `.cookvideo/` is touched, and CookVideo is never modified.
- The implementation brief is still written to `.cookvideo/briefs/` (a working artifact,
  not a real change to CookVideo) so the exact proposed input to Claude can be inspected.
- An execution attempt (dry-run or not) is always recorded to `.cookvideo/EXECUTION_LOG.json`
  for traceability.

## LOCAL

Only reachable when `COOKVIDEO_AGENT_EXECUTION_MODE=local` **and** `--execute` is passed.

- Claude may be invoked locally, via the command configured in
  `COOKVIDEO_AGENT_CLAUDE_COMMAND` (defaults to `claude`; never hardcoded to a specific
  executable path).
- Claude may read/edit only the approved working directory named by the active execution
  target (see "Approved execution targets" above) — never a path outside the fixed
  `EXECUTION_TARGETS` list.
- Tests may run.
- `git diff`/`git status` may be inspected.
- **Commit and push remain approval-gated** — exactly as in `APPROVAL_POLICY.md`. Local
  execution mode does not commit or push anything by itself.
- **Production systems remain approval-gated** — Supabase, Vercel, Mux, GitHub, and any
  other production credential or deployment action stay off-limits regardless of execution
  mode, per `APPROVAL_POLICY.md`.

## What this milestone does *not* do

As of Milestone 3, `COOKVIDEO_AGENT_EXECUTION_MODE` defaults to `dry-run` everywhere this
project is actually configured, and no milestone has yet set it to `local` in any real
environment. `local` mode exists as a documented, tested code path — not as something
currently enabled. Enabling it for real is a deliberate future decision, to be recorded in
`.cookvideo/DECISIONS.md` when it happens, not something this document authorizes on its
own.
