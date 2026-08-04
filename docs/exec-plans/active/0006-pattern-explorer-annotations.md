# Pattern Explorer: operator review and local annotations

Status: implemented, hostile-reviewed, and validated; awaiting publish approval
Base: `fdbb12b` (`product-workbench`)
Owner: GPT-5/Codex integration lead
Review model: Fable 5, read-only

## Outcome

Turn repeated workflow patterns from a card summary into an inspectable,
filterable, operator-correctable product. The operator must be able to examine
the evidence and descriptive outcome coverage behind one pattern, then record
whether it is a genuine preference, context-dependent guidance, or noise.

The resulting annotation layer is operator-authored product state. It never
rewrites canonical conversations, derived artifacts, workflow events, pattern
claims, or harness configuration.

## Frozen product contract

1. Every emitted pattern receives a stable public handle derived from its
   kind, signal, and role. The handle reveals no project path, event ID,
   episode ID, statement hash, or conversation hash.
2. The Explorer supports client-side filtering by text, event kind, signal,
   role, harness, outcome coverage, review disposition, and observed date
   range. Filtering operates only over the bounded pattern projection already
   authorized for Workbench.
3. A pattern detail surface shows its claim, coverage, relation counts,
   bounded timeline, descriptive outcome metrics, methodology boundary, and
   canonical evidence links. It does not claim causal effectiveness.
4. An annotation has one disposition:
   `unreviewed`, `confirmed`, `contextual`, or `dismissed`.
5. An annotation may also contain an operator display label and a bounded
   context note. A label changes presentation only; it does not rename the
   derived pattern or alter its identity.
6. “Contextual” means the pattern is real but not globally applicable.
   Project/harness-scoped policy and pattern merging remain deferred until
   their privacy and identity semantics are explicit.
7. Annotation history is append-only and content-addressed. A current manifest
   points at the latest record per stable pattern handle. Each record names its
   predecessor, revision, creation time, exact pattern artifact observed by
   the operator, and bounded annotation fields.
8. Annotation writes use optimistic concurrency. The client supplies the
   currently observed per-pattern revision, where zero means never annotated,
   plus the public snapshot token for the exact Workflow Patterns artifact it
   reviewed. A stale revision or snapshot fails with HTTP 409 rather than
   silently overwriting another review. The conflict response returns the
   current bounded annotation and current public snapshot so the UI can ask
   the operator to review again.
9. A missing manifest and an absent or empty objects directory is the explicit
   empty genesis state. Before the first object write, the writer durably
   creates an empty authoritative manifest. A missing manifest alongside
   objects, or a modified manifest, record, hash link, filename, or pattern
   identity, fails closed.
10. Annotations survive corpus re-derivation because identity is the stable
    kind/signal/role tuple rather than an event or artifact ID. An annotation
    whose pattern no longer reaches the evidence floor remains retained but is
    reported only as an aggregate inactive-pattern count. Disposition totals
    cover only annotations whose patterns are currently emitted.
11. Annotation objects, manifests, temporary files, and directories are
    private (`0600`/`0700`) and live below the operator data root. No
    annotation content is logged or sent to a hosted service.
12. The current manifest is the sole authority when a crash leaves an object
    unreachable. Unreachable objects never become current implicitly. Loss of
    the manifest while objects remain is deliberately unrecoverable by
    inference because concurrent branches have no authoritative tie-break;
    the operator restores the private manifest from backup. An explicit
    verify/quarantine recovery command may be added later.

## HTTP mutation boundary

Workbench remains read-only by default. Annotation mutation requires the
explicit `CHATLOG_ALLOW_ANNOTATIONS=1` deployment setting; the Home Manager
module exposes an opt-in boolean that defaults to false.

Allowed browser origins are also server-side configuration. Loopback origins
for the configured port are built in; reverse-proxy deployments must declare
each exact external origin with `CHATLOG_ANNOTATION_ORIGINS`. The canonical
Home Manager deployment opts into
`https://chatlog.home.phibkro.org` explicitly.

The only mutating route is:

```text
POST /api/pattern-annotations
```

It accepts a small JSON object containing a public pattern handle, expected
revision, client-observed public artifact snapshot, disposition, optional
label, and optional note.

The handler:

- rejects writes when annotation support is disabled;
- requires `application/json`;
- reads the body through an explicit byte bound rather than trusting
  `Content-Length`;
- requires an exact browser `Origin` from the server-side allowlist and
  requires `Sec-Fetch-Site: same-origin` to be present;
- never derives authority from `Host` or trusts `X-Forwarded-*` headers;
- reserves from one bounded in-memory global attempt rate before parsing or
  awaiting storage, so failures and concurrent bursts cannot bypass it;
- validates the handle against the currently active, integrity-checked
  Workflow Patterns artifact;
- returns only the bounded public annotation projection.

This is deliberately a browser-only mutation surface; local scripts do not
bypass the origin/fetch-metadata requirements. These controls make the
annotation write route resistant to CSRF, DNS rebinding, and abuse; they are
not user authentication and do not gate the existing read APIs. The canonical
deployment remains loopback-bound behind the private LAN/tailnet entry plane.
Combining annotation writes with a non-loopback bind requires an additional
explicit remote-write acknowledgement and remains unsupported by the Home
Manager module. Public-Internet exposure still requires application identity,
authorization, session security, and a separate threat model.

## Storage contract

```text
annotations/
  workflow-patterns-manifest.json
  workflow-patterns-lock.sqlite
  objects/
    ab/
      <sha256>.json
```

The small private SQLite file is coordination only: `BEGIN IMMEDIATE`
serializes writers across processes and the operating system releases its lock
when a writer exits. It contains no annotation content and is never authority;
the sealed manifest remains the sole current-state authority.

The manifest contains:

- schema and monotonically increasing global revision;
- update timestamp;
- a sorted handle-to-current-content-hash map;
- an integrity hash over the complete manifest body.

Each object contains:

- schema and its content hash;
- stable handle and structured pattern identity;
- prior record hash or null;
- per-pattern revision;
- exact Workflow Patterns artifact content hash whose public snapshot the
  client supplied and the server matched on write;
- canonical creation timestamp;
- disposition, optional display label, and optional context note.

The content hash covers every field except itself. Writes durably create the
new object before atomically replacing the manifest.

## Workbench projection

`/api/insights.workflowPatterns` adds:

- whether annotations are enabled;
- the current public artifact snapshot;
- counts by active review disposition plus inactive-pattern current records;
- a stable public handle and current bounded annotation, including its
  per-pattern revision, on each pattern.

The Explorer never exposes annotation object hashes, predecessor hashes,
artifact content hashes, global manifest revisions, filenames, or paths.
Per-pattern annotation revision and the opaque public artifact snapshot are
part of the bounded concurrency contract. Notes and labels are escaped as
untrusted text in the browser.

## Validation

Tests must prove:

- stable handles are deterministic and independent of internal pattern IDs;
- write/read/restart round trips retain the current record and full immutable
  history;
- stale expected revisions return a conflict and do not advance state;
- a stale client-observed artifact snapshot returns a conflict;
- concurrent writes serialize;
- first-write genesis and a simulated crash between object and manifest leave
  an authoritative, readable prior state;
- tampered manifests, records, filenames, and predecessor links fail closed;
- writes for nonexistent or below-floor pattern handles are rejected;
- disabled mutation, wrong content type, oversized bodies, missing/mismatched
  origins, cross-site fetch metadata, and unsupported methods are rejected;
- labels and notes are length/control-character bounded and remain escaped in
  the UI;
- Workbench system-derived projection contains no internal lineage, storage
  hash, project path, or annotation filesystem path; operator-authored notes
  are not treated as system-derived privacy assertions;
- all existing read-only evidence and source-authority checks continue to
  pass.

## Non-goals

- editing source conversations or derived workflow claims;
- applying annotations to agent harness configuration;
- semantic merging of separate pattern identities;
- project-specific or harness-specific policy scopes;
- causal claims or automated workflow prescriptions;
- public-Internet authentication or multi-user authorization;
- annotation synchronization between Chatlog installations.

## Results

The implementation adds the filterable Pattern Explorer, bounded evidence and
methodology detail, and opt-in private operator reviews without widening
canonical corpus or derived-artifact authority. Annotation history is
append-only and content-addressed; the current sealed manifest is authoritative
and public clients receive only stable handles, bounded annotations,
per-pattern revisions, and opaque artifact snapshots.

The hostile implementation review found a stale PID-lock takeover race, an
overbroad DNS-rebinding claim, a bypassable successful-write-only rate bound,
text-spoofing gaps, a fragile conflict refresh, and late origin validation.
The closure replaces the PID file with a private SQLite coordination lock,
narrows the security claim to the mutation route, reserves rate capacity before
awaiting work, rejects C1/bidi/line-separator controls and multiline labels,
contains conflict-refresh failures, and validates configured origins during
Home Manager evaluation.

Validation at the reviewed source state:

- `bun run check`: 77 tests, 512 assertions, and all CLI, MCP, Workbench server,
  and browser bundles pass;
- `nix flake check --offline`: package and Home Manager module checks pass;
- visual browser automation was attempted but the locally downloaded browser
  could not start because its execution environment lacked
  `libglib-2.0.so.0`; no production data was mutated to simulate a write.
