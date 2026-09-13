# CookVideo Agent — Decisions

Architectural decisions about the control plane itself. For CookVideo application
decisions, see the CookVideo repository's own DECISIONS.md.

Format per entry: Problem / Options considered / Decision / Why / Known limitations.

---

## 2026-09-09 — Scaffold CookVideoAgent as a separate project (Milestone 1)

**Problem:** Coordinating ChatGPT (planner), Claude (implementation engineer), and the
CookVideo repository needs a shared, verifiable source of ground truth — not narrative
memory carried between sessions.

**Options considered:**
1. Put coordination scripts inside the CookVideo repo itself.
2. Build a separate, independent project (CookVideoAgent) that only reads CookVideo.

**Decision:** Option 2 — a fully separate TypeScript Node.js CLI project at
`C:\Users\aesfm\CookVideoAgent`, with its own git history and dependencies, kept
structurally isolated from the CookVideo Next.js application.

**Why:**
- Keeps the CookVideo application's dependency tree, CI, and history uncontaminated by
  control-plane tooling that has nothing to do with the product itself.
- Makes the "read-only with respect to CookVideo" boundary easy to reason about and audit —
  a separate repo can't accidentally end up in the same commit as an application change.
- Lets the control plane evolve (new commands, new integrations) on its own release cadence.

**Known limitations:**
- Milestone 1 is intentionally minimal: two read-only commands (`inspect`, `status`), zero
  runtime dependencies, no credentials, no write access to CookVideo, Supabase, Vercel, or
  Mux. Anything beyond that (actually invoking Claude Code, writing task state that other
  tools consume, real integrations) is future scope and has not been designed yet.
- The CookVideo repository path is currently hardcoded (with an env-var override) rather
  than configurable via a config file — acceptable for a single-machine, single-repo
  milestone; would need revisiting for multi-repo or multi-machine use.

---

## 2026-09-11 — Register CookVideo as an approved execution target (Milestone 4)

**Problem:** The Claude execution adapter (Milestone 3) could only ever run against this
control plane's own repository (`AGENT_ROOT`), hardcoded as the `cwd` in
`src/commands/execute.ts`. Doing real implementation work in the actual CookVideo repository
needs a way to point Claude's working directory there — without opening execution up to an
arbitrary or operator-guessed filesystem path.

**Options considered:**
1. Accept a raw `--path <path>` (or similar) on `cookvideo-agent execute`, trusting the
   caller to supply a safe directory.
2. Introduce a second, separate configuration mechanism (e.g. a JSON targets file) just for
   this.
3. Add a small, explicit, closed registry of named targets (`EXECUTION_TARGETS`) inside the
   configuration module that already exists (`src/config.ts`), each with a name, a fixed
   path, and a stated purpose; resolve a target only by name, never by path.

**Decision:** Option 3. `src/config.ts` now defines `EXECUTION_TARGETS` with exactly two
entries — `CookVideoAgent` (this repository, still the default) and `CookVideo`
(`C:\Users\aesfm\CookVideo`) — plus `resolveExecutionTarget(name)` and
`listExecutionTargetNames()`. `cookvideo-agent execute` gained an optional `--target <name>`
flag; omitting it preserves the exact Milestone 3 behavior (cwd = `AGENT_ROOT`). An unknown
target name is refused in `src/commands/execute.ts` before `runExecution` is ever called —
no brief is written, no command is built, nothing is spawned.

**Why:**
- Keeps target selection name-based and closed rather than path-based and open — a typo or a
  malicious task input can name an unrecognized target (rejected) but can never smuggle in an
  arbitrary path.
- Reuses the configuration module and patterns (`src/config.ts`) that already exist for
  `COOKVIDEO_REPO_PATH`, `CLAUDE_COMMAND`, etc., rather than inventing a second config system.
- `src/lib/execution.ts`'s pure orchestration is untouched — it still just takes a `cwd`
  string. Target resolution lives entirely in the thin wiring layer
  (`src/commands/execute.ts`), so its extensive existing test suite required no changes.
- Leaves every approval-gated action (`APPROVAL_POLICY.md`: commit, push, production
  Supabase/Vercel/Mux, destructive operations) completely unaffected — target selection only
  changes where Claude may read/edit under the existing AUTOMATIC category, never what
  requires approval.

**Known limitations:**
- The registry is a fixed, hand-maintained list in source — adding a third target requires a
  code change and a new decision recorded here, which is intentional for now but would need
  revisiting if target repositories become numerous or need to be added without a code
  change.
- `--target` only selects Claude's working directory; it does not yet do anything to scope
  which git repository `inspect`/`status` report on, or otherwise change any other command's
  behavior. Those remain CookVideoAgent-only, as before.

---

## 2026-09-11 — Verify a task's expected targets exist before invoking Claude

**Problem:** Naming a target repository by name (the previous decision) closes off *which*
repositories execution can point at, but says nothing about whether a given task's own
`filesExpectedToChange` still makes sense for the currently selected target. A task can go
stale (the file was renamed or removed since the planner wrote the task), or be run against
the wrong target repository by operator error -- in either case, nothing previously stopped
`runExecution` from writing a brief and invoking Claude against a target that doesn't actually
contain what the task describes, leaving Claude to improvise.

**Options considered:**
1. Leave it to Claude's own judgment once invoked -- trust the implementation brief and the
   agent to notice a missing file and stop itself.
2. Warn but proceed -- log a warning to the execution record and still invoke Claude.
3. Verify every `filesExpectedToChange` path exists in the selected target's repository
   before the brief is written or Claude is invoked; on any miss, stop and return a
   structured target-mismatch result requiring human approval to proceed.

**Decision:** Option 3. Added `validateExpectedTargets` to `src/lib/execution.ts`, run in
`runExecution` immediately after the existing approval-policy check and before
`buildImplementationBrief`/writing the brief file. A miss short-circuits into a new
`targetMismatchRefusal`, which populates `RunExecuteResult.targetMismatch` (`missingPaths`,
`targetPath`, `requiresHumanApproval: true`) instead of a brief/command. `cookvideo-agent
execute` (`formatExecuteReport`) renders this distinctly from the normal dry-run/local report.

**Why:**
- This control plane's entire premise (`ARCHITECTURE.md`) is a shared, verifiable view of
  ground truth rather than something anyone assumes -- silently letting Claude substitute a
  different file when the recorded target is missing would violate that premise more directly
  than almost anything else this control plane does.
- Placing the check ahead of `buildImplementationBrief` means no misleading brief is ever
  written to `.cookvideo/briefs/` for a task that cannot safely proceed, and Claude is never
  spawned -- verified directly in tests via an `invoke` spy that must never be called,
  regardless of the `--execute`/`EXECUTION_MODE=local` double gate.
- Reuses the existing `cwd`/target-resolution plumbing (`src/config.ts`'s `EXECUTION_TARGETS`,
  `src/commands/execute.ts`'s `resolveExecutionTarget`) -- this check only resolves
  `filesExpectedToChange` against the already-approved `cwd`, and explicitly refuses to
  resolve a path that escapes that root (e.g. `../../etc/passwd`), so it cannot itself become
  a way to reach outside the fixed target allowlist.
- Runs regardless of dry-run vs. local mode, so an operator sees the mismatch while still
  safely previewing the run, not only after flipping on real execution.

**Known limitations:**
- Verification is existence-only (`fs.existsSync`) -- it does not check that the file's
  *content* is still relevant to the task's objective, only that the path is present. A task
  whose target file exists but has drifted unrelated to the task will still pass.
- A target-mismatch attempt is not written to `EXECUTION_LOG.json` (matching the existing
  behavior of the other pre-brief refusals: no active task, invalid lifecycle transition,
  REJECTED approval). If auditing every mismatch attempt becomes important, this would need
  revisiting.

---

## 2026-09-13 — Enforce the risk/approval gate in `completeTask`, not `execute` (Milestone 7)

**Problem:** `.cookvideo/APPROVAL_POLICY.md` and the task lifecycle both describe an
`APPROVAL_REQUIRED` → `APPROVED` gate for risk-bearing work, but nothing in the code ever
*required* a task to pass through it. `completeTask` (`src/lib/taskState.ts`) only refused
completion when `approvalStatus` was already `REJECTED` or `PENDING` -- it never looked at
`riskLevel` or `approvalRequirements`, and no command ever set a task's phase to
`APPROVAL_REQUIRED` in the first place. In practice this meant a `HIGH`-risk task could reach
`COMPLETED` with zero human approval ever recorded, as long as nobody had manually put it into
`PENDING`. This had not yet caused a real incident only because every task run through this
control plane so far (Milestones 4-6) has been `riskLevel: LOW`.

**Options considered:**
1. Have `cookvideo-agent execute` (`src/lib/execution.ts`) persist a phase transition into
   `APPROVAL_REQUIRED`/`PENDING` once implementation succeeds, for qualifying tasks.
2. Add a new, separate CLI command (e.g. `cookvideo-agent gate` or `request-approval`) that a
   human or ChatGPT would have to remember to run before `complete`.
3. Enforce the gate inside `completeTask` itself: refuse completion for a qualifying,
   unapproved task, and -- reusing the exact walk-to-`COMPLETED` logic `completeTask` already
   performs against `FORWARD_PATH_TO_COMPLETION`/`isValidTransition` -- stop that walk early,
   at `APPROVAL_REQUIRED`, persisting `approvalStatus: PENDING` there instead of silently
   refusing with no state change.

**Decision:** Option 3. `requiresApprovalGate(state)` (`src/lib/taskState.ts`) is true when
`riskLevel` is `MEDIUM`/`HIGH` or `approvalRequirements` is non-empty. `completeTask` checks
this (after its existing `REJECTED`/`PENDING` refusals, so those keep their current behavior
unchanged) and, for a qualifying task that isn't yet `APPROVED`, validates and applies the
sub-path from the task's current phase up to (not including) `APPROVAL_REQUIRED` using the
same per-hop `isValidTransition` check the full walk already uses, then returns a new state
with `phase: "APPROVAL_REQUIRED"`, `approvalStatus: "PENDING"` -- and `ok: false`, since the
task did not reach `COMPLETED`. `cookvideo-agent approve` then works exactly as before to move
it to `APPROVED`, after which re-running `complete` finishes the remaining hops normally.

**Why:**
- Reuses 100% of the existing transition machinery (`FORWARD_PATH_TO_COMPLETION`,
  `isValidTransition`) -- no parallel/duplicate state machine, and no new lifecycle phase or
  transition was added to `src/lib/taskState.ts`'s `TRANSITIONS` table.
- `execute` (option 1) deliberately does not yet persist *any* phase transition to
  `TASK_STATE.json` -- see its own existing comments in `src/lib/execution.ts` and
  `completeTask`'s docstring -- extending its persistence responsibilities was a larger,
  separate change than "make the approval gate real," and out of scope for this milestone's
  constraints.
- A brand-new command (option 2) would be one more step a human or the planner has to
  remember to invoke correctly; making `complete` itself the trigger means the gate is
  enforced at the one moment that actually matters -- immediately before a task would
  otherwise reach `COMPLETED` -- regardless of what phase it happened to be sitting in
  beforehand (in practice, almost always `PLANNED`, since nothing else persists intermediate
  phases yet).
- `cookvideo-agent approve` and `cookvideo-agent complete` were also updated to write
  `TASK_STATE.json`, `ACTIVE_TASK.md`, and a `BUILD_LOG.md` entry using the exact same
  `formatActiveTaskMarkdown`/`prependBuildLogEntry` helpers `plan`/`reset` already use
  (previously only `TASK_STATE.json` was updated by these two commands) -- both commands
  decide whether to persist by checking `result.state !== state` (a reference-equality
  invariant every refusal path in `approveTask`/`completeTask` already upheld, and already
  relied on by this test suite), so a pure refusal or an already-approved/-completed no-op
  never writes a duplicate `BUILD_LOG.md` entry.

**Known limitations:**
- `riskLevel`/`approvalRequirements` are set once, by the planner, at `plan` time, and never
  re-evaluated afterward -- if a task's actual risk changes mid-flight (e.g. its scope grows
  during implementation), nothing currently re-derives or updates them.
- The gate is enforced only at `complete` time. A task can still sit indefinitely in
  `PLANNED`/`IMPLEMENTING`/etc. without ever being routed to a human for early review --
  `complete` being the enforcement point means the gate is only visible when someone actually
  tries to finish the task, not proactively.
- The defensive fallback for a task already at or past `APPROVAL_REQUIRED` in phase but not
  `APPROVED` in status (a combination no command in this control plane produces on its own)
  refuses without moving the phase further, since the lifecycle has no transition backwards
  into `APPROVAL_REQUIRED` -- this is untested against real usage since it is currently
  unreachable, only defensive.

---

## 2026-09-13 — Persist `execute`'s lifecycle transitions inside `runExecution` (Milestone 8)

**Problem:** Milestone 7's decision above deliberately deferred this: `execute` validated
that a move into `IMPLEMENTING` would be legal but never persisted it, so `TASK_STATE.json`
stayed frozen at whatever phase a task was already in regardless of what execution actually
did. This was silently producing incorrect state: the real
`MILESTONE-6-SEARCH-EMPTY-STATE-001` task showed `COMPLETED` in `TASK_STATE.json` (set by an
older `complete` command, before it wrote `ACTIVE_TASK.md`) while `ACTIVE_TASK.md` still
showed `PLANNED` -- a live instance of exactly the drift `README.md`/`ACTIVE_TASK.md` promise
never happens.

**Options considered:**
1. Leave `execute` as validation-only and add a separate command (e.g. `cookvideo-agent
   advance`) a human or the planner would run afterward to record what happened.
2. Have `runExecution` persist the transition, but only once, at the very end of the attempt
   (skip the intermediate `IMPLEMENTING` write).
3. Have `runExecution` persist two real transitions: `PLANNED`/`FAILED`/`BLOCKED` →
   `IMPLEMENTING` immediately before invoking Claude, and `IMPLEMENTING` → `TESTING`/`FAILED`
   immediately after the outcome is known -- both via small, defensive helper functions in
   `src/lib/taskState.ts` built on the existing `TRANSITIONS` table.

**Decision:** Option 3. Added `beginImplementing` and `applyExecutionOutcome`
(`src/lib/taskState.ts`), mirroring `approveTask`'s single-hop check-and-apply shape.
`runExecution` calls `beginImplementing` right before `invoke(command)` and
`applyExecutionOutcome` right after the outcome (spawn error / exit code / verified file
change) is determined; each call that actually changes the phase writes `TASK_STATE.json`,
`ACTIVE_TASK.md`, and a `BUILD_LOG.md` entry together (the same
`formatActiveTaskMarkdown`/`prependBuildLogEntry` helpers `plan`/`approve`/`complete` already
use). Dry-run calls neither function and writes nothing, matching
`.cookvideo/EXECUTION_POLICY.md`.

**Why:**
- Option 2 (single write) would mean a process that dies mid-Claude-call (a real, plausible
  failure mode for a potentially long-running local process) leaves `TASK_STATE.json` showing
  a stale `PLANNED`/`FAILED` instead of the true in-flight `IMPLEMENTING` -- exactly the kind
  of silent incorrect state this control plane exists to prevent. The two-write approach
  costs one extra file write per real execution in exchange for that crash-safety property.
- Option 1 (a separate command) repeats the exact critique Milestone 7 made of adding a new
  command for its own gate: one more step a human or the planner has to remember to run
  correctly, when the orchestration layer that already knows the outcome (`runExecution`) is
  the one true place to record it.
- No new lifecycle phase or transition was added -- `beginImplementing`/
  `applyExecutionOutcome` both call `isValidTransition` against the same `TRANSITIONS` table
  every other check in this codebase already reads, and both refuse (returning the state
  unchanged) rather than force a transition the table doesn't already allow.
- Fixed the concrete drift this gap had already caused on the real task, by regenerating
  `ACTIVE_TASK.md` from the real `TASK_STATE.json` via the actual `formatActiveTaskMarkdown`
  renderer rather than hand-editing either file.

**Known limitations:**
- `TESTING` is reached purely because Claude's process exited 0 and the expected files
  verifiably changed -- no test runner is invoked or consulted. The phase name records "ready
  for testing," not "tests passed"; actual test automation remains future scope.
- `REVIEW`/`APPROVAL_REQUIRED`/`COMMITTING`/`DEPLOYING`/`VERIFYING` still have no command that
  persists a task into them directly -- `completeTask` (Milestone 7) remains the only way past
  `TESTING`, by validating and applying the entire remaining walk at once. A more granular
  `review`/`commit` step-by-step flow is still future work.
- The pre-invoke `IMPLEMENTING` write assumes a single in-flight `execute` invocation at a
  time -- there is no locking. Two concurrent `execute` runs against the same `TASK_STATE.json`
  could race; this was already true before this milestone (both would have read the same
  starting state) and is not newly introduced, but it is also not newly addressed.

---

## 2026-09-13 — Commit the already-verified Claude invocation fix; add a build-integrity
verification rule (Milestone 9)

**Problem:** The committed, pushed `master` HEAD (`00ae823`, "Persist execute lifecycle
transitions") did not compile. `src/lib/execution.ts`, `src/commands/execute.ts`, and
`src/__tests__/execution.test.ts` were all already committed calling the new stdin-based
`buildClaudeCommand({ ..., briefContent })` / reading `ClaudeExecutionCommand.input`, but
`src/agents/claude.ts` -- the file defining that interface -- was never committed to match; it
was still at its pre-fix `briefFilePath`-as-argv shape. This was confirmed by running
`tsc --noEmit` against an isolated `git worktree` checked out at that HEAD (not the working
tree), which produced 10 type errors. As a direct consequence, every "Verified: npm run
typecheck (clean)... npm test (all passing)" claim recorded in Milestones 6-8's
`.cookvideo/BUILD_LOG.md` entries was only ever true of an uncommitted local working tree,
never of what actually reached `origin/master` -- a direct violation of this project's own
stated premise (`ARCHITECTURE.md`: "a shared, verifiable view of ground truth... rather than
what anyone remembers or assumes").

The four files left uncommitted going into this milestone were not new work-in-progress --
three of them were exactly the missing fix: `src/agents/claude.ts` switches Claude invocation
to non-interactive mode (`-p --permission-mode acceptEdits`), pipes the implementation brief
over the child process's stdin instead of passing a bare file path as an argv value, and adds
Windows `shell:true`/quoting handling (`resolveSpawnOptions`/`quoteForWindowsShell`) required
to spawn the `claude.cmd` shim (`spawn EINVAL` without it). `.cookvideo/EXECUTION_LOG.json`'s
real, unedited history proves the fix works: real local execution attempts against CookVideo
show the exact failure progression this fix resolves (`spawn claude ENOENT` -> `spawn EINVAL`
-> exit code 0 with zero files changed, twice -> exit code 0 with
`apps/web/src/app/search/page.tsx` actually changed in the real CookVideo repository) -- this
is the concrete mechanism by which `MILESTONE-6-SEARCH-EMPTY-STATE-001` ever reached
`COMPLETED` with a real CookVideo commit hash (`c8b7df8`). The fourth uncommitted file,
`src/__tests__/config.test.ts`, was an unrelated test-coverage backfill for
`resolveExecutionTarget`/`listExecutionTargetNames` (already committed in Milestone 4,
`880582a`) that had simply accumulated in the same dirty working tree -- not part of this bug
fix.

**Options considered:**
1. Commit all uncommitted files together in one commit, restoring green state in a single
   step.
2. Commit the `claude.ts` fix and its own test/log evidence as one focused commit, the
   unrelated `config.test.ts` backfill as a second separate commit, and the process
   documentation/safeguard as a third -- keeping each commit's diff attributable to exactly
   one concern.
3. Leave the fix uncommitted and only add the verification safeguard, relying on a future
   milestone to notice and commit it.

**Decision:** Option 2. Three commits: (a) `src/agents/claude.ts` + `src/__tests__/claude.test.ts`
+ `.cookvideo/EXECUTION_LOG.json` -- the verified fix and its evidence; (b)
`src/__tests__/config.test.ts` alone; (c) this `DECISIONS.md` entry, the accompanying
`BUILD_LOG.md` entry, an `ARCHITECTURE.md` "Current milestone" update plus a new
"Verification claims" rule, and a new `verify` npm script in `package.json`.

**Why:**
- Option 3 would leave `master` broken indefinitely and repeats the exact failure mode this
  milestone exists to close.
- Option 1 (single commit) would bury an unrelated test-coverage change inside the
  critical-fix commit's diff, making it harder for a future reviewer (or `git bisect`) to tell
  "what fixed the broken build" from "what happened to be lying around at the same time" --
  exactly the kind of silent absorption this milestone was chartered to avoid.
- The fix itself required no new implementation -- it was already written, already
  unit-tested (`src/__tests__/claude.test.ts`), and already proven against the real CookVideo
  repository via real local `execute --execute` runs recorded in `EXECUTION_LOG.json`. This
  milestone's job was recognizing that, and giving it the deliberate-decision record
  `ARCHITECTURE.md`'s own closing line requires ("Do not expand scope beyond what a given
  milestone explicitly approves without a deliberate decision recorded in
  `.cookvideo/DECISIONS.md`"), which had never happened for this specific interface change.
- A documented rule plus a single `npm run verify` script is proportionate: it closes the
  actual gap (a verification claim describing a state nobody checked was actually committed)
  without introducing a new category of tooling (git hooks, CI) this project has not yet
  decided to adopt.

**Known limitations:**
- The `npm run verify` rule is enforced by discipline, not tooling -- nothing currently blocks
  a commit or push if `git status` is dirty or `verify` was never actually run. A git hook or
  CI check would close that; deliberately deferred as a bigger category of tooling change than
  this milestone's scope.
- This does not retroactively fix or annotate the `BUILD_LOG.md` entries for Milestones 6-8,
  whose "verified" claims were true only of the working tree at the time, not of what was
  pushed -- left as historical record rather than rewritten, consistent with `BUILD_LOG.md`
  being an append-only chronological log.
- Granular persistence for `REVIEW`/`APPROVAL_REQUIRED`/`COMMITTING`/`DEPLOYING`/`VERIFYING`
  (named as a known limitation in Milestone 8's own decision above) remains unaddressed --
  deliberately deferred to a future milestone, not folded in here.

---

## 2026-09-13 — Add granular single-hop lifecycle tracking via `advance` (Milestone 10)

**Problem:** `completeTask` (`src/lib/taskState.ts`) remains the only way past `TESTING` --
it validates and applies the *entire* remaining walk to `COMPLETED` in one call, including
`COMMITTING` and `DEPLOYING`, exactly the two phases `.cookvideo/APPROVAL_POLICY.md`'s
"REQUIRES USER APPROVAL" list is about (git commit, git push, production deploys). Nothing
records, individually and with a timestamp, that each of those real actions actually
happened -- one `complete` call (optionally with a `--commit <hash>`) produces one bulk
`BUILD_LOG.md` entry ("Completed"), not a record of when review happened, when the commit
happened, when the deploy happened, and when it was verified. This was named as a known
limitation in both Milestone 7's and Milestone 8's own decision entries above and deliberately
deferred each time.

**Options considered:**
1. Change `completeTask` itself to stop and persist at each intermediate phase rather than
   walking the whole remaining path in one call.
2. Add a brand-new command per phase (`review`, `commit-record`, `deploy-record`,
   `verify-record`).
3. Add one new, narrow command -- `cookvideo-agent advance --to <phase> [--note <text>]` --
   restricted to exactly the five single hops between `TESTING` and `VERIFYING`
   (`TESTING`→`REVIEW`→`APPROVAL_REQUIRED`, `APPROVED`→`COMMITTING`→`DEPLOYING`→`VERIFYING`),
   leaving `completeTask` completely unchanged as a still-valid one-call shortcut.

**Decision:** Option 3. Added `advanceTaskPhase` (`src/lib/taskState.ts`) and
`cookvideo-agent advance` (`src/commands/advance.ts`). `advance`'s legal target set
(`ADVANCEABLE_TARGET_PHASES`) is a closed, five-member allowlist, each mapped to the exact
single source phase it requires (`ADVANCE_SOURCE_PHASE`) -- not the full `TRANSITIONS`
adjacency, which would also let it claim `IMPLEMENTING` (`execute`'s job),
`APPROVAL_REQUIRED`→`APPROVED` (`approve`'s job), or →`COMPLETED` (`complete`'s job).
`isValidTransition` against the shared `TRANSITIONS` table is still checked defensively
underneath, so `advance` can never move a task somewhere the rest of the lifecycle engine
disagrees with. An optional `--note` is stored verbatim (trimmed) in `result`, exactly like
`completeTask`'s existing `commitHash` option -- free-text, purely descriptive, never verified
against git or any external system. Two specific behaviors were decided explicitly (see
below): `advance` leaves `approvalStatus` untouched even when landing on `APPROVAL_REQUIRED`
for a task that doesn't require the gate, and `--note` is accepted uniformly at all five hops
rather than restricted to `COMMITTING`/`DEPLOYING`.

**Why:**
- Option 1 would have meant changing `completeTask`'s existing, already-tested behavior
  (Milestones 6-7), risking the exact regression this project's "preserve the existing safety
  model" principle exists to prevent -- and would remove the one-call convenience that's
  correct and sufficient for the common `LOW`-risk case.
- Option 2 (one command per phase) would have meant four new commands doing near-identical
  work (validate one hop, write three documents) instead of one parameterized command reusing
  a single code path -- more surface area for the same capability.
- Restricting `advance`'s target set below what `TRANSITIONS` itself allows (rather than
  exposing every transition generically) keeps each existing command's ownership of its own
  phases intact: `execute` alone decides when a task is genuinely `IMPLEMENTING`/`TESTING`
  (it has real postcondition verification behind those transitions -- see Milestone 8);
  `approve` alone decides `APPROVED` (the actual approval-gate flip); `complete` alone decides
  `COMPLETED`. `advance` only ever fills the previously-empty middle.
- Leaving `approvalStatus` untouched when `advance` lands on `APPROVAL_REQUIRED` keeps
  `requiresApprovalGate`/`completeTask` (Milestone 7) as the single place that decides whether
  a task genuinely needs a human's sign-off -- a human recording "this was reviewed" for their
  own audit trail must never, by itself, manufacture an approval requirement that didn't
  already exist per the task's own `riskLevel`/`approvalRequirements`.
- Accepting `--note` uniformly (rather than only at `COMMITTING`/`DEPLOYING`) keeps the
  command's surface simpler -- one option, always available -- and a reviewer may reasonably
  want to leave a note at `REVIEW` or `VERIFYING` too, not only where a commit hash or deploy
  ID exists.

**Known limitations:**
- `advance` still performs no verification of its own -- a `--note` claiming a commit
  happened is exactly as unverified as `completeTask`'s existing `commitHash` option always
  was; this milestone does not change that trust model, only makes it possible to record more
  of it, more often.
- `README.md`'s "Current milestone" section had fallen behind (still describing Milestone 4)
  while `ARCHITECTURE.md`/`DECISIONS.md`/`BUILD_LOG.md` stayed current through Milestones 5-9;
  this milestone updates `README.md`'s "Current milestone" entry and adds `advance`'s own
  documentation, but does not retroactively backfill individual Milestone 5-9 sections there --
  left as a known gap, not silently absorbed into this milestone's scope.
- Performing the actual commit/push/deploy action remains entirely out of scope, exactly as
  `.cookvideo/APPROVAL_POLICY.md` already states -- `advance` only ever records that a human
  says a step happened.

---

## 2026-09-13 — Preserve completed/abandoned task history via `TASK_HISTORY.json` (Milestone 11)

**Problem:** `cookvideo-agent reset` (`src/commands/reset.ts`) unconditionally overwrites
`TASK_STATE.json` with an empty state -- including a task that just reached `COMPLETED`.
Nothing preserves the outgoing task's structured record anywhere; the only surviving trace is
scattered prose in `BUILD_LOG.md`, not machine-queryable. `plan --replace`
(`src/lib/plan.ts`) has the identical loss when it overwrites an existing terminal/`PLANNED`
task with a new one. This is exactly the class of problem this project already recognized and
solved once before -- `EXECUTION_LOG.json` exists precisely so "task state stays a
snapshot... rather than a log of every execution attempt against it" (`src/config.ts`). No
equivalent existed for the task lifecycle itself: a future planner (ChatGPT), or a human
auditing "what has this control plane actually completed," had no structured way to ask that
question -- only whichever `BUILD_LOG.md` prose happened to get written along the way.

**Options considered:**
1. Leave it as-is -- `BUILD_LOG.md` prose is the only historical record; anyone who needs
   structured data greps or parses markdown.
2. Change `reset`/`plan --replace` to refuse when the outgoing task hasn't been "exported"
   somewhere first, forcing a human to explicitly save it.
3. Add an append-only `.cookvideo/TASK_HISTORY.json`, mirroring `EXECUTION_LOG.json`'s
   existing pattern exactly, and have `reset` and `plan --replace` archive the outgoing task
   into it automatically, with no new required step for the human.

**Decision:** Option 3. Added `src/lib/taskHistory.ts` (`TaskHistoryEntry`,
`appendTaskHistoryEntry`, `readTaskHistoryEntries`) and `.cookvideo/TASK_HISTORY.json`
(shipped in its initial `[]` form, `TASK_HISTORY_PATH` in `src/config.ts`, added to
`STATE_FILES`). `runReset` archives the current task (if `taskId !== null`) before clearing
it; `runPlan`'s `--replace` path archives the outgoing task before overwriting it. Added a
new read-only `cookvideo-agent history` command to make the archive actually usable/checkable
rather than only ever read by a future automated consumer.

**Why:**
- Option 1 leaves the actual gap in place -- prose isn't queryable, and this control plane's
  own stated premise is a shared, *verifiable* view of ground truth, not something inferred
  from reading changelog-style text.
- Option 2 (refuse until exported) would add friction to `reset`/`plan --replace` for no real
  safety benefit here -- unlike commit/push/deploy, archiving carries no risk that needs a
  human's explicit go-ahead; doing it automatically, silently, and losslessly is strictly
  better than making it another manual step someone can forget.
- Mirroring `EXECUTION_LOG.json`'s exact read/append shape (missing/corrupt file -> `[]`,
  never throws, never blocks the caller) reuses an already-proven pattern rather than
  inventing a second one.
- `reset`'s and `plan --replace`'s own existing behavior toward `TASK_STATE.json`/
  `ACTIVE_TASK.md`/`BUILD_LOG.md` is completely unchanged -- this milestone only adds a
  preservation step immediately before each command's existing overwrite.

**Known limitations:**
- No pruning, rotation, or size limit on `TASK_HISTORY.json` -- acceptable at this control
  plane's current, human-driven task volume; would need revisiting if that changes.
- `history` has no filter, search, or pagination flags -- it prints everything. Fine at
  current volume; a reasonable fast-follow once the log is large enough to matter.
- This does not address the other named-and-deferred gap: `.cookvideo/APPROVAL_POLICY.md`
  still describes performing the actual `COMMITTING`/`DEPLOYING` action (real `git
  commit`/`git push` against CookVideo) as "future work, not yet built" -- deliberately not
  folded into this milestone; see the Milestone 11 proposal discussion for why that's a
  separate, materially higher-risk decision.
