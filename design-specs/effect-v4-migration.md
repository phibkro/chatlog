# Design-spec: Effect v4 migration

Status: **FROZEN on open of its PR** (operator authorized 2026-07-27: whole
repo, Effect accepted as a trusted dependency). Revise this file explicitly if
a build learning forces it; never drift silently.

Author lane: chatlog. Bound worker: one engineer, one worktree, this spec only.

---

## The one felt outcome

`bun run check` passes on a chatlog whose fallible operations return **typed
errors** instead of throwing, and the no-throw ratchet baseline drops from 112
toward zero. Nothing about the CLI's observable behaviour changes: the same
commands produce the same corpus, the same derived hashes, and the same
candidate counts.

## Why

Control flow by exception is invisible to callers and to the type checker. On
2026-07-23 Codex added a `tool_search_call` response item; `src/adapters/codex.ts`
threw on the unknown type, and because the throw was unrecoverable rather than a
value the caller had to handle, ingestion stopped dead. Nobody learned until
2026-07-27 — five days, 0 candidates, no signal. A typed error channel makes
that class structural: the caller cannot ignore what it must destructure.

## Goal / Constraints / Values

**Goal.** Every fallible operation outside the process boundary returns its
failure as a value.

**Constraints (hard — violating any of these fails the PR):**

1. **Behaviour is unchanged.** Same corpus objects, same content hashes, same
   derived manifest, same refinery candidate count for an unchanged input. This
   is verifiable and MUST be verified — see falsifiers.
2. **Redaction is never weakened.** `src/redact.ts` runs on every path it runs
   on today. A migration that drops a redact call is a security regression, not
   a refactor.
3. **The local-only, no-network contract holds.** Ingest opens source
   directories for discovery, stat and streaming reads only, and never writes
   beneath `~/.claude`, `~/.codex`, `~/.pi`. No hosted calls are added.
4. **`effect` is the only DIRECT dependency, and the bundle must stay clean.**

   The first version of this constraint said "no transitive-dependency sprawl",
   which reads as though `effect` were near-zero-dep. It is not: measured at
   `4.0.0-beta.98`, it pulls **21 packages**, including `msgpackr-extract` with
   six platform-specific native binaries and a prebuild-download bin script,
   plus `fast-check`, `kubernetes-types`, `find-my-way-ts`, `toml`, `yaml` and
   `ini` — backing `unstable/http` and `unstable/cluster`, none of which this
   repo imports.

   That is inherent to the pinned beta, not something a migration adds. What
   matters, and what this constraint now requires, is that none of it reaches
   the artifact:

   - `bun build ./src/cli.ts` must contain zero occurrences of `msgpackr`,
     `fast-check`, `kubernetes-types`, `find-my-way`, `toml`, `yaml`.
   - No package may be added to `trustedDependencies`. Bun does not run
     lifecycle scripts for untrusted packages, which is what keeps
     `download-msgpackr-prebuilds` from ever executing. Adding an entry there
     would let a postinstall script run inside the tool that reads the
     operator's entire agent history — a security decision, not a build fix.

   Verified true at slice 1: build-time tree grew, runtime surface did not.
5. **Pin the beta explicitly.** Effect v4 is a beta channel with breaking
   changes between releases. Pin an exact version in `package.json` — never a
   range, never `@beta` floating.

## Reference material — READ BEFORE WRITING CODE

A shallow clone of the v4 source lives at
`/srv/share/projects/.reference/effect-smol` (rev `3a1128c`, version
`4.0.0-beta.98`). Effect v4 postdates most model training data, so patterns
recalled from memory will be v3. Work from these files, not from recall:

| Path | Use for |
|---|---|
| `.patterns/effect.md` | **The house style, and the anti-pattern list.** Explicit ❌/✅ pairs: never try-catch inside `Effect.gen`; always `return yield*` for terminal effects. |
| `migration/error-handling.md` | The `catch*` renamings — `catchAll`→`catch`, `catchSome`→`catchFilter`, `catchSomeDefect` removed. |
| `migration/*.md` | 11 topic guides: cause, generators, layer-memoization, runtime, schema, fiberref, forking. |
| `MIGRATION.md` | The v3→v4 overview. |
| `AGENTS.md` | Upstream's own instructions for agents in this codebase. |
| `packages/effect/src/` | Ground truth when a doc is ambiguous. |

Pin the exact version this reference was taken at. If a pattern here disagrees
with anything in this spec, the reference wins on *mechanism* and this spec
wins on *scope* — say so rather than silently choosing.

**Values (soft):**

- Prefer upstream migration tooling over hand-porting. Check `MIGRATION.md` and
  any published codemods FIRST; a mechanical transform beats 100 hand edits.
- Keep the pure core pure. Derivation and refinery are pure functions of
  corpus + recipe hash; if Effect does not make a given pure function safer,
  leave it alone. Wrapping pure code in `Effect` for uniformity is churn.
- The process boundary (`src/cli.ts`, `src/mcp/server.ts`,
  `src/workbench/server.ts`) is where an error legitimately becomes a non-zero
  exit or a 500. Errors surface there; they do not propagate as exceptions
  through the layers beneath.

## Scope

**In:** adapters, ingest, derive, refinery, lock, importers, query paths.
**At the boundary (convert, do not remove):** cli, mcp server, workbench server.
**Out:** the workbench browser bundle; test files.

**Start with `src/adapters/`.** It is the smallest coherent slice, it is where
the motivating bug lives, and it proves the v4 beta on a bounded diff before
the rest of the codebase depends on it.

## Falsifiers / DoD

The PR is conformant iff all of these hold. Each is a command, not a claim.

1. `bun run check` passes (oxlint 0 errors, ratchet not raised, 28+ tests, all
   builds).
2. **Behavioural identity, measured not asserted — against a FROZEN corpus.**

   The obvious form of this falsifier ("record the hashes, migrate, re-run,
   compare") is **unsound and was wrong in the first version of this spec**.
   The corpus is derived from `~/.claude`, `~/.codex` and `~/.pi`, which grow
   on every turn of the very session doing the migration. A second `ingest`
   therefore sees different input regardless of any code change, so a differing
   hash proves nothing and a matching one is luck. Slice 1 caught this in
   practice; the recorded baseline was invalidated by an unrelated ingest run
   before the comparison could be made.

   The sound form, established by slice 1 and mandatory from here:

   1. Freeze a snapshot of the source directories to a scratch path.
   2. Run ingest/derive/refine against that frozen input with the PRE-migration
      code, into scratch root A.
   3. Run the same against the SAME frozen input with the migrated code, into
      scratch root B.
   4. `diff -rq A B` reports zero differences, and `derived/manifest.json` plus
      the refinery `contentHash` match. Do it both from-fresh AND incrementally
      (second run into an already-populated root), because the incremental path
      has its own manifest logic that a from-fresh run never exercises.

   Note that `corpus/`, `derived/` and `analysis/` are gitignored working data.
   Their state on the real repo is irrelevant to the commit; only the A/B on
   frozen input carries proof.
3. The no-throw ratchet baseline is **lower** than 112, and
   `scripts/no-throw-baseline.txt` records the new number.
4. `grep -rn "redact(" src/` shows no call site removed relative to `main`.
5. `package.json` pins one exact Effect version; `bun.lock` shows no unexpected
   additional runtime dependency.
6. The Codex adapter's unknown-item path returns a typed error carrying
   `{ itemType, path, line }` rather than throwing — the specific defect this
   migration exists to make unrepresentable.

## Explicitly deferred

Preserve-and-flag for unknown items (opaque turn retention + a schema
nomination queue) is a **separate spec**. It is the durable fix for the
five-day stall, but it changes corpus contents and would violate falsifier 2
here. Typed errors are the prerequisite; do that first, then this.

## Slice record

**Slice 1 — `src/adapters/` — LANDED 2026-07-27** (`56a40dc`, `b3f466e`).

Zero `throw` remains in `src/adapters/`; ratchet 112 → 102. Behavioural
identity proven by the frozen-snapshot A/B above (2263 + 383 + 31 source
files), fresh and incremental, `diff -rq` clean. `redact()` call sites 11 → 11.

Findings worth carrying into later slices:

- `readJsonLines` (`src/jsonl.ts`) takes a **synchronous, non-Effect-aware
  visitor callback**, so each adapter runs its per-record Effect to an `Exit`
  and captures the first failure in a closure rather than `yield*`-ing through.
  That seam is deliberate and commented. Migrating `jsonl.ts` would remove it —
  decide that explicitly rather than letting the pattern spread by imitation.
- `Effect.promise` treats a rejecting promise as a **defect, not a typed
  failure**, and `Effect.runPromise` rejects with the raw error (via
  `causeSquash`), not a wrapper. That is what let the Promise-boundary shim stay
  exactly behaviour-preserving for the untouched `ingest.ts` contract.
- `Data.TaggedError`, `Effect.fnUntraced` with `Effect.fn.Return<A, E, R>` for
  recursion, and `Effect.runSyncExit` + `Exit.isFailure` + `Cause.squash` for
  crossing a foreign synchronous boundary all matched the pinned reference
  exactly. Trust `/srv/share/projects/.reference/effect-smol` over recall.

**Next: slice 2.** Pick the next slice deliberately; `src/jsonl.ts` is the
natural candidate precisely because it is the seam slice 1 had to work around.
