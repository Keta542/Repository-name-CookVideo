# Milestone 13 (proposed, not yet built) — `cookvideo-agent verify`: real CookVideo test suite execution

Status: **proposal only**. Nothing described below has been implemented. This document exists
so the design can be reviewed and the open decisions at the bottom can be answered explicitly
before any code is written — the same way Milestone 12's fork points (failure handling, target
hardcoding) were decided up front rather than assumed. Once approved, the "Decision" this
document turns into belongs in `.cookvideo/DECISIONS.md`, alongside Milestones 1–12.

## Problem

`README.md`'s own "Tools" section still lists this as outstanding:

> Planned, not yet built: running the CookVideo test suite

Nothing in this control plane currently runs CookVideo's real tests and checks the result.
`TESTING → REVIEW` today happens one of two ways, and neither is independent, verified evidence
that CookVideo's tests actually pass:

- `cookvideo-agent advance --to REVIEW` — a human free-text assertion, never checked against
  git or any external system (by design, per its own docs).
- Inside `cookvideo-agent execute --execute` (`runExecution` in `src/lib/execution.ts`) — moves
  `IMPLEMENTING → TESTING` based on Claude's own process exit code and whether the expected files
  changed on disk. `EXECUTION_POLICY.md` says "Tests may run" during LOCAL execution, but that
  means Claude *may choose to* run tests as part of its own work — this control plane never
  independently invokes or checks CookVideo's test suite itself.

So a task can reach `REVIEW`/`APPROVAL_REQUIRED`/`APPROVED` without this control plane ever
having run a single real CookVideo test. This milestone closes exactly that gap — nothing more.

## Options considered

1. Fold real test execution into `execute --execute` itself, so LOCAL mode both invokes Claude
   and independently verifies tests in one call.
2. Fold it into `advance --to REVIEW`, replacing the free-text assertion with a real check when
   moving out of `TESTING`.
3. **A new, separate, dedicated command — `cookvideo-agent verify`** — that only runs CookVideo's
   real test suite and records a genuine pass/fail, independent of `execute`, `advance`,
   `commit`, or `push`.

**Recommendation: option 3**, for the same reason Milestone 12 kept `commit` and `push` as two
separate commands rather than folding either into `advance`: lifecycle recording, invoking
Claude, and now independently verifying tests are three different kinds of action, each
deserving its own explicit, single-purpose command rather than an existing command growing a new
implicit responsibility. `advance`'s whole existing contract ("purely descriptive, human-recorded,
never verified against git") stays untouched under option 3; under option 2 it would need a
special case.

## Proposed design (mirrors `execute`'s and `commit`/`push`'s existing double-gate pattern)

- **New `src/lib/testRunner.ts`.** A never-throws `runCookVideoTests()` (same philosophy as
  `invokeClaude` in `src/agents/claude.ts` and `runCommitWrite`/`runPushWrite` in
  `src/lib/gitWrite.ts`): resolves with `{ command, exitCode, stdout, stderr, spawnError? }`,
  never rejects.
  - The test command is **read from CookVideo's own `package.json` `scripts.test`**, never
    hardcoded to `npm test` and never guessed — the same "verify against ground truth, never
    assume" discipline `resolveExpectedTargetPath`/`validateExpectedTargets` already established
    in `execution.ts`, and `validateGitWriteScope` established in `gitWrite.ts`. If CookVideo
    declares no `test` script, `verify` refuses cleanly before spawning anything.
- **New CLI command `cookvideo-agent verify [--execute]`** (`src/commands/verify.ts`):
  - Reachable only when the active task's `phase` is exactly `TESTING` — refuses otherwise, same
    phase-gate style as `commit` (`APPROVED`) and `push` (`COMMITTING`).
  - **DRY-RUN by default**: prints the exact test command that would run in CookVideo and does
    not spawn anything, exactly like `execute`/`commit`/`push` in dry-run mode.
  - Real execution requires **both** `--execute` on the command line **and** a new, independent
    `COOKVIDEO_AGENT_TEST_MODE=local` environment variable (`parseTestMode` in `src/config.ts`,
    fail-safe to `dry-run` on anything else — identical parsing to `parseExecutionMode` and
    `parseGitWriteMode`). Kept as its own variable, not reused from either existing one, for the
    same reason `GIT_WRITE_MODE` was kept separate from `EXECUTION_MODE`: running Claude,
    writing git history, and now independently running CookVideo's test process are three
    separate categories of real-world action, and enabling one was never meant to silently
    enable another.
  - On a genuine pass (`exitCode === 0`): persists `TESTING → REVIEW` via a new
    `applyVerifyOutcome` (`src/lib/taskState.ts`), reusing the existing `TRANSITIONS` table — no
    new phase, no new transition, exactly like `applyCommitOutcome`/`applyPushOutcome` in
    Milestone 12. `result` records the test command and a short summary (not the full raw
    output — see Known limitations below).
  - On failure (non-zero exit or `spawnError`): moves the task to `FAILED`, preserving a
    truncated stdout/stderr tail in `result` for debugging, mirroring
    `applyCommitOutcome`/`applyPushOutcome`'s existing failure handling.
  - Hardcoded to the `CookVideo` execution target only (`GIT_WRITE_TARGET_NAME`'s existing
    resolution, reused) — no `--target` flag, so `verify` can never be pointed at
    CookVideoAgent's own repository, matching `commit`/`push`.
  - Every attempt (dry-run or real, pass or fail) appended to a new `.cookvideo/TEST_LOG.json`,
    mirroring `EXECUTION_LOG.json`/`GIT_WRITE_LOG.json`'s exact append-only pattern.
- **Docs to update once this is approved and built:**
  - `README.md` — remove "running the CookVideo test suite" from the "Tools" section's planned
    list; add a `### verify` section next to `### commit`/`### push`; add a "Milestone 13"
    section under "Current milestone".
  - New `.cookvideo/TEST_POLICY.md`, mirroring `EXECUTION_POLICY.md`/`GIT_WRITE_POLICY.md`'s
    DRY-RUN/LOCAL structure.
  - `.cookvideo/DECISIONS.md` — this proposal, promoted to a dated decision entry once built.
  - `.cookvideo/BUILD_LOG.md` — the usual dated entry.
  - `.cookvideo/APPROVAL_POLICY.md` — no change expected; running tests is already listed as
    `AUTOMATIC`, and this milestone doesn't add a new approval category, it makes an already-
    automatic action real and evidence-based instead of assumed/self-reported.

## Out of scope for this milestone

- No change to what `execute`/`commit`/`push` do, or to `advance`'s existing free-text semantics.
- No new lifecycle phase and no new transition — `TESTING → REVIEW` and `TESTING → FAILED`
  already exist in `TRANSITIONS`.
- No change to any approval category in `APPROVAL_POLICY.md`.
- Does not make `advance --to REVIEW` require `verify` to have run first — that would be a
  materially bigger, separate decision (effectively removing the free-text path), not assumed
  here.

## Decided

1. **Failure handling:** decided — a failing test run moves the task straight to `FAILED`, same
   as a failed `push` (`applyPushOutcome`). Consistent with `commit`/`push`'s "any doubt → FAILED"
   philosophy: `applyVerifyOutcome`'s failure path moves `TESTING → FAILED` on any non-zero exit
   or `spawnError`, with no special-cased cheaper retry. Recovery goes back through
   `PLANNED`/`IMPLEMENTING` via `TRANSITIONS`' existing `RECOVERABLE_FROM_STUCK` path, exactly
   like a failed push today — accepted for the same reason Milestone 12 accepted it: one
   consistent meaning for `FAILED` across every real-action command in this control plane,
   rather than a special case for test failures alone.

## Open decisions that still need an explicit answer before implementation

2. **Output volume in `TASK_STATE.json`/`TEST_LOG.json`:** CookVideo test output could be large.
   Proposal above stores a truncated tail in `result`; the full untruncated output would go only
   to `TEST_LOG.json` (or a `.cookvideo/` working file, git-ignored like `briefs/`) — needs a
   concrete size limit decided, not left implicit.
3. **What counts as "the test script":** if CookVideo's `package.json` defines multiple
   test-shaped scripts (`test`, `test:unit`, `test:e2e`), does `verify` only ever run the plain
   `test` script (simplest, matches `npm test` convention), or does the task input need a way to
   specify which one? Recommend: only `scripts.test`, nothing configurable yet — matches this
   project's pattern of adding configurability later only when a concrete task actually needs it
   (e.g. `--target` wasn't added to `commit`/`push` either).

## Known limitations (anticipated, same spirit as Milestone 12's list)

- `verify` never runs `execute` or vice versa — a task could reach `TESTING` without `execute`
  ever having run (e.g. a purely human-implemented task advanced there via `advance`), and
  `verify` would still work, since it only reads CookVideo's current working tree state, not
  anything about how it got there.
- Like `getChangedFilePaths` in `gitWrite.ts`, this does not attempt to parse or interpret
  CookVideo's test output beyond exit code — a test runner that exits 0 despite real failures
  (a misconfigured reporter, for example) would be reported as a pass. This control plane trusts
  the exit code as ground truth, exactly as `commit`/`push` trust `git`'s own exit codes and
  output.
- `COOKVIDEO_AGENT_TEST_MODE` will default to `dry-run` everywhere this project is actually
  configured when first built, exactly as `EXECUTION_MODE`/`GIT_WRITE_MODE` do today — enabling
  `local` for real remains a separate, deliberate future decision.
