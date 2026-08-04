# Plan 005: Connect context delivery to observed outcomes

> **Executor instructions**: Read Plans 001, 002, and 004. Build the intervention ledger before broader personalization. Run each verification command.
>
> **Drift check**: Run `git diff --stat 8ddee39..HEAD -- package.json scripts src/mcp src/experience-memory* src/bridge.ts plugins apps/workbench-web src/workbench test docs`. Compare the live hook, MCP tools, insight ledger, and event kernel with this plan.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/004-governed-insight-ledger.md`
- **Category**: direction
- **Planned at**: commit `8ddee39`, 2026-08-03

## Why this matters

Chatlog can compile and return memory. It cannot record which context reached which session or connect that context to later observed outcomes.

Without this link, personalization is not a measurable feedback loop. It can become stale, harmful, or self-confirming without detection.

## Current state

- `src/experience-memory-hook.ts:54-67` emits startup context and a snapshot hash.
- `src/mcp/server.ts:105-124,160-164` returns one exact memory card by snapshot hash and memory ID.
- `plugins/chatlog-memory/README.md:3-10` states that recall does not authenticate which session supplied the hash.
- `MemoryScope` includes repository, path, tool, model, and harness. Recall does not evaluate those fields.
- `MemoryFeedbackRecord` exists at `src/experience-memory.ts:86-92`. No tool or store consumes it.
- `src/bridge.ts:18-28` and `src/hosted-rerank.ts` already demonstrate receipt patterns.
- `docs/promotion-runs/2026-07-28-experience-memory-tracer.md:73-98` reports a structural pass and mixed utility.
- `docs/access-policy.md:32-43` requires policy filtering before disclosure.

Preserve startup pinning and progressive disclosure. Do not change an active session's memory snapshot.

## Target modules

### Context planner

```ts
interface ContextPlanner {
  plan(request: ContextRequest): Effect<ContextBundle, ContextPlanError>;
}
```

The planner selects evidence, active insights, procedure references, and current project state. It applies scope, domain, risk, freshness, authority, and budget policy.

### Delivery adapter

```ts
interface DeliveryAdapter {
  capabilities: ProviderContextCapabilities;
  render(bundle: ContextBundle, target: ContextTarget): Effect<EncodedContext, DeliveryError>;
}
```

A wrapper can emit the encoded context through a supported hook, MCP tool, fresh-session prompt, or handoff artifact. The adapter does not forge provider session stores.

### Context session

A context session binds:

- Chatlog context-session ID
- provider-native session ID when available
- provider, harness, model, and role
- project identity, cwd, domain policy, and path
- pinned insight and evidence projection hashes
- selection and delivery policy versions
- total and remaining context budgets

The context-session ID is a correlation capability. It is not authentication against a malicious local client.

### Intervention and outcome events

Write provider-neutral context events through the canonical event store from Plan 001. Build SQLite views for fast queries.

These context-plane events use `origin.kind: "chatlog"` with processor, recipe, input event IDs, and input hashes. Do not synthesize observed-source provenance.

Distinguish these states:

- proposed
- rendered
- emitted
- acknowledged, only when the provider reports it
- recalled
- feedback asserted
- outcome observed

Never infer “used” from “returned” or from an agent statement.

## Context bundle

Each item must include:

- item kind: evidence, insight, procedure, or current state
- stable source ID and evidence references
- selection reason and score components
- scope and valid time
- authority and advisory status
- token or character estimate
- omissions and truncation

The bundle must include the full provider encoding overhead in its final budget.

## Commands

| Purpose            | Command                                                                                          | Expected result                   |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------- |
| Planner tests      | `bun test test/context-planner.test.ts`                                                          | Exit 0                            |
| Delivery tests     | `bun test test/context-delivery.test.ts test/experience-memory-hook.test.ts test/bridge.test.ts` | Exit 0                            |
| Intervention tests | `bun test test/intervention-ledger.test.ts test/context-outcomes.test.ts`                        | Exit 0                            |
| Closed-loop gate   | `bun run gate:verify -- <evaluation-artifact>`                                                   | Exit 0 only for a valid keep gate |
| MCP tests          | `bun test test/mcp.test.ts`                                                                      | Exit 0                            |
| Workbench tests    | `bun test test/workbench.test.ts test/memory-lab.test.ts`                                        | Exit 0                            |
| Full gate          | `bun run check`                                                                                  | Exit 0                            |

## Scope

**In scope**

- Create `src/context-planner.ts`.
- Create `src/context-policy.ts`.
- Create `src/context-session.ts`.
- Create `src/context-events.ts` or add context events to `src/events.ts`.
- Create `src/delivery-adapters/` with shared, Claude, Codex, Pi, and prompt-bundle adapters.
- Change the startup hook, experience-memory MCP, MCP server/data, and bridge.
- Add an explicit feedback MCP or CLI command.
- Add intervention and outcome read projections.
- Add Workbench read-only inspection of context sessions, interventions, and linked outcomes.
- Update plugin manifests and generated plugin scripts through the existing build command.
- Create `scripts/verify-closed-loop-gate.ts` and add `gate:verify` to `package.json`.
- Update `docs/access-policy.md`, `docs/mcp-tool-shape.md`, `docs/cross-harness-continuity-findings.md`, `design-specs/experience-memory.md`, and `README.md` after tests pass.

**Out of scope**

- Autonomous claim activation or retirement.
- Native provider-store mutation.
- Hidden token-level interruption.
- A blocking advisor.
- Personal or psychological profile injection.
- Causal claims from observational correlation alone.
- Public network services or hosted telemetry.

## Git workflow

- Use branch `advisor/005-context-intervention-loop` in an isolated worktree.
- Separate planner, delivery, ledger, feedback, and Workbench commits.
- Do not install plugins globally or start hosted experiments without operator authority.

## Steps

### Step 1: Add failing semantic-boundary tests

Create tests for these statements:

1. A proposed bundle is not a delivered intervention.
2. A rendered bundle is not provider acknowledgment.
3. A returned memory card is not proof that the agent used it.
4. An agent success statement is not a gate observation.
5. A human correction is a human assertion with stronger authority than agent self-report.
6. A context item outside the current scope is rejected with a reason.
7. A high-risk inferred preference remains in shadow mode.
8. A session stays pinned to its initial context versions.
9. An outcome links to the intervention lineage without claiming causation.
10. Post-intervention evidence cannot independently reinforce the same claim.

**Verify**: focused tests fail before implementation.

### Step 2: Define the context request and bundle

`ContextRequest` must include:

- task or query
- context-session identity
- provider capabilities
- project and domain scope
- allowed item kinds
- risk ceiling
- freshness requirement
- token, result, latency, and cost budgets
- requested delivery mode

`ContextBundle` must be deterministic for the same inputs, policy, and indexes. It must carry an input hash and policy hash.

Selection can use lexical, semantic, temporal, and procedure-specific retrieval. Scores remain explanation data, not truth.

**Verify**: deterministic, stale, scope, domain, and budget tests exit 0.

### Step 3: Centralize scope and budget policy

Replace edge-only clamps with one core policy.

Scope checks must cover:

- domain allow-list
- user and organization identity when the active policy supplies them
- project identity
- repository and path
- harness and model
- tool or task trigger
- global entries that are explicitly global

Budget checks must cover:

- selected items
- fixed startup or tool instructions
- provider encoding
- evidence excerpts
- Tier 2 cards
- nested recall allowance reserved for later use

Every rejection must return a typed reason. Do not broaden scope when metadata is absent.

**Verify**: direct library, CLI, MCP, hook, and Workbench callers observe the same hard bounds.

### Step 4: Add provider capability and delivery adapters

Capabilities must declare:

- startup hook support
- MCP or tool support
- fresh-session prompt support
- checkpoint support
- acknowledgment support
- context-size constraints
- supported receipt evidence

Implement these delivery modes:

- Claude and Codex startup routing index through the existing shared hook contract
- cooperative MCP recall
- Pi fresh-session summary artifact
- provider-neutral prompt bundle for targets without a hook

Keep Pi history reconstruction experimental. Do not add Codex or Claude native-store emitters.

The adapter renders. Operator or harness authority performs external launch actions.

**Verify**: each adapter has snapshot tests for semantics, plus runtime tests where an installed local validator exists.

### Release gate: progress through exposure stages

Steps 1 through 4 produce shadow bundles only. They do not emit new context to a live agent.

Before Step 5 enables evidence-only recall, record a passed shadow review for relevance, staleness, scope, and harmful context.

Steps 5 through 9 remain evidence-only. Keep active insights and procedures disabled outside controlled evaluation.

Before Step 10 tests limited insight injection, record a passed evidence-only gate for scope, budget, attribution, and outcome linkage.

Step 10 runs limited insight injection as a controlled treatment. Record its paired utility gate before any broader enablement.

### Step 5: Bind startup and recall to a context session

The startup hook must create or load one context-session record. Emit its opaque ID with the pinned snapshot.

Change recall so it receives the context-session ID and requested memory or query. The tool must evaluate active scope and remaining budget before returning content.

Return a policy receipt with:

- effective scope
- projection and ledger hashes
- selected IDs
- denied IDs and reason codes
- emitted content hash
- budget before and after
- provider/harness target
- event ID for the recall receipt

Remove the exact-hash-only recall path in one cutover after all plugin callers migrate. Do not leave an alias.

Session binding adds correlation, scope, and budget enforcement. It is not authentication.

**Verify**: wrong session, project, harness, domain, expired insight, and exhausted budget all fail closed.

### Step 6: Write intervention events

Use canonical event storage for:

- bundle proposed in shadow mode
- bundle rendered
- bundle emitted
- provider acknowledgment when available
- card or evidence returned
- delivery failure

Store IDs, hashes, policy, bounds, and provenance. Avoid duplicate full text when a content-addressed bundle already owns it.

Every write must be idempotent. A retry must not create a second logical intervention.

**Verify**: replay and retry tests produce one intervention lineage.

### Step 7: Add explicit feedback

Add a bounded feedback command for:

- helpful
- harmful
- stale
- mis-scoped
- irrelevant
- incorrect

Record actor, session, intervention, item ID, signal, optional note, and time.

Distinguish human feedback from agent feedback. Agent feedback is a weak assertion. It cannot change active state.

Feedback affects only a future review or evaluation. It never changes the active session.

**Verify**: MCP and CLI tests prove exact binding, bounds, actor type, and no direct ledger mutation.

### Step 8: Link later outcomes

When provider sessions are ingested, correlate their native session IDs with context sessions.

Derive or record these outcome observations when available:

- task completion
- gate pass or failure
- user correction
- tool error or retry
- re-derivation markers
- wall-clock duration
- tool calls
- tokens and cost
- final unresolved state

Keep evidence grades explicit. A heuristic derived outcome remains a heuristic observation.

Write an association between outcome and intervention. Do not label the association causal.

**Verify**: synthetic sessions cover no-memory control, evidence-only, insight, and procedure treatments.

### Step 9: Detect self-confirming evidence

Every event observed after an intervention must carry that intervention lineage when known.

An insight cannot gain independent support from descendant evidence that only repeats its injected proposition.

Add metrics for:

- support from pre-intervention evidence
- support from independent post-intervention observation
- support from agent repetition only
- user correction after injection
- self-confirmation rate

**Verify**: a fixture in which the agent repeats an injected false preference does not increase independent confidence.

### Step 10: Add shadow and crossover evaluation

Support these treatment arms:

- no memory
- raw evidence retrieval
- active insight retrieval
- insight plus procedure
- reflective model, shadow only until approved

Reuse `agent-eval/promotion-v1` measurements. Add exact intervention IDs and context hashes.

The keep gate requires:

- no gate regression
- no increase in user correction burden
- improved re-derivation, tokens-to-gate, or another predeclared task metric
- no harmful scope or stale-context finding

A failed gate produces a reviewed revise, retire, or stop proposal. It does not mutate the insight ledger.

**Verify**: `bun run gate:verify -- <evaluation-artifact>` covers keep, revise, retire, inconclusive, and invalid states.

### Step 11: Add operator inspection

Workbench can display:

- context session
- proposed and delivered bundles
- selected reasons
- budgets and omissions
- feedback
- linked outcomes
- evidence grade
- evaluation status

Keep this surface read-only except for the existing explicit review and feedback commands. Do not add background provider calls.

**Verify**: browser behavior tests prove bounded content, inert untrusted text, domain filtering, and no mutation on page load.

### Step 12: Update provider documentation

Update MCP documentation to list the live tools. Document context-session binding, receipts, feedback authority, and limitations.

State which targets support emission, acknowledgment, or prompt artifacts. Do not claim that emitted context was used.

**Verify**: run plugin builds and validators through `bun run check`, then `nix flake check --offline`.

## Test plan

Use existing patterns from:

- `test/experience-memory-hook.test.ts`
- `test/mcp.test.ts`
- `test/bridge.test.ts`
- `test/effectiveness-ranking.test.ts`
- `test/workbench.test.ts`

Add deterministic fake provider capabilities. Do not call hosted providers in permanent tests.

## Done criteria

- [x] Every context proposal, rendering, emission, recall, and failure has a typed event.
- [x] Recall evaluates session, scope, domain, freshness, and budget.
- [x] Provider delivery uses one target-neutral bundle and capability contract.
- [x] Every returned context item has selection and policy provenance.
- [x] Feedback is actor-typed and cannot mutate current memory directly.
- [x] Outcomes link to intervention lineage with an evidence grade.
- [x] Self-repetition cannot count as independent reinforcement.
- [x] Shadow and crossover evaluations produce source-bound recommendations.
- [x] Shadow, evidence-only, and limited-injection stage reviews pass before the next exposure stage starts.
- [x] `bun run gate:verify -- <evaluation-artifact>` validates the limited-injection keep gate.
- [x] No provider-native store is forged.
- [x] `bun run check` exits 0.
- [x] `plans/README.md` marks Plan 005 `DONE`.

## STOP conditions

Stop and report if:

- Plans 001 or 004 do not provide active, source-bound event and insight state.
- A provider integration cannot distinguish rendered from emitted context.
- A target requires direct mutation of a private provider session store.
- Scope enforcement requires silently defaulting missing project, domain, or harness data.
- Outcome linkage is reported as causal without a controlled comparison.
- Feedback modifies an active snapshot or bypasses human authority.
- Plugin installation or hosted evaluation lacks operator authority.

## Maintenance notes

The intervention ledger is the evidence source for future personalization policy. Keep it complete and semantically honest.

A new delivery adapter must declare capabilities and receipt evidence. It cannot add prompt strings directly beside the planner.
