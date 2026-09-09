# CookVideo Agent — Build Log

Chronological record of what was built or changed in this project. Newest entries at the
top.

---

## 2026-09-09 — Task planned via `cookvideo-agent plan`: EXAMPLE-UI-COPY-001

- Objective: Update the empty-state copy on the CookVideo saved-recipes screen so it points people toward the Discover tab instead of just saying 'No recipes saved yet.'
- Risk level: LOW
- Phase set to PLANNED; approvalStatus set to NOT_REQUIRED (approvalRequirements recorded for
  later -- the approval workflow itself has not started).
- Read-only with respect to CookVideo; did not invoke Claude, run `git commit`/`git push`, or
  touch Supabase, Vercel, Mux, or GitHub.


## 2026-09-09 — Milestone 4: Planner → Task creation interface (`plan`)

- Added `src/lib/taskInput.ts`: the task input contract -- the handoff boundary an external
  planner (e.g. ChatGPT) submits a structured task through. `TaskInput` requires `taskId`,
  `objective`, `scope`, a non-empty `requestedChanges`, `filesExpectedToChange`,
  `testsRequired`, a `riskLevel` (reusing the same `RISK_LEVELS` Milestone 2 already
  defines), and `approvalRequirements`. `validateTaskInput` is a pure function that checks
  an already-parsed value against this shape and collects *every* problem in one pass (not
  just the first) so a bad submission gets one complete error report; `readTaskInputFile`
  wraps it with file/JSON handling, never throwing -- a missing file or malformed JSON comes
  back as data, same as every other failure mode in this codebase.
- Added `src/lib/plan.ts`: the task-creation orchestration engine, mirroring the existing
  `execute`/`execution.ts` split between thin CLI wiring and a testable lib module.
  `buildTaskStateFromInput` maps validated input onto a fresh `TaskState` -- always starting
  at phase `PLANNED` with `approvalStatus: NOT_REQUIRED` (the approval workflow itself only
  begins once a task reaches `APPROVAL_REQUIRED` in a later milestone; `approvalRequirements`
  is preserved as the planner's *anticipated* future approval needs, not a live request).
  `REPLACEMENT_BLOCKED_PHASES`/`isSafeToReplace` encode existing-task protection: replacing
  a task is refused while it is `IMPLEMENTING`, `TESTING`, `REVIEW`, `APPROVAL_REQUIRED`,
  `APPROVED`, `COMMITTING`, `DEPLOYING`, or `VERIFYING`, and allowed only from `PLANNED` or a
  genuinely terminal phase (`COMPLETED`/`FAILED`/`BLOCKED`/`CANCELLED`). `runPlan` is the
  full orchestration -- read/validate input, check for an existing task (refuse without
  `--replace`), check replacement safety, then and only then write `TASK_STATE.json`,
  `ACTIVE_TASK.md` (via `formatActiveTaskMarkdown`), and a `BUILD_LOG.md` entry (via
  `prependBuildLogEntry`, which inserts under the "newest entries at the top" marker rather
  than appending at end-of-file). Every refusal path returns `state: null` and never calls
  `saveTaskState` -- `TASK_STATE.json` is written exactly once, at the very end, only after
  every check has passed.
- Added `src/commands/plan.ts`: thin CLI wiring (`runPlanCommand`, `formatPlanReport`)
  between `src/config.ts`/`src/lib/plan.ts` and the CLI, matching `execute.ts`'s pattern.
- Added CLI command `cookvideo-agent plan --file <path> [--replace]` (`npm run plan -- --file
  <path>`). Prints every validation error on bad input, or -- for the existing-task and
  replacement-safety refusals -- the existing task's ID and phase, exactly as required.
- Extended `TaskState` (`src/lib/taskState.ts`) with two fields planner input needs
  preserved verbatim: `requestedChanges` and `approvalRequirements`. `EMPTY_TASK_STATE` and
  `isValidTaskState` were updated to match. `loadTaskState` normalizes pre-Milestone-4
  `TASK_STATE.json` files (which lack these two fields) by defaulting them to `[]` *before*
  shape-validating, so every state file written by Milestones 1-3 keeps loading exactly as
  it did before -- a missing field there is backward compatibility, not corruption; a
  present-but-wrong-shaped field is still a real, rejected error. `commands/task.ts`'s
  report now also prints `requestedChanges`/`approvalRequirements` for completeness.
- Fixed a consistency gap surfaced while demonstrating this milestone: `cookvideo-agent
  reset` previously only reset `TASK_STATE.json`, never touching `ACTIVE_TASK.md` -- harmless
  while `ACTIVE_TASK.md` was a hand-maintained document, but now that `plan` writes real
  task content into it, a `reset` with no matching `ACTIVE_TASK.md` update would leave the
  two files disagreeing (`TASK_STATE.json` empty, `ACTIVE_TASK.md` still showing the last
  planned task) -- exactly the invariant `README.md` promises they never do. `reset` now
  also rewrites `ACTIVE_TASK.md` back to its "no active task" form via the same
  `formatActiveTaskMarkdown` renderer `plan` uses.
- Added `examples/implement-ui-copy.json`: a harmless example task (a UI-copy-only change to
  the saved-recipes empty state) demonstrating the input contract. Used only to exercise
  `plan` during this milestone's own verification -- never executed, and no CookVideo file
  was ever touched by it.
- Added `src/__tests__/taskInput.test.ts` (24 tests) covering: a valid task accepted; each
  required field's absence rejected (`taskId`, `objective`, `scope`, `requestedChanges`);
  an invalid `riskLevel` rejected; an invalid `approvalRequirements` (wrong type and
  non-string items) rejected; malformed JSON and a missing file rejected; existing-task
  protection (refused without `--replace`, existing task ID surfaced); refusal to replace a
  task in each blocked phase; successful replacement from each safe/terminal phase; and
  confirmation that a failed validation never creates or modifies `TASK_STATE.json`.
- Added an `execute`-parity `plan` npm script to `package.json`.
- Updated `README.md` (planner/control-plane/implementation-engineer roles, the JSON task
  contract as the handoff boundary, `plan` creates a `PLANNED` task only, execution remains
  separately approval-gated) and `ARCHITECTURE.md` (brought up to date through this
  milestone -- it had been left at its Milestone 1 description).
- Verified: `npm run typecheck` (clean), `npm run lint` (clean), `npm test` (all new tests
  passing alongside every Milestone 1-3 test), and live runs of `inspect`/`status`/`task`
  against the pre-existing (pre-Milestone-4-shape) `TASK_STATE.json` to confirm backward
  compatibility, followed by `plan` (fresh task), `plan` without `--replace` (correctly
  refused), `plan --replace` while `IMPLEMENTING` (correctly refused), `plan --replace`
  once `COMPLETED` (correctly succeeded), then `reset` to restore the control plane to an
  empty state -- confirmed via `task`/`status` and by inspecting `ACTIVE_TASK.md` directly.
- Did not commit, push, or touch CookVideo, Supabase, Vercel, Mux, or GitHub. `plan` cannot
  reach any of them by construction -- it only ever writes `TASK_STATE.json`,
  `ACTIVE_TASK.md`, and a `BUILD_LOG.md` entry at the configured control-plane paths.

## 2026-09-09 — Milestone 3: Claude execution adapter

- Added `src/agents/claude.ts`: the Claude adapter -- a command/process boundary, not a
  clipboard/chat-window automation system. `formatImplementationBrief` renders a task's
  recorded state into a structured markdown brief (nothing invented beyond what
  `TASK_STATE.json` records); `buildClaudeCommand` is a pure function building the exact
  `{command, args, cwd}` that would be invoked; `invokeClaude` spawns that command via
  `node:child_process.spawn` and -- matching `src/lib/git.ts`'s never-throws philosophy --
  always resolves with a structured `ClaudeExecutionResult` (exit code, captured
  stdout/stderr, or a `spawnError` if the process couldn't start) rather than throwing.
- Added `src/lib/execution.ts`: the task execution module. Loads `TASK_STATE.json`;
  validates a task exists (`validateTaskExists`); validates the requested lifecycle
  transition by reusing `isValidTransition` from `src/lib/taskState.ts`
  (`validateExecutionTransition` -- a task must already be `IMPLEMENTING` or be able to
  move there); checks the approval policy (`checkApprovalForExecution` -- refuses only a
  `REJECTED` task, since letting Claude attempt implementation is an `AUTOMATIC` action
  per `APPROVAL_POLICY.md`); builds and writes the implementation brief
  (`buildImplementationBrief`, `.cookvideo/briefs/<taskId>.md`); builds the Claude command;
  decides, via a double gate, whether to actually invoke it; and appends a record of every
  attempt (dry-run or real) to `.cookvideo/EXECUTION_LOG.json`
  (`appendExecutionRecord`). `runExecution` never throws -- every failure mode is returned
  as data.
- Added `src/commands/execute.ts`: thin CLI wiring (`runExecuteCommand`,
  `formatExecuteReport`) between `src/config.ts`/`src/lib/execution.ts` and the CLI.
- Added CLI command `cookvideo-agent execute [--execute]`. Defaults to SAFE/DRY-RUN:
  prints the task objective, allowed scope, expected files, required tests, approval
  requirements, and the exact Claude command that *would* be invoked, then states plainly
  that nothing was executed and why. Real execution requires **both** `--execute` on the
  command line **and** `COOKVIDEO_AGENT_EXECUTION_MODE=local` in the environment -- either
  one missing falls back to dry-run. `main()` in `src/cli.ts` is now async to support this.
- Added configuration in `src/config.ts`: `COOKVIDEO_AGENT_EXECUTION_MODE` (`dry-run` |
  `local`, via `parseExecutionMode`, fails safe to `dry-run` for any unset/invalid value --
  a typo can never accidentally enable real execution), `COOKVIDEO_AGENT_CLAUDE_COMMAND`
  (the local Claude command/executable, default `claude`, never a hardcoded path
  assumption), `BRIEFS_DIR` (`.cookvideo/briefs/`), and `EXECUTION_LOG_PATH`
  (`.cookvideo/EXECUTION_LOG.json`). No credentials or secrets anywhere.
- Added `.cookvideo/EXECUTION_POLICY.md`, documenting DRY-RUN and LOCAL mode exactly as
  specified: DRY-RUN prepares and displays only, no external process execution; LOCAL may
  invoke Claude locally against the approved working directory, may run tests, may inspect
  `git diff`/`status` -- commit, push, and all production systems (Supabase, Vercel, Mux,
  GitHub) remain approval-gated in both modes, unchanged from `APPROVAL_POLICY.md`.
- Added `.cookvideo/EXECUTION_LOG.json`, shipped in its initial empty (`[]`) form.
- Added `src/__tests__/fixtures/harmlessTask.ts`: a dedicated, obviously-fake task
  (`TEST-HARMLESS-001`) used only by the test suite -- never written to the real
  `TASK_STATE.json`, never referencing CookVideo.
- Added `src/__tests__/claude.test.ts` (7 tests) and `src/__tests__/execution.test.ts`
  (25 tests) covering: dry-run never invoking a process (even with `--execute` alone, or
  `EXECUTION_MODE=local` alone -- the double gate holds either way); task validation and
  missing-task handling; execution-mode validation (`parseExecutionMode`'s fail-safe
  behavior); the lifecycle-transition check; approval-gate enforcement (`REJECTED` tasks
  refused); command construction (the exact command built matches configuration); real
  invocation only firing when both gate conditions hold; and failed-process handling (both
  a spawn error and a non-zero exit code) without ever throwing.
- Updated `README.md` with a new "Claude execution adapter" section (architecture,
  dry-run behavior, local execution behavior, approval boundaries), an `execute` entry in
  Usage and the state-file table, and updated "Current milestone."
- Added `.cookvideo/briefs/` to `.gitignore` (implementation briefs are working artifacts,
  not source-controlled documents; `EXECUTION_LOG.json` itself is tracked).
- Added an `execute` npm script to `package.json` (matching the existing pattern: build,
  then `node dist/cli.js execute`).
- Verified: `npm run typecheck` (clean), `npm run lint` (clean), `npm test` (all new tests
  passing; the pre-existing `inspect.test.ts` integration tests against the real CookVideo
  repository were exercised on the real machine, not just the build sandbox), and live runs
  of `inspect`/`status`/`task`/`execute` -- including a temporary, fully-reversible demo
  task used only to show real dry-run output end-to-end, then reset back to empty via
  `cookvideo-agent reset` (never left in place).
- Did not commit, push, or touch CookVideo, Supabase, Vercel, Mux, or GitHub. Did not
  invoke a real Claude process against this or any other repository -- every demonstration
  of `--execute` + `EXECUTION_MODE=local` in this milestone used either a nonexistent
  command (to prove failed-process handling) or stayed in dry-run.

## 2026-09-09 — Infra adjustment: drop npm link from the dev workflow

- Removed `npm link` / global-install as a required step from the development workflow.
  Added `task`, `approve`, and `reset` npm scripts to `package.json` (matching the existing
  `inspect`/`status` pattern: build, then run `node dist/cli.js <command>`), so every CLI
  command is reachable via `npm run <command>` or `node dist/cli.js <command>` without any
  global/PATH installation step.
- Updated `README.md`'s Install and Usage sections accordingly: npm scripts (or the direct
  `node dist/cli.js` invocation) are now the documented, supported way to run the CLI during
  development. The two lifecycle-section references to `cookvideo-agent approve`/`reset`
  were updated to match.
- Left `package.json`'s `bin` field (`cookvideo-agent` -> `./dist/cli.js`) untouched, so
  `npm link` (or a global install) still works later on a normal Windows environment if
  desired -- it's just no longer part of the documented/required dev workflow.
- Ran `tsc --noEmit`, `eslint`, the full test suite, and real `inspect`/`status`/`task`
  invocations (via the local CLI) to confirm nothing broke.
- Did not commit, push, or touch the CookVideo repository, Supabase, Vercel, Mux, or
  GitHub.

## 2026-09-09 — Milestone 2: task and approval engine

- Added `src/lib/taskState.ts`: the 13-phase task lifecycle (`PLANNED` through
  `COMPLETED`, plus `FAILED`/`BLOCKED`/`CANCELLED`) as an explicit adjacency map
  (`TRANSITIONS`) checked by a pure `isValidTransition(from, to)` function, plus the
  `TaskState` shape, a runtime `isValidTaskState` type guard, `loadTaskState`/
  `saveTaskState` (file-path parameterized, never hardcoded to the real state file —
  keeps this fully unit-testable), `approveTask` (moves `APPROVAL_REQUIRED` →
  `APPROVED` only; refuses from any other phase; no-ops if already approved; never
  commits/pushes/deploys), and `resetTaskState` (returns a fresh empty state; never
  deletes files itself).
- Added `.cookvideo/APPROVAL_POLICY.md`, transcribing the three approval categories
  (AUTOMATIC / REQUIRES USER APPROVAL / ALWAYS REQUIRES USER APPROVAL) verbatim.
- Added `.cookvideo/TASK_STATE.json`, the machine-readable task state file, shipped in
  its empty/initial form (no active task).
- Rewrote `.cookvideo/ACTIVE_TASK.md` as a structured template covering task ID,
  objective, scope, requested changes, files expected to change, tests required, risk
  level, approval requirements, current phase and result — populated as "no active
  task" (this milestone's own work was not tracked through the engine, since the
  engine didn't exist yet when the milestone started).
- Added CLI commands: `cookvideo-agent task` (prints the current task state),
  `cookvideo-agent approve` (the only thing it does is flip `APPROVAL_REQUIRED` →
  `APPROVED` — no commit, push, or deploy), and `cookvideo-agent reset` (overwrites
  `TASK_STATE.json` with an empty state; never touches source or repository files).
- Extended `cookvideo-agent status` to include a one-line task summary
  (`Task: <phase> (<taskId or "none">)`).
- Added `src/__tests__/taskState.test.ts`: unit tests (temp-file-based, never touching
  the real `TASK_STATE.json`) covering task state loading (missing file, round-trip,
  corrupt JSON, wrong shape), lifecycle transition validation (forward path, rejected
  skips/backtracks, universal FAILED/BLOCKED/CANCELLED escape hatches, recovery from
  FAILED/BLOCKED, terminal phases), task-state shape validation, `approveTask`
  behavior (success, no active task, wrong phase, already-approved no-op), and
  `resetTaskState`/`saveTaskState`/`loadTaskState` round-tripping.
- Updated `README.md` with a new section explaining the task lifecycle and the three
  approval gate categories.
- Ran `tsc --noEmit`, `eslint`, the full test suite, and real `cookvideo-agent
  inspect`/`status`/`task` invocations before considering the milestone done.
- Did not commit, push, or touch the CookVideo repository, Supabase, Vercel, or Mux.

## 2026-09-09 — Milestone 1: initial scaffold

- Created the TypeScript Node.js project structure (`package.json`, `tsconfig.json`,
  minimal flat-config ESLint, zero runtime dependencies).
- Implemented the `cookvideo-agent` CLI with `inspect` and `status` commands.
- Implemented `src/lib/git.ts` (branch/commit/dirty via `git`, never throws — failures
  surface as data) and `src/lib/cookvideoRepo.ts` (verifies the CookVideo repo and its
  Next.js app actually exist and that `apps/web/package.json` really declares a `next`
  dependency, rather than assuming).
- Created the `.cookvideo/` state directory and populated it with these five files.
- Added `src/__tests__/inspect.test.ts` — an integration test (via Node's built-in test
  runner, `node:test`) that runs `inspect`'s logic against the real, configured CookVideo
  repository and asserts it succeeds.
- Ran `tsc --noEmit`, `eslint`, the test suite, and a real `cookvideo-agent inspect`
  invocation before considering the milestone done.
