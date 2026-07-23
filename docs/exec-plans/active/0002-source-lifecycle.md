# Source lifecycle: preview before authority-changing operations

Status: active
Base: `0e261f5` (`product-workbench`)
Owner: GPT-5/Codex integration lead
Review model: Sonnet 5, read-only

## Outcome

Let the operator understand exactly what an export would add before Chatlog
writes corpus, index, or derived state. Freeze the storage and revocation
contracts required for later domain reclassification and source deletion
without prematurely exposing mutations through the unauthenticated Workbench.

Wave 2 is deliberately split:

1. **Preview** — read the source and return an aggregate, content-addressed,
   non-persistent receipt. This slice is implemented first.
2. **Receipts** — persist bounded operational records after successful imports.
3. **Reclassify and revoke** — replace the active object for a source path, or
   remove its active mapping.
4. **Purge** — idempotently reclaim unreachable canonical, indexed, and derived
   material.

“Delete” is not exposed until revoke and purge semantics are both implemented
and tested. A misleading partial-delete button is worse than a CLI-only
operation.

## Frozen invariants

1. Canonical `corpus/objects/<hash>.json` files are immutable.
2. Domain is part of the canonical object and therefore part of its hash.
   Reclassification creates a new object; it never updates an object or index
   row in place.
3. A source path has at most one active content hash. Physical objects and
   historical index rows are not evidence of reachability.
4. Workbench and MCP evidence resolution require the hash to be active before
   reading the object.
5. All authority-changing operations serialize through `withIngestLock`.
6. A hash shared by multiple active source paths remains reachable until the
   last mapping is revoked.
7. Workbench remains read-only. Preview, reclassify, revoke, and purge are
   trusted-operator CLI operations until the product has explicit mutation
   authentication and CSRF protection.
8. Revocation means “no current product surface can retrieve it.” Purge means
   physical removal from canonical objects, SQLite, per-conversation derived
   artifacts, and aggregate artifacts that may contain excerpts. These are
   separate states and must be reported honestly.

## Slice A: non-destructive Anthropic preview

Command:

```sh
bun run preview:anthropic -- <export.zip|directory> [domain]
```

The preview:

- reads `conversations.json` locally using the same adapter, redaction, domain
  normalization, and canonical hashing path as import;
- returns aggregate counts only—no titles, snippets, messages, tool arguments,
  or attachment bodies;
- classifies canonical results as `new`, `changed`, or `unchanged` against the
  current corpus manifest;
- reports the selected domain, date range, excluded source categories, and
  `wouldImport`, and distinguishes transcript changes from domain-only
  `reclassified` proposals;
- derives a stable proposal ID from source content, domain, and proposed
  mappings, then derives a receipt ID from that proposal plus the manifest
  mappings/classifications observed during this preview;
- is explicitly advisory because a concurrent import may change the manifest
  after preview;
- creates no lock, corpus directory, manifest, database, derived artifact, or
  receipt file.

Workbench’s Sources page displays the preview command before the import
command. It does not automatically read an archive and adds no mutating HTTP
endpoint.

## Required storage migration before revoke or reclassify

The current `current_conversations` view selects the newest historical row per
`source_path`. Removing a key from `corpus/manifest.json` would therefore make
the old row current again. A manifest-only delete is not revocation.

Before mutation ships, SQLite gains an active projection:

```sql
CREATE TABLE active_sources (
  source_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE active_projection_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  manifest_sources_hash TEXT NOT NULL,
  reconciled_at TEXT NOT NULL
);
```

`current_conversations` must join `active_sources` on both `source_path` and
`content_hash`; it must no longer infer authority from row ordering.
`corpus/manifest.json` remains the durable authority and `active_sources` is a
rebuildable read projection.

Reconciliation hashes a canonical, source-path-sorted serialization of the
manifest’s `sources` map and records it in `active_projection_meta` in the same
SQLite transaction as the projection replacement. Before trusting an evidence
lookup, Workbench and MCP compute the current manifest-sources hash and compare
it with this projection receipt. Missing or unequal receipts fail closed. This
is the concrete drift detector; row counts or file mtimes are not authority.

Every writer begins by reconciling `active_sources` from the manifest. Mutation
uses a small durable intent record:

1. write new immutable objects and historical index rows;
2. write an operation intent containing the before/after source mapping;
3. atomically replace the corpus manifest—the authority linearization point;
4. transactionally reconcile `active_sources`;
5. regenerate or invalidate affected derived and aggregate artifacts;
6. write the bounded completion receipt and mark the intent complete.

After a crash, reconciliation trusts the manifest, resumes projection and
artifact cleanup, and is idempotent. A server that detects manifest/projection
drift must refuse evidence rather than serve stale authority.

## Reclassification, revocation, and purge contracts

Reclassification requires the original source to remain readable because the
domain is hashed into each canonical conversation:

```text
source reclassify <anthropic-export-path> <domain>
```

It re-adapts the archive, stages new objects, replaces only that export’s
active mappings, then reconciles and records a receipt.

Revocation changes reachability without claiming physical erasure:

```text
source revoke <anthropic-export-path> [--conversation <uuid> ...]
```

Purge is a resumable set-difference sweep:

```text
source purge [--dry-run]
```

Reachable hashes are the value set of the active manifest mappings. Purge
removes only hashes absent from that set from:

- `tool_calls`, `turns_fts`, `turns`, and `conversations`;
- `corpus/objects`;
- per-conversation derived objects and their manifest entries;
- stale aggregate artifacts or manifests that can contain excerpts.

The dry run reports bounded counts and bytes, never conversation content.
Repeating purge after success is a no-op; repeating it after interruption
converges to the same state.

## Tests required before mutation ships

- active projection migration preserves every current source mapping;
- removing a manifest key cannot resurrect an older historical row;
- Workbench and MCP reject inactive hashes even while their object files exist;
- reclassification is idempotent and changes the canonical hash/domain;
- shared-hash reachability survives revocation of only one source;
- whole-export and selected-conversation revocation leave siblings intact;
- purge is resumable, idempotent, and removes SQLite FTS plus derived excerpts;
- a failed manifest commit produces neither active-projection change nor
  completion receipt;
- concurrent import and lifecycle mutation reject the second writer;
- real source content is never provided to delegated workers or hosted models.

## Explicit non-goals

- automatic import merely because an archive is discovered;
- mutating Workbench endpoints;
- claiming deletion from backups, synchronized copies, provider exports, or
  prior hosted-reranking requests;
- per-turn deletion or reclassification;
- importing Claude Projects, memories, thinking blocks, or attachment bodies;
- adding ChatGPT/generic JSONL mutation support before those adapters exist.

## Slice A results

Completed on 2026-07-23.

- Synthetic preview tests prove deterministic proposal/receipt IDs,
  new/changed/reclassified/unchanged classification, idempotence, and zero
  corpus/database writes.
- Workbench evidence now rejects a genuinely superseded indexed object even
  while its canonical file remains present.
- Sonnet 5’s first implementation review produced four findings; all four were
  corrected, and its focused closure review reported no remaining actionable
  findings.
- `bun run check` passes 28 tests with 197 assertions and all runtime/browser
  bundles.
- `nix flake check --offline` builds the CLI, Workbench, MCP, and Home Manager
  evaluation. The packaged `chatlog` CLI successfully ran the same preview.
- The operator’s Anthropic archive was previewed locally under `personal`:
  694 importable conversations, 12,165 turns, 55 attachments, 467 file
  references, and zero invalid records. The preview reported aggregates only.
  The corpus manifest still contains zero mappings for that archive; no import
  was performed.

## Deployment boundary

The publication prerequisite is complete. Chatlog is available from
`https://github.com/phibkro/chatlog`, and Homelab consumes it through a pinned
flake input rather than vendoring it or using an absolute local path.

The workstation owns deployment policy only: it installs the package, enables
the loopback-only Home Manager service, places mutable state under
`~/.local/share/chatlog`, and fronts the service with Tailscale Serve. Chatlog
continues to own its package, service module, corpus semantics, and product
surfaces. CI now runs both `bun run check` and `nix flake check` on pushes and
pull requests.

Operationalization deliberately did not expand this plan's
authority-changing scope. With the installed service and MCP surfaces
smoke-tested, Slice B adds persistent bounded import receipts; the active
projection migration remains required before reclassification or revocation.

## Slice B results

Completed on 2026-07-24.

- Every successful explicit Anthropic import writes a private, hash-sealed
  `chatlog/import-receipt-v1` record beneath `receipts/imports/`.
- Receipts contain the source fingerprint, selected policy, aggregate counts,
  before/after manifest hashes, mapping-transition counts, and bounded
  derivation status. They contain no titles, messages, snippets, tool data,
  attachment bodies, artifact paths, or error text.
- A handled derivation failure still records the already-committed manifest
  transition with `derivation.status: failed`, then returns an operator-visible
  error. Crash recovery in the narrower manifest-to-receipt window remains
  intentionally assigned to the durable-intent migration.
- The operator can inspect a bounded newest-first trail through
  `chatlog receipts imports [limit]`, `/api/receipts?limit=…`, and the
  read-only Workbench Sources page. Receipt corruption fails the audit endpoint
  closed without taking down unrelated Workbench views.
- Fable 5's implementation and closure reviews produced seven actionable
  findings covering availability, durability, input bounds, timestamp ordering,
  and privacy coverage. All seven were corrected; the final narrow closure
  reported no actionable findings.
- `bun run check` passes 36 tests with 233 assertions and all runtime/browser
  bundles. `nix flake check --offline` and a packaged `chatlog receipts` smoke
  test both pass.
- The next authority-changing prerequisite is the active SQLite projection and
  manifest/projection drift detector described above. Reclassify, revoke, and
  purge remain unexposed.
