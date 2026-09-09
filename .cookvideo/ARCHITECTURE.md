# CookVideo Agent — Architecture

This document describes the control plane itself (CookVideoAgent), not the CookVideo
application. See the CookVideo repository's own docs for the application's architecture.

## Roles

- **ChatGPT** — planner / orchestrator. Decides what should happen next at a product and
  task level.
- **Claude (Claude Code)** — autonomous implementation engineer. Reads a task, makes the
  actual code/infrastructure changes in the CookVideo repository, runs checks, reports back.
- **CookVideo Agent** (this project) — the control plane. A local CLI that gives both of the
  above a shared, verifiable view of ground truth: what state the CookVideo repository is
  actually in, right now, rather than what anyone remembers or assumes it to be.
- **Git** — source of truth / transaction history for the CookVideo repository. Branch,
  commit, and working-tree-clean/dirty state are read directly from git, never inferred.
- **Tools** — what the control plane (and eventually the agents it coordinates) can act
  through: today, the filesystem and Git, read-only. Test execution is planned next. Later,
  authenticated integrations with Supabase, Vercel, Mux, and GitHub, each added deliberately
  and only when a concrete task needs it — not speculatively.

## Two separate repositories

- `C:\Users\aesfm\CookVideo` — the CookVideo application. Owned by its own engineering
  process; this control plane only ever reads it.
- `C:\Users\aesfm\CookVideoAgent` — this project. Owned independently, with its own git
  history, dependencies, and lifecycle.

CookVideoAgent must never write into, commit to, or push the CookVideo repository. Every
command in this milestone is read-only with respect to CookVideo.

## Control-plane state (`.cookvideo/`)

Five living documents, meant to be read and updated over time as the coordination process
actually runs:

- `PROJECT_STATE.md` — current known facts about the CookVideo project (dated, with unknowns
  marked explicitly rather than guessed)
- `ARCHITECTURE.md` — this file
- `DECISIONS.md` — decisions made about the control plane itself (not CookVideo's own
  decisions, which live in CookVideo's own `DECISIONS.md`)
- `ACTIVE_TASK.md` — what's currently being worked on through this control plane
- `BUILD_LOG.md` — chronological record of what was built/changed in CookVideoAgent itself

## Current milestone

Milestone 1 (this one): a local, read-only inspection scaffold — `cookvideo-agent inspect`
and `cookvideo-agent status`. No write access to CookVideo, no credentials, no external
service integrations. Everything beyond this is future scope, not yet designed here.
