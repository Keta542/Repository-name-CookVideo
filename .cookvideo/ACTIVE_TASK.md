# CookVideo Agent — Active Task

This file is the human-readable view of the current task. The machine-readable
equivalent is `.cookvideo/TASK_STATE.json`; both should always agree. See
`APPROVAL_POLICY.md` for what does and doesn't require approval, and `README.md`
for the full lifecycle diagram.

**Status: active task recorded via `cookvideo-agent plan`.**

| Field | Value |
|---|---|
| Task ID | MILESTONE-6-SEARCH-EMPTY-STATE-001 |
| Objective | Update the CookVideo search page empty-state copy so it encourages the user to browse recipes instead of only suggesting a narrower search. |
| Scope | UI copy only, within the search results empty-state block. No changes to data fetching, search logic, navigation logic, authentication, or any other screen. |
| Phase | COMPLETED |
| Risk level | LOW |
| Approval status | NOT_REQUIRED |

**Requested changes:**

- Update the 'No recipes found' empty-state copy in apps/web/src/app/search/page.tsx.
- Keep the existing empty-state structure and styling unchanged.
- Use concise copy that suggests browsing all recipes as an alternative to changing the search.

**Files expected to change:**

- apps/web/src/app/search/page.tsx

**Tests required:**

_(none)_

**Approval requirements (anticipated for later phases -- not yet requested):**

_(none)_

Created at: 2026-09-12T07:14:42.253Z · Updated at: 2026-09-12T20:40:40.374Z

Nothing about this record executes anything: `plan` never edits CookVideo, invokes Claude,
runs `git commit`/`git push`, or touches Supabase/Vercel/Mux/GitHub.
