# Chatlog Workbench

Workbench is the human-facing surface over Chatlog's local, content-addressed
conversation corpus. It is designed for a technically curious operator who
wants useful recall and evidence without turning private session history into a
hosted telemetry product.

## What it surfaces

- **Today** — corpus health, recent work, active projects, and the latest
  evidence-backed orchestration finding.
- **Projects** — project-level activity with a drill-down into individual
  sessions.
- **Recall** — local SQLite FTS5 search. Results carry
  `chatlog://conversation/<hash>/turn/<index>` pointers, and the evidence viewer
  resolves the canonical redacted turn on demand.
- **Patterns** — inferred role boundaries, measured agent experiments, and
  knowledge-refinery candidates. A candidate is a prompt for review, never an
  automatic configuration change.
- **Sources** — connected harnesses, discovered exports, planned connectors,
  provenance domains, and their privacy behavior.

Workbench is intentionally not a transcript-first chat viewer. It starts with
projects, evidence, and reusable findings; full turn content stays behind an
explicit evidence action.

## Run it

```sh
bun run ingest
bun run derive
bun run refine
bun run workbench
```

Open `http://127.0.0.1:4789`. The server is read-only and binds to loopback by
default.

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
| `/api/overview` | Corpus counts, recent sessions, project concentration |
| `/api/projects` | Project activity and harness mix |
| `/api/sessions?project=…` | Session metadata for a project |
| `/api/search?q=…&limit=…` | Ranked local FTS results and evidence pointers |
| `/api/evidence?uri=chatlog://…` | One canonical redacted turn |
| `/api/insights` | Orchestration, role, experiment, and refinery artifacts |
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
state at `~/.local/share/chatlog`, and exposes that loopback endpoint through
Tailscale Serve. The source checkout is no longer a runtime dependency.

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
