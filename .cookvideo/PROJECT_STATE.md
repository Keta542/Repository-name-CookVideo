# CookVideo — Project State

Living snapshot of the CookVideo project as known by the control plane. This file is meant
to be kept current by whoever (human, Claude, or a future automated step) last verified the
facts below — every section either states a verified fact with its verification date, or is
explicitly marked unknown rather than guessed.

Do not treat this file as more current than its "Last verified" dates. For anything
operational (deployment status, latest applied migration, pipeline health), prefer running
`cookvideo-agent inspect` or checking the CookVideo repository's own DECISIONS.md /
MANIFEST.txt directly over trusting a stale note here.

## Stable facts (structural, unlikely to change)

- **Repository location:** `C:\Users\aesfm\CookVideo`
- **Stack:** Next.js (App Router) + Supabase (Postgres, RLS, Auth) + Mux (video)
- **Monorepo layout:** Next.js application under `apps/web`; database migrations and SQL
  tests under `supabase/`
- **Product:** CookVideo — a social cooking app that converts uploaded cooking videos into
  structured, reviewable draft recipes

*(Captured at CookVideoAgent scaffold creation. Re-verify before relying on this list if
much time has passed.)*

## Current milestone / phase

Unknown to this file — check the CookVideo repository's own `DECISIONS.md` for the latest
recorded architectural decision, and `ACTIVE_TASK.md` in this directory for what's actively
being worked on right now.

## Deployment status

Unknown to this file. Verify directly:
- Production DB migration state: run `supabase migration list` (or check with whoever has
  Supabase CLI access) against the linked project.
- Production deploy state: check the Vercel dashboard for the project, or `vercel ls`.

## Open questions / known gaps

- (none recorded yet — add here as they're identified)
