# Repository identity and mobile-first Workbench

Status: active

## Problem

Workbench currently treats the recorded working-directory path as project
identity. Temporary and linked Git worktrees therefore appear as independent
projects even when Git records one shared repository. The interface also starts
from a fixed desktop sidebar and multi-column grids, then collapses them at
narrow breakpoints. On a phone, primary navigation and dense evidence surfaces
feel like reduced desktop UI rather than a deliberate top-to-bottom journey.

## User journey

On a phone connected through Tailscale, the operator opens Workbench, moves
through a one-column sequence with touch-sized controls, and sees one project
for a Git repository rather than one card per worktree. On a wider desktop the
same document progressively expands into the persistent sidebar and useful
multi-column arrangements. Components respond to their own available width so
they remain usable when embedded in either layout.

## Contract

- When a recorded working directory exists inside Git, use the repository's
  common Git directory as identity. Present the main checkout root when it is
  structurally derivable from a standard `.git` directory; otherwise present
  the shared common Git directory itself rather than guessing a checkout.
- A normal checkout, its subdirectories, and linked worktrees that share that
  common Git directory resolve to one project.
- Resolution uses filesystem metadata, not a Git subprocess. Missing,
  inaccessible, malformed, deleted, and non-Git paths retain a normalized path
  fallback.
- A versioned identity recipe invalidates unchanged-source ingestion skips when
  the grouping rule changes; existing corpora are not silently left on the old
  rule.
- The base Workbench layout is a single, top-to-bottom mobile flow with no
  viewport-forced horizontal overflow at 360 CSS pixels and touch targets at
  least 44 CSS pixels where the user acts.
- Wider viewports progressively add the desktop sidebar and multi-column page
  layout. Component grids use container queries for relative layout decisions.
- Tablet widths receive a final refinement without becoming the source layout.
- Navigation remains keyboard accessible, exposes its open/closed state, closes
  after selection and Escape, and does not obscure the active page without a
  dismiss path.
- Existing read-only, local-data, provenance, evidence, and no-hosted-egress
  boundaries remain unchanged.

## Non-goals

- Guessing the repository for a deleted temporary worktree whose Git metadata
  no longer exists.
- Rewriting historical source logs or merging unrelated repositories by name.
- Adding an application login, public Cloudflare exposure, or a new frontend
  framework.
- Running a real-corpus re-ingest while the workstation resource gate is poor.

## Falsifiers / definition of done

1. Fixture tests prove one canonical path for a main checkout, nested path, and
   linked worktree sharing a common Git directory.
2. Fixture tests prove safe fallback for non-Git, missing, and malformed Git
   metadata.
3. An ingestion test proves an identity-recipe change reprocesses an otherwise
   unchanged source.
4. Frontend source starts from one-column layout, adds desktop layout through
   `min-width` enhancement, and contains component container queries.
5. At 360px, automated browser inspection finds no document-level horizontal
   overflow and the primary navigation can be opened, dismissed, and used.
6. At desktop width, the persistent sidebar and expanded grids remain present.
7. Typecheck, unit tests, browser bundle, no-throw ratchet, and diff checks pass.
8. Live-corpus re-ingest and on-phone confirmation are checkpointed separately
   behind a healthy RAM/swap/PSI/GPU/process inspection.
