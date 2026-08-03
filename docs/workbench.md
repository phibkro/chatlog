# Chatlog Workbench

Workbench is the human-facing surface over Chatlog's local, content-addressed
conversation corpus. It is designed for a technically curious operator who
wants useful recall and evidence without turning private session history into a
hosted telemetry product.

## What it surfaces

- **Today** — corpus health, recent work, active projects, and the latest
  evidence-backed orchestration finding.
- **Projects** — project-level activity with current-session totals, a bounded
  recent derived sample of outcomes/problems/decisions, model and tool mix, then
  individual sessions.
- **Recall** — local SQLite FTS5 search. Results carry
  `chatlog://conversation/<hash>/turn/<index>` pointers, and the evidence viewer
  resolves the canonical redacted turn on demand. Prior Attempts mode builds a
  chronological structural timeline through the existing zero-egress lexical
  query path.
- **Memory Lab** — a separate Foldkit application for proposal review. It
  presents blinded evidence and a model-authored memory proposal, then asks the
  operator only whether the proposal is correct, incorrect, or uncertain and
  whether the outcome is positive, negative, or neutral. Written correction or
  missing-context feedback is optional. Reviews never promote or inject memory.
- **Patterns** — inferred role boundaries, measured agent experiments, and
  knowledge-refinery candidates. A candidate is a prompt for review, never an
  automatic configuration change. The server returns an artifact only when its
  manifest-backed authority matches the current derived corpus projection.
- **Sources** — connected harnesses, discovered exports, planned connectors,
  provenance domains, and their privacy behavior.

Workbench is intentionally not a transcript-first chat viewer. It starts with
projects, evidence, and reusable findings; full turn content stays behind an
explicit evidence action.

### Frontend migration boundary

The established Workbench remains a static Bun-served application while its
surfaces are migrated incrementally. Memory Lab is the first standalone
Foldkit vertical slice at `/memory/`; it is not embedded inside the legacy
interaction tree.

The slice uses Foldkit `0.132.0`, Effect `4.0.0-beta.101`, Tailwind `4.3.3`,
and Vite `8.1.5` as one exact-pinned runtime unit. Repository-owned semantic
tokens and Tailwind utilities follow the shadcn source-ownership philosophy;
React shadcn components are not dependencies. Its layout starts as one column,
uses touch-sized controls and safe-area padding, and expands internal review
geometry through container queries rather than reordering information.

The application model, messages, update function, and HTTP commands are
explicit Foldkit boundaries. Effect Schema decodes every response before it
enters the model. Foldkit Story tests cover state and command laws, while Scene
tests cover semantic interaction and inert rendering of untrusted snippets.

The blinded adjudication packet and the proposal-review workflow remain
separate. A packet-bound `proposals.json` sidecar contains the exact
model-authored lesson, suggested outcome, rationale, and generator provenance
for every candidate. Operator choices are stored in their own versioned review
ledger; they are not reinterpreted as expert evidence labels. This preserves
the meaning of `correct`, `incorrect`, `unsure`, and
`positive`/`negative`/`neutral` without asking the operator to manipulate
semantic-analysis terminology or evidence indices.

The API hashes the exact `proposals.json` bytes. Every draft, final review, and
write request binds both the packet hash and this proposal-set hash. Replacing
or even rewriting the proposal sidecar therefore cannot silently reinterpret
an existing judgment.

### Memory Lab write boundary

Workbench remains read-only except for two narrow, packet-bound Memory Lab
actions:

- `POST /api/memory-lab/draft` replaces one candidate review in the current
  local draft;
- `POST /api/memory-lab/finalize` validates all rows and writes the locked
  operator-review file.

Both endpoints require JSON plus `X-Chatlog-Memory-Lab: 1`, reject bodies over
16 KiB, accept no paths, validate the exact current packet hash and aliases,
and write atomically with mode `0600`. Only separated
`derived/adjudication/refinery/<hash>/public/` bundles with an exact
packet-bound `proposals.json` are discoverable; legacy directories that
co-locate private mapping data are ignored. Drafts use
`operator-reviews.draft.json`; final reviews use create-once
`operator-reviews.json`. Existing expert `answers.draft.json` and
`answers.json` files are ignored and preserved. A malformed operator draft or
final file fails closed rather than being overwritten. Finalized reviews cannot
be edited through Workbench. Every other non-GET route still returns `405`.

### Repository identity

Harness records still preserve their exact working directory as `cwd`, but
adapters no longer use that path directly as project identity when Git metadata
is available. Chatlog walks to the nearest `.git` marker, follows linked
worktree `gitdir` and `commondir` metadata without invoking Git, and uses the
shared common Git directory to resolve the main checkout root. A normal
checkout, its nested directories, and live `/tmp` worktrees therefore ingest as
one project. If a valid repository keeps its common metadata in a nonstandard
external directory, that shared directory becomes the canonical project path
because no unique main checkout can be derived safely without invoking Git.

Resolution is deliberately conservative. Missing, deleted, inaccessible,
malformed, and non-Git layouts keep their normalized recorded path rather than
being guessed into another repository. Existing-path successful and fallback
lookups use bounded process-local caches.

The corpus manifest records `projectIdentityRecipe`. A changed or missing
recipe invalidates unchanged-source skips on the next `bun run ingest`, so
stored project grouping cannot silently remain on an older identity rule.
Re-ingestion preserves the source logs and produces new content-addressed
canonical objects where project identity changed.

### Universal layout

Workbench starts from one top-to-bottom column with touch-sized actions and an
off-canvas, stateful navigation menu. Component grids expand through container
queries based on their own available width. A wider viewport adds the persistent
sidebar and desktop page geometry; tablet widths receive a separate final
refinement. Keyboard focus, Escape and outside-tap navigation dismissal, visible
focus rings, reduced-motion preferences, and narrow-width overflow handling are
part of the same layout contract.

### Insight authority and evidence

Workbench hashes the exact bytes of `derived/current-hashes.jsonl`. It compares
this hash with the `inputProjectionHash` in each artifact and artifact manifest.
The server returns orchestration, role, and refinery artifacts only when all
three hashes agree.

A missing projection, missing provenance, manifest disagreement, or older
projection returns HTTP 503. The UI displays the request error. It does not
display the artifact as historical guidance.

Effectiveness results depend on role segmentation. The server requires each
result's `roleProfileContentHash` to name the current role artifact. A mismatch
returns HTTP 503, so an older effectiveness result is not served.

Aggregate insight artifacts are optional only after the active and derived
authority checks pass. `/api/insights` reports an absent optional artifact as
unavailable. `/api/knowledge-candidate` returns HTTP 404 when the current
refinery artifact is absent. If the base authority is stale, both endpoints
return HTTP 503 instead.

Insight evidence is pointer-only and bounded. Each orchestration, role, or
effectiveness finding includes at most three `chatlog://` pointers. Each
refinery candidate includes at most two. The evidence dialog resolves one turn
at a time. `/api/insights` does not embed derived snippets or complete turns.
### Prior Attempts

Prior Attempts calls the existing local `agentAskLexical` computation and makes
no model or network request. Workbench enables its optional content-role filter,
so only matching current `user` or `assistant` turns are grouped, and applies a
grouped-session cap before any derived artifact is read. Tool-only FTS matches
therefore cannot drive artifact reads or enter the timeline, and superseded
conversation hashes cannot enter it either. Existing four-argument
`agentAskLexical` callers retain the original all-role behavior.

The response returns at most ten recent qualifying sessions, ordered
chronologically for reading. Each session bounds lexical matches to two,
problems to two, attempts to four, decisions to three, and resolution evidence
to two. Snippets are capped at 360 characters and each item retains an explicit
`chatlog://` pointer. Attempt rows also retain their derived outcome, tool names,
and result pointer when present. Full content still requires the evidence
dialog's current-object check.

The endpoint defaults to six returned sessions and at most 24 derived artifact
reads. The current UI requests eight sessions and therefore permits at most 32
reads. The endpoint clamps requests to ten sessions, making 40 derived artifact
reads the hard per-request maximum. Omitted or blank `limit` parameters use the
six-session default; response bounds report both the requested session limit
and the actual number of derived artifacts read.

### Project Intelligence

Opening a project now returns a bounded brief before its session list:

- exact overview plus bounded top-eight model and top-ten assistant-tool rows
  computed from `current_conversations`;
- outcome mix, recurring problem categories, and recent decisions from at most
  40 recent current-session derived artifacts;
- explicit sampled/loaded/missing-derived counts, so sampled outcomes are never
  presented as whole-project totals;
- at most 100 current sessions, newest first.

The default UI uses a 24-session derived sample and shows 40 sessions. Omitted
or blank `sampleLimit` and `sessionLimit` parameters use those same defaults,
which are reported in the response bounds. Missing projects fail explicitly. No
project page runs DuckDB, scans every project artifact, invokes a model, or
starts background work.

### Knowledge Gaps review

Knowledge Gaps review is a read-only curation inbox over the currently selected
refinery artifact. Its rows are possible review leads, not findings: no row is
accepted, promoted, or classified as a project documentation gap. Frequency is
shown as a nomination signal only.

The server searches candidate IDs, titles, signatures, types, and statuses, then
applies an exact type filter before pagination. Query text is capped at 160
characters, pages at 10,000, and page size at 50 (default 20). The canonical
list endpoint can therefore reach every candidate without sending the entire
artifact to the browser.

Opening a row loads a separate read-only detail with:

- the refinery projection freshness and artifact provenance;
- status and full frequency dimensions;
- the artifact's curation principle, route, and at most 12 checks;
- the artifact's evaluation contract, status, paired-run plan, metrics, and
  keep/cut rules;
- at most six pointer-only evidence items, each opened through the existing
  canonical one-turn evidence dialog.

The refinery schema contains no recorded operator-judged documentation
precision result. The Workbench therefore exposes the precision gate as
`unavailable` and candidate interpretation as `possible-only`. Project
documentation-gap classification remains unavailable until a recorded
operator-judged result reaches at least 70% precision. This view does not run a
documentation-coverage query, scan project documentation, invoke a model, send
egress, or expose mutation controls.

For compatibility, `/api/insights` still includes its existing refinery
candidate projection when called without parameters. The Workbench bootstrap
uses `/api/insights?candidateLimit=0` and loads candidates through the bounded
list/detail endpoints instead.

### Experimental Themes explorer

Themes is an explicitly experimental, partial cached-sample view. It is not
loaded during Workbench bootstrap: the operator must press **Load cached
themes**. That GET reads only completed
`analysis/vault-topic-cache/<prefix>/<key>.json` files and
`derived/current-hashes.jsonl`. It never invokes topic extraction, Ollama, a
network request, or a cache write.

Coverage is exact only when the current projection and the bounded cache scan
are both complete. For every observed model and extraction-recipe variant, the
server recomputes the canonical vault cache key for every current conversation
hash. A cache file counts toward current coverage only when its filename exactly
matches one of those keys. Valid completed entries that do not match are
reported as stale/other; malformed entries are counted separately and neither
can inflate current theme counts.

Topics from matching variants are unioned per covered current conversation,
then clustered with the deterministic
`vault-topic-token-set-jaccard-current-conversation-v1` recipe. Each canonical
cluster counts at most once per covered conversation. The response bounds the
top cluster list to 50, cluster members to 10, cache scanning to 10,000 files,
projection input to 16 MiB, individual cache files to 64 KiB, and
current-hash × variant key computations to 1,000,000. Before the pairwise
clustering function runs, the server also caps normalized topics at 1,000 and
pairwise comparisons at 500,000. The default display shows 20 clusters.

The view reports the exact current denominator, covered conversations and
percentage, completed cache entries, stale/other and invalid counts,
model/recipe variants, and shared versus singleton-long-tail clusters. If the
projection is missing or malformed, or either safety bound is exceeded,
`coverage.exact` is false, clusters are withheld, and the response explicitly
declines a whole-corpus claim. `scanLimit` may lower the scan bound for an
operator audit but can never raise the hard maximum. `topicLimit` similarly
lowers the normalized-topic bound; exceeding either the applied topic limit or
the pairwise comparison limit returns `topic-clustering-bound-exceeded` before
clustering begins.

## Run it

```sh
bun run ingest
bun run derive
bun run refine
bun run workbench
```

Open `http://127.0.0.1:4789`. The server binds to loopback by default. Its
corpus and evidence routes are read-only; the only writes are the bounded
Memory Lab draft/finalize actions described above.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHATLOG_DATA_ROOT` | `${XDG_DATA_HOME:-~/.local/share}/chatlog` | Corpus, derived data, and analysis DB |
| `CHATLOG_SOURCE_CONFIG` | `~/.config/chatlog/sources.json` | Additional source catalog |
| `CHATLOG_HOST` | `127.0.0.1` | Listen address |
| `CHATLOG_PORT` | `4789` | Listen port |
| `CHATLOG_ALLOW_REMOTE` | unset | Must equal `1` before a non-loopback bind |

Remote access is deliberately opt-in. If access from another machine is needed,
prefer a private overlay or authenticated reverse proxy rather than exposing
the port directly.

The operator deployment keeps Workbench on loopback and publishes
`https://chatlog.home.phibkro.org` only inside the LAN/tailnet through the
Homelab entry plane. This is deployment policy rather than an application
feature: the public Internet remains outside the trust boundary while Chatlog
has no application authentication.

## Connect sources

Claude Code, Codex, and Pi are discovered from their standard local session
directories and ingested with `bun run ingest`. Additional sources can be
declared without teaching the UI about provider-specific paths:

```json
{
  "sources": [
    {
      "id": "claude-web-personal",
      "kind": "anthropic-export",
      "label": "Claude Web — personal",
      "path": "/private/exports/anthropic-data.zip",
      "domain": "personal",
      "enabled": true
    }
  ]
}
```

Save this as `~/.config/chatlog/sources.json`, or point
`CHATLOG_SOURCE_CONFIG` at another file. The source page reports availability
and the exact import action. Merely configuring or discovering an export does
not read its conversation content.

### Anthropic data exports

Preview a ZIP archive or its extracted directory without writing corpus,
database, derived, or receipt state:

```sh
bun run preview:anthropic -- /private/exports/anthropic-data.zip personal
```

The aggregate preview reports the selected domain, source fingerprint,
new/changed/reclassified/unchanged conversation counts, projected turn and
attachment counts, date range, exclusions, a stable proposal ID, and a
deterministic advisory receipt ID for the manifest state it observed. It does
not return conversation titles, snippets, messages, or attachment bodies.

After reviewing the preview, import explicitly:

```sh
bun run import:anthropic -- /private/exports/anthropic-data.zip personal
```

The final argument is a provenance domain such as `personal`, `coding`,
`research`, or `general`. Domain is metadata for filtering and policy; it does
not weaken redaction.

Import behavior:

- reads `conversations.json` locally and never modifies the export;
- normalizes conversations into the existing immutable canonical schema;
- runs the normal secret-redaction and content-hashing boundary;
- reconstructs visible tool calls and results where the export includes them;
- retains attachment and file names, but not extracted attachment bodies;
- excludes private model-thinking and token-budget blocks;
- skips unchanged conversations on subsequent imports;
- derives structure and refreshes refinery candidates unless `--no-derive` is
  supplied;
- writes a mode-0600 completion receipt after the manifest commit, recording
  derivation as `completed`, `failed`, or `not-requested`.

Receipts contain source and manifest hashes, selected policy, aggregate counts,
and bounded derivation status. They never contain titles, messages, snippets,
tool arguments, attachment bodies, or error text. Inspect the newest receipts
with:

```sh
chatlog receipts imports 20
```

Workbench shows the same read-only audit trail on the Sources page. Receipt
files live beneath `receipts/imports/` in the Chatlog data root.
If post-import derivation fails, the command still returns an error, but the
receipt remains as evidence of the already-committed manifest transition.
Crash recovery between the manifest commit and receipt write remains part of
the later durable-intent lifecycle migration.

### Active source projection

The corpus manifest is the durable reachability authority. SQLite mirrors its
source-path-to-content-hash map in `active_sources` and records the canonical
manifest-sources hash in `active_projection_meta`. Current views join both the
source path and content hash instead of inferring authority from whichever
historical row was indexed most recently.

Normal local ingestion and Anthropic imports reconcile this projection under
the ingest lock. Upgrade an existing pre-projection database explicitly:

```sh
chatlog source reconcile
```

The command rebuilds missing active index/turn/tool/FTS rows from immutable
canonical objects, validates every manifest mapping, then replaces the
projection and its receipt in one SQLite transaction. Workbench, MCP, operator
queries, and Pi bridge emission compare the manifest, projection receipt, and
active rows before serving current data. Missing or unequal state fails closed;
Workbench reports drift as HTTP 503 while the Sources and receipt audit views
remain available for diagnosis.

Workbench insights and DuckDB analytics apply the same rule to derived state.
The active conversation projection, aggregate input hashes, and current
content-addressed artifacts must agree. If source authority advances before
derivation completes—or an aggregate artifact is missing or modified—the
affected read fails with an actionable derived-projection error instead of
serving an older insight.

The current importer does not ingest Claude Projects, memories, or design
artifacts. Those have different authority and retention semantics, so they
should become distinct, reviewable source types.

Domain reclassification, revocation, and physical purge remain CLI-only
follow-up work. Their frozen safety contract is documented in
`docs/exec-plans/active/0002-source-lifecycle.md`; Workbench remains read-only.

ChatGPT exports and arbitrary harness JSONL appear as `planned` in the source
catalog. They require explicit schema adapters before the UI will call them
connected.

## Agent access

Workbench's JSON endpoints expose the same bounded views used by the UI:

| Endpoint | Result |
| --- | --- |
| `/api/health` | Lightweight manifest-backed readiness and active-source count |
| `/api/overview` | Corpus counts, recent sessions, project concentration |
| `/api/projects` | Project activity and harness mix |
| `/api/sessions?project=…` | Session metadata for a project |
| `/api/search?q=…&limit=…` | Ranked local FTS results and evidence pointers |
| `/api/prior-attempts?q=…` | Zero-egress chronological attempts from current content-role matches |
| `/api/project-intelligence?project=…` | Exact current totals, bounded derived sample, then current sessions |
| `/api/knowledge-candidates?q=…&type=…&page=…&pageSize=…` | Bounded search and pagination across refinery review leads |
| `/api/knowledge-candidate?id=…` | Read-only curation/evaluation detail with bounded evidence pointers |
| `/api/themes?limit=…&scanLimit=…&topicLimit=…` | On-demand completed-cache clustering with exact-or-fail-closed bounds |
| `/api/evidence?uri=chatlog://…` | One canonical redacted turn |
| `/api/insights` | Projection provenance plus bounded orchestration, role, experiment, and refinery findings |
| `/api/sources` | Connector state and import actions |
| `/api/receipts?limit=…` | Newest bounded completed-import receipts |

These endpoints are useful for local dashboards and small agent tools. The
existing CLI remains the broad operator contract because it is composable and
does not require a resident server. The implemented Wave 1 MCP server exposes a
smaller policy-filtered subset over stdio: search, one-turn evidence, recent
project work, and bounded project briefs. Both surfaces use the same analysis
store.

## Package and deploy

`flake.nix` packages the Workbench static assets and the Bun runtime entry
points, without embedding any corpus data — `nix build` only ever copies
`src/`, `package.json`, and `tsconfig.json` into the store.

```sh
nix build .#chatlog
CHATLOG_DATA_ROOT=/absolute/path/to/data ./result/bin/chatlog-workbench
CHATLOG_DATA_ROOT=/absolute/path/to/data ./result/bin/chatlog preview anthropic /path/to/export.zip personal

# or run the apps directly without a local checkout
nix run .#cli -- preview anthropic /path/to/export.zip personal
nix run .#workbench
nix run .#mcp
```

`nix flake check` evaluates the package and the Home Manager module without
network access once the flake's inputs are already fetched.

### Home Manager user service (opt-in)

A Home Manager module provides `services.chatlog-workbench`, disabled by
default:

```nix
{
  imports = [ chatlog.homeManagerModules.default ];

  services.chatlog-workbench = {
    enable = true;               # default: false
    # package = chatlog.packages.${pkgs.system}.chatlog;  # default
    # dataRoot = "${config.xdg.dataHome}/chatlog";         # default
    # host = "127.0.0.1";                                  # default; loopback
    # port = 4789;                                         # default
  };
}
```

Enabling it registers a `systemd --user` unit (`Restart=on-failure`,
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, and a
`ReadWritePaths` carve-out scoped to `dataRoot` — everything else in `$HOME`
stays read-only to the unit) and creates `dataRoot` on activation if it does
not already exist. `host` defaults to loopback. The server itself refuses a
non-loopback bind unless `CHATLOG_ALLOW_REMOTE=1` is set in its environment, so
changing `host` alone does not expose the service.

`GET /api/health` is the lightweight readiness probe for operators and
monitors. It verifies that the manifest-backed source projection is current
without running the dashboard's corpus, project, tool, or time-series
aggregations; it returns HTTP 503 when the database is absent or the projection
has drifted.

Remote access is deliberately not this module's job. Front Workbench with
Tailscale Serve or another authenticated reverse proxy pointed at
`127.0.0.1:<port>`. That remains an operator action at the network boundary;
the module and package never configure Tailscale ACLs, certificates, Serve
state, or DNS. Workbench has no application login and exposes every local
conversation domain, so tailnet ACLs are the authorization boundary: only
devices and users trusted with the complete corpus should be able to reach the
Serve endpoint. The Home Manager module rejects non-loopback hosts rather than
creating a crash-looping service.

The workstation consumes Chatlog as a pinned `github:phibkro/chatlog` flake
input. Homelab enables the user service at `127.0.0.1:4789`, keeps mutable
state at `~/.local/share/chatlog`, and relays it on the workstation's Tailscale
address for Pi's private Caddy entry plane. That produces the canonical
`https://chatlog.home.phibkro.org` surface without weakening Workbench's
loopback bind policy. The source checkout is no longer a runtime dependency.

Derived projection checks deliberately hash the small projection and aggregate
artifacts, not every structural object on every read. Missing active objects
fail closed during analytics coverage checks; detecting out-of-band
modification of an existing structural object remains a trusted-local-storage
boundary so routine reads do not add a full filesystem hashing pass.

Codex's user-level MCP registration and each Claude Code project's `.mcp.json`
can launch the installed `chatlog-mcp` binary. Agent access should normally set
`CHATLOG_MCP_DOMAINS=coding`; the human Workbench remains the intentional
surface for reviewing personal and general conversation domains.

## Product boundary

This first slice uses one store and two surfaces:

```text
harness logs / explicit exports
              │
              ▼
     canonical redacted corpus
              │
       ┌──────┴──────┐
       ▼             ▼
  CLI / agents    Workbench / human
```

That boundary is intentional. Importers handle unstable provider formats,
Chatlog owns durable normalized evidence, and the CLI/UI are replaceable views.
There is no second conversation database to synchronize and no need to bake
each provider into a custom agent harness.
