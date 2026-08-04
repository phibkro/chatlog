# Changelog

## 0.1.0-rc.1 — 2026-08-03

Release candidate for the first provider-agnostic Chatlog context-plane pre-release.

### Available

- Canonical, immutable, redacted agent events for Claude Code, Codex, Pi, and OMP histories.
- Preview-before-write, required SHA-pinned imports for ChatGPT, Anthropic, and versioned `chatlog/generic-events-v1` exports.
- Source receipts, active-source authority, evidence URIs, and explicit semantic-loss accounting.
- Bounded, shape-validated canonical object reuse and crash-recoverable source operation intents.
- Temporally stratified, per-harness ingestion batches with active-file settling and resumable recipe migration.
- Local Workbench views for sessions, projects, prior attempts, evidence, patterns, memory review, and context outcomes.
- Workflow evolution, outcome, and pattern synthesis with operator annotations in the Pattern Explorer.
- A governed temporal insight ledger with human-authorized transitions, supersession, disputes, expiry, and recompilation.
- Memory Lab keeps blinded labeling separate from previewed, explicit insight application and retirement.
- Provider-neutral context planning, release gates, delivery receipts, bounded recursive recall, feedback, and observed outcomes.
- A local stdio MCP server for bounded search, evidence lookup, recent work, project state, governed context, and recall.
- Claude Code and Codex marketplace plugins with fresh-session hooks and local MCP registration.
- An offline Nix package with `chatlog`, `chatlog-workbench`, and `chatlog-mcp` executables.

### Safety boundaries

- Provider history directories are read-only.
- Raw transcripts remain local by default. Hosted reranking requires explicit opt-in.
- Reasoning and opaque provider records stay out of ordinary search, derived insight mining, and context delivery.
- Replayed Pi and OMP branches retain duplicate provider call IDs as distinct, message-scoped events.
- Import approval pins include the complete active-source authority, so concurrent corpus changes require a new preview.
- Workbench browser credentials use `HttpOnly` and `SameSite=Strict`; HTTPS responses also use `Secure`.
- External Workbench and annotation origins require HTTPS; cleartext HTTP is accepted only on exact loopback hosts.
- Model output cannot activate an insight. Promotion requires explicit operator authority.
- A delivery receipt proves exposure through an adapter, not model use or task improvement.

### Known limitations

- The packaged pre-release declares Linux `x86_64` and `aarch64` systems only.
- Ingestion is a command, not a continuous watcher. Run `chatlog ingest` after new work.
- Governed startup delivery requires a current insight projection for the active project. Corpus search tools remain independently available.
- Pi and OMP delivery uses manual, operator-authorized fresh-session prompt artifacts. There is no automatic plugin for those harnesses.
- Memory Lab requires a complete prepared adjudication bundle and never runs a model automatically.
- Hosted synchronization, team identity, and remote raw-transcript storage are not implemented.
- Provider-native formats can change. Unknown supported records are preserved as opaque evidence or reported as semantic loss instead of guessed.

See [README.md](README.md) for installation and first-launch instructions.
