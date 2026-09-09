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
