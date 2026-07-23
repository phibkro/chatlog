# Product foundation: deployment and bounded agent recall

Status: completed
Base: `b8a2b21` (`product-workbench`)  
Owner: GPT-5/Codex integration lead  
Review model: Fable 5, read-only

## Outcome

Make Chatlog dependable enough to run continuously on the workstation and
useful enough for coding agents to retrieve bounded, attributable prior
evidence.

Wave 1 has two independently mergeable workstreams:

1. package Workbench and provide a Home Manager user service;
2. expose a local stdio MCP server over the existing read models.

The Workbench UI, corpus format, immutable objects, derivation recipes, and
existing CLI commands remain compatible.

## Frozen architecture

```text
source logs / explicit exports
              │
              ▼
     canonical redacted corpus
              │
       ┌──────┴──────────┐
       ▼                 ▼
Workbench HTTP       MCP stdio
human, all domains   agent, policy-filtered
```

- Workbench continues to bind to `127.0.0.1:4789` by default.
- Tailscale Serve is the recommended remote HTTPS boundary. Workbench does not
  configure or mutate the tailnet.
- MCP uses stdio. It does not open a socket.
- MCP is read-only and performs no hosted calls in Wave 1.
- MCP defaults to the `coding` domain. An explicit local environment policy is
  required to make another domain visible.
- Discovery responses are bounded. Canonical evidence resolves one redacted
  turn and truncates its textual body at the contract limit.
- Provider session files and export archives remain read-only inputs.

## Workstream A: package and service

Owned paths:

- `flake.nix`
- `nix/**`
- deployment sections of `README.md` and `docs/workbench.md`
- packaging/service tests or checks

Required outputs:

- a Nix package containing the Workbench static assets and Bun runtime entry
  points;
- runnable package apps for Workbench and MCP, without embedding corpus data;
- a Home Manager module for an opt-in Workbench user service;
- options for package, data root, host, and port;
- loopback remains the module default;
- service restart behavior and conservative user-service hardening;
- documented Tailscale Serve handoff, not an imperative activation action.

Non-goals:

- adding Chatlog to the homelab flake before its package contract is stable;
- configuring Tailscale ACLs, certificates, Serve state, or DNS;
- copying the corpus into the Nix store;
- exposing Workbench to the public internet.

Acceptance:

- `nix flake check` evaluates without network when inputs are already present;
- `nix build .#chatlog` produces a runnable package;
- the module evaluation proves the service is disabled by default and binds
  loopback when enabled;
- `bun run check` remains green.

## Workstream B: MCP server

Owned paths:

- `src/mcp/**`
- narrowly required changes to `src/workbench/data.ts` or `src/agent-query.ts`
- `test/mcp*.test.ts`
- MCP sections of `package.json`, `README.md`, and
  `docs/mcp-tool-shape.md`

Wave 1 tools:

| Tool | Purpose | Default / maximum |
| --- | --- | --- |
| `chatlog_search` | Ranked local lexical snippets | 8 / 20 hits |
| `chatlog_get_evidence` | One canonical redacted turn | 12,000 characters |
| `chatlog_recent_work` | Recent session metadata for one project | 8 / 20 sessions |
| `chatlog_project_brief` | Bounded project activity and derived findings | fixed bounded shape |

Protocol requirements:

- JSON-RPC 2.0 MCP over newline-delimited stdio;
- implement `initialize`, `notifications/initialized`, `tools/list`, and
  `tools/call`;
- stdout contains protocol messages only; diagnostics go to stderr;
- invalid inputs return structured tool errors without terminating the server;
- unknown methods receive a JSON-RPC method-not-found response;
- server identity and protocol version are deterministic.

Access policy:

- `CHATLOG_MCP_DOMAINS` is a comma-separated allow-list;
- unset or empty means `coding`;
- `*` is rejected rather than treated as all domains;
- filtering occurs in SQL before result limiting;
- evidence resolution rechecks the canonical conversation domain;
- missing legacy domain metadata is treated as `coding`;
- every response reports the active domain policy;
- project arguments require exact project paths and cannot widen domains;
- Wave 1 invokes neither hosted semantic reranking nor external processes.

Bounding:

- validate numeric inputs and clamp at the documented maximum;
- snippets remain FTS-bounded;
- evidence returns `truncated`, `fullLength`, and the stable evidence URI;
- project briefs cap every collection and omit complete conversations;
- tool arguments/results are not returned by discovery tools.

Acceptance:

- protocol tests exercise initialization, listing, calls, errors, and stdout
  hygiene;
- policy tests prove personal-domain rows cannot appear under the default;
- limit-before-filter regressions are covered;
- evidence-domain rechecks and content truncation are covered;
- existing agent query, Workbench, importer, and redaction tests remain green;
- the browser and Bun entry points still bundle.

## Privacy and egress

Delegated workers receive source code and synthetic fixtures only. They must
not read:

- `/srv/share/projects/chatlog/corpus`;
- `/srv/share/projects/chatlog/analysis`;
- the Anthropic export archive;
- real Workbench API results or real conversation snippets.

Fable 5 reviews the integrated code and synthetic tests. It does not inspect
the real corpus. Real-corpus validation is performed locally by the lead and
reports only counts, latency, policy results, and opaque evidence identifiers.

## Integration and review gates

1. Each worker commits only its owned worktree.
2. The lead reviews and cherry-picks one workstream at a time.
3. The lead resolves shared-file conflicts and runs `bun run check`.
4. Fable 5 receives the integrated diff in read-only mode and reports
   actionable findings only.
5. The lead addresses accepted findings.
6. Final gates:
   - Bun tests and bundles;
   - Nix package/module evaluation;
   - protocol transcript test;
   - default-domain denial test against synthetic and real indexes;
   - Workbench handler regression;
   - loopback bind and remote-bind refusal;
   - `git diff --check`.

## Handoff contract

Every worker reports:

- commit hash;
- files changed;
- acceptance commands and results;
- assumptions and known limitations;
- privacy or schema implications;
- unresolved decisions;
- recommended reviewer focus.

Review findings contain severity, file/evidence, failure scenario, why tests
miss it, and the smallest acceptable correction. The integration lead owns
final architectural decisions.

## Results

Completed on 2026-07-23.

- Workbench and the stdio MCP server are packaged as standalone Nix apps.
- The opt-in Home Manager service defaults to loopback and rejects a
  non-loopback host during evaluation; remote access remains a Tailscale Serve
  boundary.
- MCP defaults to `coding`, filters domains and user/assistant roles in SQL
  before limiting, and requires current index/object domain agreement before
  resolving evidence.
- Evidence denial is uniform for missing, superseded, policy-hidden,
  domain-mismatched, and tool-role pointers.
- Fable 5 reported two Medium and six Low findings in its first read-only
  review. Commit `102249f` closed all eight; its second read-only pass found no
  remaining actionable findings.
- `bun run check` passes 28 tests with 185 assertions and bundles the CLI, MCP,
  Workbench server, and browser application.
- `nix flake check --offline` builds the package and validates the Home Manager
  module. The packaged MCP executable completed an initialize/list transcript
  against a copy-on-write real-corpus snapshot.
- The same snapshot confirmed default `coding` policy, eight bounded search
  hits, eight recent sessions, a 1,095-session project brief with no missing
  derivations, and one bounded user-turn evidence resolution. No conversation
  content was reported.

Residual accepted boundaries:

- Workbench has no application login and treats tailnet ACLs as authorization.
- User-service hardening is evaluation-tested; enabling it in the workstation
  Home Manager configuration remains a separate operator deployment action.
- MCP trusts its local stdio client; whole-object JSON reads and input line
  length are not hardened against a malicious local client in Wave 1.
