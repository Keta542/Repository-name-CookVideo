# Milestone 14 (proposed, not yet built) — CI enforcement of `npm run verify`

Status: **proposal only**. Nothing described below has been implemented. This document exists
so the design can be reviewed and the open decisions at the bottom can be answered explicitly
before any code is written — the same way Milestones 12 and 13's fork points were decided up
front rather than assumed. Once approved, the "Decision" this document turns into belongs in
`.cookvideo/DECISIONS.md`, alongside Milestones 1–13.

## Problem

`.cookvideo/ARCHITECTURE.md`'s "Verification claims" rule (added in Milestone 9) states that a
`BUILD_LOG.md` entry may only report `npm run verify` results against a **clean, pushed**
`git status` — never an uncommitted working tree. That rule exists because it was violated for
real: Milestones 6–8's "Verified: npm run typecheck (clean)... npm test (all passing)" claims
were true only of a local working tree, while the actually-pushed `master` HEAD did not compile
(`.cookvideo/DECISIONS.md`, Milestone 9).

Milestone 9 fixed the immediate break and added the rule, but its own "Known limitations"
section named the gap left open, explicitly:

> The `npm run verify` rule is enforced by discipline, not tooling — nothing currently blocks a
> commit or push if `git status` is dirty or `verify` was never actually run. A git hook or CI
> check would close that; deliberately deferred as a bigger category of tooling change than
> this milestone's scope.

Five milestones later, that gap is still open — nothing in this repository has ever
automatically checked that a pushed commit actually typechecks, lints, and passes its own test
suite. This milestone closes exactly that gap, for CookVideoAgent's own repository only —
nothing about CookVideo's application, its test suite, or `cookvideo-agent test`/`commit`/
`push` changes here.

## Options considered

1. **A local git hook** (e.g. a `pre-push` hook under a committed `.githooks/` directory with
   `core.hooksPath` configured, or via a tool like `husky`) that runs `npm run verify` before a
   `git push` is allowed to leave the machine.
2. **A GitHub Actions workflow** that runs `npm ci && npm run verify` on every push and every
   pull request, surfaced on GitHub as a check.
3. **Both** — a local hook for fast feedback, plus CI as the actual backstop.

**Recommendation: option 2 alone.** A local hook (options 1 and 3) can always be bypassed with
`git push --no-verify`, and — more importantly — is not installed automatically for anyone who
freshly clones the repository; it would need a setup step (`git config core.hooksPath
.githooks`) that's easy to forget, which is exactly the "enforced by discipline" failure mode
this milestone exists to remove. A GitHub Actions workflow runs on GitHub's own infrastructure
regardless of what's configured locally, requires no per-clone setup, and is the one mechanism
that can actually be made a required check on `master` (see Open decision 2 below) — closing
the gap for real rather than moving it one layer down.

This repository already has a GitHub remote (`origin` →
`github.com/Keta542/Repository-name-CookVideo`), so Actions is available with no new
infrastructure decision.

## Proposed design

- **New `.github/workflows/verify.yml`.** A single job:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4`, pinned to Node 20 (matching `package.json`'s
     `"engines": { "node": ">=20" }`), with `cache: npm`
  3. `npm ci` (never `npm install`, so a `package-lock.json` drift fails loudly instead of
     silently resolving to something different than what's actually committed)
  4. `npm run verify` (already runs `typecheck` → `lint` → `test`, unchanged — this milestone
     adds no new npm script, it just runs the existing one somewhere that can't be skipped)
- **No secrets, no credentials, no runtime dependencies.** `npm run verify` never touches
  CookVideo, git write operations, or any external system — it is pure `tsc --noEmit` / `eslint`
  / `node --test` against this repository's own source, exactly as it already runs locally. The
  workflow needs no `secrets:` block of any kind.
- **Docs to update once this is approved and built:**
  - `.cookvideo/ARCHITECTURE.md` — extend the existing "Verification claims" section to state
    that this is now also checked by CI on every push/PR, not enforced by discipline alone.
  - `README.md` — a short mention next to wherever `npm run verify` is already documented.
  - `.cookvideo/DECISIONS.md` — this proposal, promoted to a dated decision entry once built.
  - `.cookvideo/BUILD_LOG.md` — the usual dated entry.
  - No new `.cookvideo/*_POLICY.md` file — unlike Milestones 12/13, this isn't a new category of
    real-world action against CookVideo or an approval-gated capability; it's CI for
    CookVideoAgent's own repository, which `APPROVAL_POLICY.md`'s existing categories don't need
    to be extended to cover.

## Out of scope for this milestone

- No change to `cookvideo-agent execute`/`commit`/`push`/`test`, or to any of their env-var
  double gates.
- No change to what CI checks — it runs the exact same `npm run verify` a human already runs
  locally, nothing broader (no new lint rules, no coverage thresholds, no additional checks).
- No workflow that touches the real CookVideo repository, Supabase, Vercel, Mux, or GitHub
  beyond checking out CookVideoAgent's own source. The workflow has no path to CookVideo at all.
- No local git hook (see recommendation above) — deliberately not adding a second enforcement
  mechanism in the same milestone.

## Open decisions that need an explicit answer before implementation

1. **Trigger scope.** Run on push to `master` only, or on push to `master` **and** every pull
   request targeting `master`? Recommend both — commit history so far shows direct pushes to
   `master` with no PR workflow in use yet, so a `push`-only trigger would in practice be the
   only one that ever fires today, but adding the `pull_request` trigger costs nothing and covers
   a future workflow change for free.
2. **Making it a required check.** Adding the workflow file makes CI *run* and report a
   pass/fail on GitHub, but it does not by itself *block* anything — turning it into an actual
   required status check (so a failing run blocks a merge, or blocks pushing to a protected
   branch) is a GitHub repository **branch protection** setting, not a code change, and changes
   what's allowed to reach `master` for anyone with push access. Per this project's own git
   safety principles (confirm before actions that affect shared/remote state or policy), I
   won't enable branch protection without your explicit go-ahead. Do you want me to also
   configure branch protection on `master` (via `gh api`) once the workflow is added and has run
   green at least once, or leave the workflow as report-only and decide on enforcement later?
3. **Node version pinned in the workflow.** `package.json` only declares `>=20`. Recommend
   pinning CI to a single concrete version (e.g. `20.x`, the current Node 20 LTS line) rather
   than a matrix of multiple versions — this is a solo-maintained local tool, not a published
   package other people install on arbitrary Node versions, so multi-version testing would be
   speculative coverage for a scenario that doesn't exist yet (consistent with this project's
   own "don't build for hypothetical future requirements" pattern elsewhere).

## Known limitations (anticipated, same spirit as Milestones 12–13's lists)

- CI can only see what's actually pushed to GitHub — it says nothing about, and cannot prevent,
  a bad state existing briefly in someone's local working tree or an un-pushed local branch. It
  closes the specific failure mode Milestone 9 hit (a broken `master` HEAD going unnoticed),
  not every possible way `verify` could be skipped.
- Without branch protection (Open decision 2), a failing CI run is *visible* on GitHub but does
  not *prevent* a further push to `master` — the gap narrows from "no tooling at all" to
  "tooling reports the problem but doesn't block it" unless branch protection is also enabled.
- This does not retroactively re-verify or annotate any historical `BUILD_LOG.md` entry —
  exactly like Milestone 9's own equivalent limitation, left as historical record rather than
  rewritten.
- This only ever runs CookVideoAgent's own `npm run verify`. It has no opinion on, and does not
  invoke, `cookvideo-agent test` (which runs CookVideo's real test suite) — those remain
  entirely separate concerns, exactly as `TEST_POLICY.md` already states.
