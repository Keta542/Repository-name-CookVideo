# CookVideo Agent — Test Policy

This document governs `cookvideo-agent test` (Milestone 13) — the only command in this
control plane that ever independently runs CookVideo's real test suite. It is a companion to
`EXECUTION_POLICY.md` (which governs invoking Claude — `EXECUTION_POLICY.md`'s "Tests may
run" only means Claude *may choose to* run tests as part of its own LOCAL-mode work; this
control plane never trusted that self-report before this milestone) and to
`GIT_WRITE_POLICY.md` (which governs the separate commit/push actions). Nothing in this
document loosens any of those, and running local tests is already listed as `AUTOMATIC` in
`APPROVAL_POLICY.md` — this milestone makes that already-automatic action real and
evidence-based instead of assumed or self-reported; it does not add a new approval category.

## Eligible target: CookVideo only

Real test runs are permitted only against the `CookVideo` execution target
(`TEST_TARGET_NAME` in `src/config.ts`), resolved through the same `EXECUTION_TARGETS`
registry `execute --target`/`commit`/`push` use. Like `commit`/`push`, this target is **not**
operator-selectable — `test` hardcodes `TEST_TARGET_NAME` internally, so there is no flag or
input that can point a real test run at CookVideoAgent's own repository.

## Double gate

Test mode is controlled by the `COOKVIDEO_AGENT_TEST_MODE` environment variable (`dry-run` or
`local`; defaults to `dry-run` if unset or set to anything else, exactly like
`COOKVIDEO_AGENT_EXECUTION_MODE`/`COOKVIDEO_AGENT_GIT_WRITE_MODE`) and, per invocation, the
`--execute` CLI flag. **Both** must be present for a real test command to run — either one
missing means dry-run, no exceptions. This is deliberately a third, independent variable, not
a reuse of either existing one: invoking Claude, writing to CookVideo's git history, and
running CookVideo's own test suite are three different categories of real-world action, and
enabling one was never meant to silently enable another.

`test` additionally requires the active task's `phase` to be exactly `TESTING` — on top of
the double gate, not instead of it.

## Test command: read from CookVideo, never guessed

`test` never assumes `npm test` will work. Before running anything, it reads CookVideo's own
`package.json` and confirms it declares a non-empty `scripts.test` entry
(`resolveCookVideoTestCommand` in `src/lib/testRun.ts`). If that entry is missing — no
`package.json`, invalid JSON, or no `scripts.test` — real execution refuses cleanly rather
than spawning `npm test` and hoping npm's own "missing script" error is clear enough. Dry-run
always previews this same check.

## What `test --execute` does

1. Refuses immediately (no repository access) unless `phase=TESTING`.
2. Reads CookVideo's real `package.json` and refuses if it has no `scripts.test` entry.
3. Runs `npm test` in the CookVideo repository (current branch/working tree as-is — no
   checkout, no stash, no install step of any kind).
4. Reads the real process exit code back — never a self-reported or assumed result.
5. On a genuine pass (exit code 0), moves the task `TESTING -> REVIEW`. On any failure above
   (no resolvable test command, a spawn error, or a real non-zero exit), moves the task to
   `FAILED` — recoverable back to `PLANNED`/`IMPLEMENTING`, the same "any doubt about whether
   the real action happened -> FAILED" philosophy `commit`/`push` already established
   (Milestone 12), applied consistently rather than special-cased for test failures alone.

## Output handling

CookVideo's test output can be large. `TASK_STATE.json`'s `result` field only ever holds a
bounded tail (`truncateForResult` in `src/lib/testRun.ts`, 2000 characters by default) of a
failing run's combined stdout/stderr — enough to show a real failure's tail (stack trace,
failing assertions) without risking an unbounded state file. The full, untruncated output is
always preserved in `.cookvideo/TEST_LOG.json` (see "Audit trail" below), never discarded.

## Audit trail

Every `test` attempt — dry-run or real, pass or fail — is appended to
`.cookvideo/TEST_LOG.json` (mirroring `EXECUTION_LOG.json`/`GIT_WRITE_LOG.json`'s exact
pattern), recording the resolved command, the real exit code, and the full untruncated
stdout/stderr.

## What this milestone does *not* do

- Does not change what `execute`/`commit`/`push`/`advance` do, or make `advance --to REVIEW`
  require a prior `test` run — a task can still reach `REVIEW` via the existing free-text
  `advance` path exactly as before.
- Does not add a new lifecycle phase or transition — `TESTING -> REVIEW` and
  `TESTING -> FAILED` already existed in `src/lib/taskState.ts`'s `TRANSITIONS` table.
- Does not change any category in `APPROVAL_POLICY.md`.
- `COOKVIDEO_AGENT_TEST_MODE` defaults to `dry-run` everywhere this project is actually
  configured, and no milestone has yet set it to `local` in any real environment. `local`
  mode exists as a documented, tested code path — not as something currently enabled.
  Enabling it for real is a deliberate future decision, to be recorded in
  `.cookvideo/DECISIONS.md` when it happens, exactly like `EXECUTION_POLICY.md`'s and
  `GIT_WRITE_POLICY.md`'s own equivalent statements.

See `.cookvideo/MILESTONE_13_PROPOSAL.md` for the design discussion and options considered
before this was built, and `.cookvideo/DECISIONS.md` for the recorded decision.
