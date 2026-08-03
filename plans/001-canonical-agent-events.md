# Plan 001: Make agent events the canonical evidence model

> **Executor instructions**: Read this plan fully. Run each verification command. Stop if a STOP condition occurs.
>
> **Drift check**: Run `git diff --stat 8ddee39..HEAD -- src test README.md CONTEXT.md` and `git status --short`. Compare all in-scope files with this plan. Do not overwrite the dirty experience-memory tracer.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: the active-source projection and receipts in `docs/exec-plans/active/0002-source-lifecycle.md`
- **Category**: direction, migration
- **Planned at**: commit `8ddee39`, 2026-08-03

## Why this matters

Chatlog loses branch, approval, compaction, artifact, and tool-lifecycle meaning before evidence exists. Derived insights cannot recover distinctions that ingestion discarded.

The existing adapter seam is the correct migration point. One event model must replace direct `Conversation` output.

## Current state

- `src/types.ts:14-45` defines `ToolCall`, `Turn`, and `Conversation` as flat records.
- `src/types.ts:53-62` defines `AdaptResult` as one conversation plus `partialTail`.
- `src/adapters/common.ts:55-92` flattens text, thinking, and nested content into one string.
- `src/ingest.ts:42-55` recursively redacts and hashes a conversation.
- `src/analysis.ts:17-62` stores conversations, turns, tool calls, and FTS rows only.
- `src/derive.ts:23-49` consumes `Conversation` and emits session-level evidence.
- `docs/cross-harness-continuity-findings.md:44-54` records the known semantic losses.

The current seam is:

```ts
export interface AdaptResult {
  conversation: Omit<Conversation, "contentHash">;
  partialTail: boolean;
}
```

Preserve these conventions:

- Apply eager adapter redaction and final recursive redaction.
- Use deterministic SHA-256 content addressing.
- Use typed Effect errors in adapters.
- Keep SQLite as a rebuildable read projection.
- Keep provider source directories read-only.
- Keep policy, permissions, and provider system instructions out of portable context.

## Target interface

Create one discriminated event envelope. Exact names can change only if the domain meanings remain distinct.

```ts
interface AgentEventEnvelope {
  schemaVersion: 1;
  eventId: string;
  kind: AgentEventKind;
  sequence: number;
  occurredAt?: string;
  observedAt?: string;
  actor: EventActor;
  scope: EventScope;
  origin: ObservedOrigin | ChatlogOrigin;
  relations: EventRelations;
  payload: AgentEventPayload;
  capture: CaptureDisposition;
}

interface ObservedOrigin {
  kind: "observed";
  source: SourceEventReference;
}

interface ChatlogOrigin {
  kind: "chatlog";
  processor: string;
  recipe: string;
  inputEventIds: readonly string[];
  inputHashes: readonly string[];
}

interface ObservedBatchOrigin {
  kind: "observed";
  source: SourceBatchReference;
}

interface ChatlogBatchOrigin {
  kind: "chatlog";
  processor: string;
  recipe: string;
  inputHashes: readonly string[];
}

interface EventBatch {
  schemaVersion: 1;
  origin: ObservedBatchOrigin | ChatlogBatchOrigin;
  events: readonly AgentEventEnvelope[];
  semanticLoss: readonly SemanticLossEntry[];
  partialTail: boolean;
}
```

The event kinds must cover these semantic distinctions:

- session started and ended
- message created
- model reasoning observed
- tool call proposed
- tool call approved or denied
- tool execution observed
- tool result observed
- artifact created or modified
- branch created or selected
- context compacted
- human correction
- evaluation recorded
- provider item preserved as opaque

Do not infer an event that the source did not report. A tool result does not prove approval or successful execution.

Relations must keep `parent`, `branch`, `causedBy`, `correlatesWith`, and `derivedFrom` separate. Do not add one generic edge.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Focused event tests | `bun test test/events.test.ts test/conversation-projection.test.ts` | Exit 0 |
| Adapter regression | `bun test test/anthropic-export.test.ts test/project-identity-ingest.test.ts test/derive.test.ts test/analysis.test.ts` | Exit 0 |
| Type checks | `bun run typecheck` | Exit 0 |
| Full gate | `bun run check` | Exit 0 |

## Scope

**In scope**

- Create `CONTEXT.md` with the glossary from `plans/README.md`.
- Create `src/events.ts` for semantic types and validation.
- Create `src/event-store.ts` for canonical batch serialization and content addressing.
- Create `src/conversation-projection.ts` for the current read model.
- Change `src/types.ts` so `SourceAdapter.adapt` returns `EventBatch`.
- Change `src/adapters/common.ts`, `claude.ts`, `codex.ts`, and `pi.ts`.
- Change `src/importers/anthropic-export.ts`.
- Change `src/ingest.ts`, `src/analysis.ts`, `src/derive.ts`, and `src/cli.ts` only as required by the migration.
- Add focused synthetic tests and fixtures under `test/fixtures/events/`.
- Update `README.md` sections that describe canonical storage and evidence URIs.

**Out of scope**

- New providers.
- Automatic insight promotion.
- Context delivery or advisor behavior.
- Raw unredacted provider payload storage.
- Native cross-provider resume conversion.
- Source revocation or purge work already owned by the active source-lifecycle plan.

## Git workflow

- Use an isolated worktree and branch `advisor/001-canonical-agent-events`.
- Use conventional commit messages, such as `feat(events): add canonical agent event batches`.
- Do not push or open a pull request without operator authority.

## Steps

### Step 1: Freeze semantic invariants with failing tests

Create synthetic records for Claude Code, Codex, Pi, and Anthropic Web.

Tests must prove these cases:

1. A proposed tool call differs from approval, execution, and observed result.
2. A failed result does not become a successful execution event.
3. Parent and branch relations survive normalization.
4. Compaction survives as an event with its source relation.
5. File proposals, attempts, and later confirmations remain separate events.
6. Reasoning never becomes ordinary searchable message text.
7. Event IDs and batch bytes are deterministic.
8. Source path, line or native ID, adapter recipe, and capture policy survive.

**Verify**: `bun test test/events.test.ts` must fail for missing production behavior before implementation.

### Step 2: Add the event kernel

Implement strict runtime validation in `src/events.ts`.

Use closed unions for event kinds and relation names. Keep provider and harness values open strings.

Each observed origin must include:

- provider and harness
- source kind
- native session ID when present
- native item ID when present
- source path and record position
- adapter recipe or version
- capture-policy version
- redacted native-record hash

Each Chatlog origin must name its processor, recipe, input event IDs, and input hashes. It has no fabricated provider path or native-record hash.

The capture disposition must say `normalized`, `opaque`, `redacted`, or `omitted`. An omission requires a reason code.

**Verify**: `bun test test/events.test.ts` exits 0.

### Step 3: Add canonical event-batch storage

Write immutable batches under a new content-addressed event path. Extend the active source manifest with both the canonical batch hash and the conversation projection hash.

The manifest remains the authority. SQLite remains a projection.

Store no secret-bearing native payload. Store a redacted opaque payload only when the capture policy permits it.

A recipe change must rebuild affected event batches and projections.

**Verify**: add an idempotent ingest test. Run `bun test test/project-identity-ingest.test.ts test/events.test.ts`.

### Step 4: Migrate every existing adapter

Change all current adapters in one cutover. No adapter can emit `Conversation` directly after this step.

Provider-specific requirements:

- Claude Code: keep message UUID and parent UUID, tool-use/result IDs, permission changes, file-history metadata, and session metadata.
- Codex: keep response-item kind, call/result IDs, compaction, world-state references, and tool-search/local-shell/computer distinctions.
- Pi: keep entry IDs, parent IDs, compaction, branch summaries, model changes, calls, and results.
- Anthropic Web: keep conversation-tree and message IDs that exist. Keep declared attachment and thinking omissions.

Reasoning rules:

- Put local Claude and Pi thinking in `model.reasoning.observed` events.
- Exclude reasoning events from default FTS, insights, handoffs, and context delivery.
- Do not decrypt or reinterpret opaque Codex reasoning.

**Verify**: run all focused adapter and importer tests.

### Step 5: Make `Conversation` a deterministic projection

Project the current `Conversation` shape from active event batches. Existing CLI, Workbench, MCP, derive, refinery, and bridge behavior can use this read model during migration.

Projection rules must be explicit:

- Message events produce turns.
- Tool lifecycle events project to the legacy call/result shape without claiming unsupported status.
- Branches can produce a selected linear view, but the canonical events retain all branches.
- Reasoning and opaque provider events do not enter message content.
- Every projected turn retains the source event IDs that produced it.

Keep current `chatlog://conversation/.../turn/...` resolution for existing callers. Add a stable event-reference format for new code.
Use one parser with a closed union of both grammars. Do not rewrite legacy pointers during projection or migration.

**Verify**: `bun test test/conversation-projection.test.ts test/derive.test.ts test/analysis.test.ts` exits 0.

### Step 6: Index events and provenance

Add rebuildable SQLite tables for event metadata, typed relations, and source-to-event mappings. Do not duplicate full secret-redacted bodies when the object store already owns them.

Update evidence resolution so a derived pointer can reach canonical source events. Keep current domain and active-source checks.

**Verify**: focused analysis and evidence tests prove inactive batches fail closed.

### Step 7: Complete migration and documentation

Remove direct conversation canonicalization from adapters. Keep only the projection function.

Update `README.md` with:

- event batches as canonical evidence
- conversations as projections
- event and conversation pointer roles
- reasoning and opaque-event exclusions
- recipe and active-source authority

**Verify**: run `bun run check` and `nix flake check --offline`.

## Test plan

Model test style after:

- `test/anthropic-export.test.ts:50-156`
- `test/project-identity-ingest.test.ts:10-87`
- `test/derive.test.ts`
- `test/analysis.test.ts`

Add contract tests for accepted transitions and at least one rejection. Include malformed timestamps, duplicate native IDs, dangling relations, unknown event kinds, partial tails, and recipe drift.

## Done criteria

- [ ] Every current production adapter returns `EventBatch`.
- [ ] No production adapter or importer constructs a canonical `Conversation` outside `src/conversation-projection.ts`.
- [ ] `adaptAnthropicConversation` and `importAnthropicExport` use the event-batch and projection path.
- [ ] Every event has deterministic identity and warranted origin provenance.
- [ ] Tool proposal, approval, execution, and result are different events.
- [ ] Reasoning does not enter ordinary message FTS.
- [ ] `Conversation` is generated from events and passes existing consumer tests.
- [ ] Active-source checks cover event and conversation projections.
- [ ] `bun run check` exits 0.
- [ ] `nix flake check --offline` exits 0.
- [ ] `plans/README.md` marks Plan 001 `DONE`.

## STOP conditions

Stop and report if:

- The active-source prerequisite is not complete.
- Current dirty tracer work is not preserved in another branch or commit.
- A provider fixture lacks enough native identity to define deterministic relations.
- The migration requires storing unredacted provider payloads.
- Existing evidence URIs cannot remain resolvable through a documented projection map.
- A new event meaning requires guessing provider semantics.

## Maintenance notes

The event taxonomy is the highest-cost contract in this roadmap. Review event names for semantic truth, not convenience.

Future adapter additions must account for every source item. They cannot add new flattening paths beside this kernel.
