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
- Claude may read/edit only the approved working directory (the directory this control
  plane is configured to run in — never a path outside it, and never the CookVideo
  repository unless a future, separately-approved milestone explicitly extends scope
  there).
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
