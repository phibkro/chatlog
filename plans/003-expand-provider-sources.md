# Plan 003: Add ChatGPT export and generic event import

> **Executor instructions**: Read Plans 001 and 002 first. Use only approved synthetic or sanitized fixtures. Run each verification command.
>
> **Drift check**: Run `git diff --stat 8ddee39..HEAD -- src/importers src/adapters src/source-catalog.ts src/cli.ts test README.md docs`. Compare the live event and conformance contracts with this plan.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/002-adapter-conformance-and-loss.md`
- **Category**: direction, migration
- **Planned at**: commit `8ddee39`, 2026-08-03

## Why this matters

Chatlog advertises ChatGPT export and generic JSONL as planned sources. Neither source is connected.

Source expansion must use the event and loss contracts. Another flat transcript importer multiplies the current semantic loss.

## Current state

- `src/source-catalog.ts:149-165` marks ChatGPT export and generic JSONL as `planned`.
- `src/cli.ts:40-49` wires Claude Code, Codex, and Pi only.
- `src/importers/anthropic-export.ts:246-472` provides the established preview and explicit-import pattern.
- `test/anthropic-export.test.ts:70-156` proves preview creates no Chatlog state and import is idempotent.
- `docs/access-policy.md:45-61` requires preview, source lifecycle, domain assignment, and audit receipts before broad personal access.

Preserve the rule that provider exports are read-only inputs. Import remains explicit.

## Target sources

### ChatGPT export

Support a reviewed ChatGPT data export that contains conversation metadata and a message graph.

Preserve:

- conversation and message IDs
- parent and child relations
- branch selection when the export identifies it
- role and actor metadata
- create and update times
- visible text and declared attachments under capture policy
- tool or structured content only when the fixture establishes its meaning

Do not flatten abandoned branches into the selected conversation projection. Keep them in canonical events.

### Generic JSONL

Define a Chatlog-native, versioned event contract. Do not claim to parse arbitrary provider JSONL.

Each line must be one validated `AgentEventEnvelope` or one small batch envelope. The file header must declare:

- schema version
- producer name and version
- provider and harness labels
- source domain
- capture-policy version
- ordering and identity rules

External producers can supply only `ObservedOrigin`. They cannot claim `ChatlogOrigin`.

The importer stamps source path, record position, and adapter recipe from the validated file and header. It does not trust producer-supplied derivation provenance.

Unknown schema versions fail closed. Unknown event kinds use the Plan 002 opaque/loss policy.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| ChatGPT tests | `bun test test/chatgpt-export.test.ts` | Exit 0 |
| Generic event tests | `bun test test/generic-event-import.test.ts` | Exit 0 |
| Source catalog tests | `bun test test/workbench.test.ts test/adapter-conformance.test.ts` | Exit 0 |
| Type checks | `bun run typecheck` | Exit 0 |
| Full gate | `bun run check` | Exit 0 |

## Scope

**In scope**

- Create `src/importers/chatgpt-export.ts`.
- Create `src/importers/generic-events.ts`.
- Change `src/source-catalog.ts` and `src/cli.ts`.
- Change Workbench source data only to expose preview and import commands.
- Create synthetic fixtures under `test/fixtures/providers/chatgpt/` and `test/fixtures/providers/generic/`.
- Create `test/chatgpt-export.test.ts` and `test/generic-event-import.test.ts`.
- Update `README.md`, `docs/workbench.md`, and `docs/access-policy.md`.

**Out of scope**

- Scraping ChatGPT or any provider website.
- Hosted export upload.
- Automatic source discovery outside declared local paths.
- Import of account memories, custom instructions, projects, or files without separate reviewed schemas.
- ChatGPT context injection or browser automation.
- Arbitrary best-effort JSONL inference.

## Git workflow

- Use branch `advisor/003-provider-sources` in an isolated worktree.
- Keep commits separate for ChatGPT export and generic event import.
- Do not publish fixtures or open a pull request without operator authority.

## Steps

### Step 1: Obtain an approved fixture contract

Before coding, create or obtain a minimal sanitized ChatGPT export fixture. It must preserve structural keys and contain no real conversation content.

Record the fixture's export date and source in a test comment. Do not infer the schema from an unverified internet snippet.

The fixture must contain:

- one linear conversation
- one branched conversation
- one deleted or absent node reference if the export can contain it
- one attachment metadata case
- one system or tool-like content case if present
- one unknown well-formed content case

**Verify**: a schema-reader test can enumerate nodes and relations without importing them.

### Step 2: Add non-destructive ChatGPT preview

Model the preview after `previewAnthropicExport`.

The preview must report aggregate values only:

- conversations and messages
- branch counts
- attachment metadata counts
- unknown and omitted item counts
- selected domain
- date range
- new, changed, unchanged, and reclassified mappings
- source hash, proposal ID, and receipt ID

The preview must not create a corpus directory, event object, SQLite database, derived artifact, or receipt file.

**Verify**: `bun test test/chatgpt-export.test.ts` proves zero writes.

### Step 3: Normalize the ChatGPT message graph

Map each graph node to typed events and relations.

Rules:

- Keep native node and parent IDs.
- Keep all branches in canonical events.
- Generate a selected linear `Conversation` projection only after branch selection.
- Preserve an unknown branch selection as unknown. Do not select the newest child by guess.
- Keep attachments as metadata events unless the capture policy explicitly permits bodies.
- Keep custom instructions and account memory outside the conversation import.
- Record all omissions in the semantic-loss receipt.

**Verify**: branch, parent, loss, and projection tests exit 0.

### Step 4: Add explicit ChatGPT import

Use the active-source manifest, event batch storage, conversation projection, SQLite projection, derive, and receipt contracts from Plans 001 and 002.

Import must be incremental and idempotent. Reclassification creates new canonical bytes and mappings. It never mutates an existing object.

Add CLI commands:

```text
chatlog preview chatgpt <export-path> [domain]
chatlog import chatgpt <export-path> [domain]
```

Keep exact final names consistent with existing CLI grammar.

**Verify**: import, repeat import, changed export, and domain-reclassification tests pass.

### Step 5: Define the generic event schema

Publish one JSON Schema or equivalent runtime Schema beside `src/events.ts`.

The contract must specify:

- one versioned header
- event identity and ordering
- required source provenance
- event kind and payload
- relation semantics
- domain and scope
- capture disposition and loss entries
- maximum line and batch sizes
- redaction responsibility and final Chatlog redaction

The importer must reject:

- missing header
- unsupported version
- duplicate event IDs
- broken ordering rules
- relation cycles where cycles are invalid
- invalid domains
- oversized items
- malformed JSON
- an event or batch whose `origin.kind` is not `observed`
- source provenance that conflicts with the validated header or importer-stamped position

**Verify**: `bun test test/generic-event-import.test.ts` exits 0.

### Step 6: Add generic preview and import

Preview validates the whole file and reports counts, hashes, domains, kinds, losses, and proposed mappings. It writes nothing.

Import writes canonical event batches through the same ingest module. It does not bypass redaction, active-source authority, or receipts.

Add CLI commands and source configuration support.

Do not label arbitrary third-party files as compatible. A producer must emit the Chatlog event schema.

**Verify**: preview no-write, import idempotence, recipe drift, and invalid-version tests pass.

### Step 7: Connect the source catalog and docs

Change ChatGPT and generic event sources from `planned` only after their commands and tests exist. Rewrite `generic-jsonl` to name the versioned Chatlog event schema and required producer header.

Remove the OpenCode, Gemini, and Goose compatibility claim from `src/source-catalog.ts:160-161`. This plan does not parse their native formats.

The source UI must show:

- source kind and path
- domain
- preview command
- import command
- privacy statement
- last receipt summary when available

Do not add a mutating HTTP endpoint.

**Verify**: run source catalog and Workbench tests, then `bun run check`.

## Test plan

Model preview and import tests after `test/anthropic-export.test.ts`.

Required ChatGPT cases:

- branch preservation
- unknown active branch
- missing parent
- attachment metadata only
- unknown content block
- source change during read
- explicit domain reclassification

Required generic cases:

- supported version
- unsupported version
- duplicate ID
- invalid relation
- oversized line
- partial final line
- secret canary
- opaque event exclusion from FTS and insights

## Done criteria

- [ ] ChatGPT export preview is aggregate-only and creates no state.
- [ ] ChatGPT import preserves branch relations and source provenance.
- [ ] Generic JSONL means the versioned Chatlog event contract only.
- [ ] Both imports use active-source authority and semantic-loss receipts.
- [ ] Both imports are idempotent and recipe-aware.
- [ ] Catalog status matches executable capability.
- [ ] Personal-domain access stays excluded from default MCP policy.
- [ ] `bun run check` exits 0.
- [ ] `plans/README.md` marks Plan 003 `DONE`.

## STOP conditions

Stop and report if:

- No approved sanitized ChatGPT export fixture exists.
- The export does not identify branch selection, so a projection requires guessing.
- A requested source includes account memory, custom instructions, or file bodies without a separate capture decision.
- Generic import requires heuristic provider-schema inference.
- Import bypasses active-source receipts or final redaction.

## Maintenance notes

A provider export is an external schema. Add a fixture and recipe version for every structural change.

Keep ingestion and delivery adapters separate. Reading a ChatGPT export does not imply that ChatGPT can receive native context injection.
