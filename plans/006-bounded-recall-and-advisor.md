# Plan 006: Add bounded recall and shadow supervision

> **Executor instructions**: Do not start this plan because the roadmap reached it. Start only after Plan 005 records a positive closed-loop gate. Run each verification command.
>
> **Drift check**: Run `git diff --stat 8ddee39..HEAD -- src/context* src/events.ts src/insights.ts src/mcp src/role-segmentation.ts src/orchestration-profile.ts test docs`. Confirm that Plan 005's intervention and outcome contracts are live.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/005-context-intervention-loop.md` and a positive measured gate
- **Category**: direction
- **Planned at**: commit `8ddee39`, 2026-08-03

## Why this matters

One broad search cannot serve episodic, semantic, procedural, temporal, and contradiction recall equally well. Multiple retrieval branches can improve coverage.

Unbounded recursive recall can grow without progress, duplicate tool effects, and hide causal context. Supervision can also become a second agent that argues forever.

This plan adds bounded cooperative recall first. It adds advisor output in shadow mode only.

## Current state

- MCP recall returns one exact accepted card by snapshot hash and ID.
- Agent search and ask functions provide lexical, semantic, structural, temporal, and project views through separate calls.
- Edge surfaces clamp many limits, but the core has no shared recall budget or termination record.
- `src/role-segmentation.ts` and `src/orchestration-profile.ts` derive advisor-like roles and guardrails from history. They do not control live execution.
- The shared conversation proposes recall as a resumable effect with strictly decreasing depth, branches, queries, tokens, latency, and cost.
- Plan 005 adds context sessions, intervention events, feedback, and outcome linkage. This plan must reuse them.

Preserve cooperative recall as the default. A hidden advisor cannot inject learned claims into a main agent.

## Implementation decision

The operator authorized implementation on 2026-08-03 after a review of current project evidence.
No persistent paired gate artifact from real work was available.

`test/closed-loop-gate.test.ts` and `test/context-gate-fixture.ts` verify the gate mechanics with synthetic evidence.
They do not prove product benefit.

This exception authorizes the bounded recall implementation and the shadow advisor.
A positive measured gate remains required before broader exposure or blocking authority.

## Recall interface

```ts
interface RecallRuntime {
  recall(request: RecallRequest): Effect<RecallResult, RecallError>;
}

interface RecallBudget {
  maxDepth: number;
  maxBranches: number;
  maxQueries: number;
  maxResults: number;
  maxTokens: number;
  maxLatencyMs: number;
  maxCost: number;
}
```

Every child budget must have `maxDepth` strictly less than its parent. No other field can exceed its parent value.

`maxDepth` is the well-founded termination dimension. Real-valued latency and cost budgets can tighten, but they cannot prove termination.

Recall branches can target:

- episodic evidence
- semantic facts and decisions
- procedures
- current temporal state
- contradiction and counterevidence
- analogical prior cases

Many branches produce one consolidated result. The parent computation resumes once.

## Recall result

Return a finite structured value:

```ts
interface RecallResult {
  answer?: string;
  evidence: readonly EvidenceItem[];
  insights: readonly InsightItem[];
  procedures: readonly ProcedureReference[];
  contradictions: readonly Contradiction[];
  unresolved: readonly string[];
  confidence: readonly ConfidenceAssessment[];
  trace: RecallTrace;
}
```

The trace must report branches, queries, depth, budgets, cancellation, novelty, and termination reason.

Required termination reasons:

- sufficient evidence
- stable result
- no novelty
- budget exhausted
- timeout
- unresolved contradiction
- cancelled parent
- scope closed

## Advisor boundary

The advisor observes explicit checkpoints. It does not interrupt arbitrary token generation.

Checkpoints can include:

- before a tool call
- before a material mutation
- after a failure
- before a commit or deployment
- before a final answer

Advisor actions:

- continue
- annotate
- request reconsideration
- recommend escalation

In this plan, the advisor cannot block, abort, recover, or mutate. Those actions require separate operator approval and enforced policy integration.

## Commands

| Purpose           | Command                                                   | Expected result |
| ----------------- | --------------------------------------------------------- | --------------- |
| Budget tests      | `bun test test/recall-budget.test.ts`                     | Exit 0          |
| Runtime tests     | `bun test test/recall-runtime.test.ts`                    | Exit 0          |
| Procedure tests   | `bun test test/procedure-transfer.test.ts`                | Exit 0          |
| Advisor tests     | `bun test test/advisor-shadow.test.ts`                    | Exit 0          |
| MCP tests         | `bun test test/mcp.test.ts test/context-outcomes.test.ts` | Exit 0          |
| Prerequisite gate | `bun run gate:verify -- <evaluation-artifact>`            | Exit 0          |
| Full gate         | `bun run check`                                           | Exit 0          |

## Scope

**In scope**

- Create `src/recall-runtime.ts`.
- Create `src/recall-budget.ts`.
- Create `src/recall-consolidation.ts`.
- Create `src/procedure-memory.ts` for validated references and preconditions.
- Create `src/advisor-protocol.ts` for shadow checkpoints and advice.
- Change context planner, context policy, MCP, and delivery adapters.
- Add recall, advisor, procedure, and outcome event kinds.
- Add read-only Workbench traces for recall and shadow advice.
- Add synthetic cross-provider transfer evaluations.
- Update the memory and MCP docs after behavior passes.

Events authored by recall, procedure, and advisor modules use `origin.kind: "chatlog"`. Do not synthesize provider-source provenance.

**Out of scope**

- Multi-shot main-agent continuations.
- Tool effects in speculative branches.
- Advisor blocking or aborting.
- Advisor self-supervision in the same intervention.
- Autonomous policy changes.
- Recursive model calls without a decreasing budget.
- Automatic skill file edits.

## Git workflow

- Use branch `advisor/006-bounded-recall` in an isolated worktree.
- Commit budget/runtime, procedure transfer, and shadow advisor separately.
- Do not enable provider-level supervision or hosted experiments without operator authority.

## Steps

### Step 1: Prove the prerequisite gate

Read the exact Plan 005 evaluation artifact.

The prerequisite passes only when:

- task gate did not regress
- correction burden did not increase
- one predeclared utility measure improved
- no harmful scope or stale-context result occurred
- intervention and outcome receipts validate

Record the artifact hash in the Plan 006 implementation branch.

**Verify**: `bun run gate:verify -- <evaluation-artifact>` exits 0. Stop if the artifact is missing, inconclusive, negative, or invalid.

### Step 2: Add failing budget and termination tests

Tests must cover:

- zero budget
- one branch
- maximum branches
- child budget reduction
- repeated query cycle
- duplicate evidence through different indexes
- no novelty
- stable result
- unresolved contradiction
- timeout
- parent cancellation
- scope closure
- provider error in one branch
- all branches failing

No test can use real time without a controlled fake clock.

**Verify**: tests fail before implementation.

### Step 3: Implement the graded recall budget

Budget consumption must be atomic within one context session.

A child request inherits scope, policy, lineage, and reduced totals. It cannot widen domain, project, provider, or item permissions.

Reject:

- child `maxDepth` that is equal to or greater than the parent
- negative or non-finite values
- branch count beyond the parent
- duplicate active query lineage
- recall after the parent scope closes

Return consumed and remaining budget in every trace.

**Verify**: `bun test test/recall-budget.test.ts` exits 0.

### Step 4: Implement structured retrieval branches

Use Effect structured concurrency. The parent owns all child fibers.

Rules:

- The parent opens one recall scope.
- It starts at most the allowed branch count.
- Each branch has its own reduced budget and deadline.
- Cancellation propagates from parent to children.
- The parent does not return while a child remains live.
- A failed branch returns typed evidence. It does not crash unrelated branches.
- No branch can write files, call tools, or change provider state.

Record branch lifecycle as context events.

**Verify**: runtime tests prove child release and cancellation. No process or fiber survives the test.

### Step 5: Add cycle, novelty, and stability checks

Track:

- query ancestry
- normalized query identity
- visited evidence IDs
- visited insight revisions
- prior consolidation hashes

A new round must add new evidence, reduce unresolved uncertainty, or resolve a contradiction. Otherwise it stops.

Do not use vector distance alone for cycle identity. Combine normalized query intent and visited evidence.

**Verify**: cyclic project-person-project fixtures stop with `no-novelty` before budget exhaustion.

### Step 6: Consolidate to one bounded result

The consolidator must preserve:

- evidence references
- scope and valid time
- support and counterevidence
- authority
- disagreements between branches
- omissions and truncation
- exact termination reason

It can summarize, but summary text cannot replace the evidence list.

The result has one content hash. The main continuation receives it once.

**Verify**: order-independent branch completion produces the same deterministic result.

### Step 7: Add procedure memory as references

A procedure entry must reference an authoritative versioned procedure, such as a reviewed skill, runbook, or repository command contract.

Store:

- procedure ID and version
- trigger and preconditions
- scope and environment
- ordered actions
- success and failure observations
- required authority
- evidence and evaluation hashes

Do not copy a complete external skill into the insight ledger. Use a pointer and compact routing text.

A procedure cannot run itself. Recall returns it to the main agent as advisory context.

**Verify**: procedure tests cover valid preconditions, wrong repository, wrong harness, stale version, missing authority, and failed prior outcome.

### Step 8: Measure cross-provider procedural transfer

Create equivalent tasks where one harness produces a reviewed procedure and another harness later recalls it.

Measure:

- gate pass
- correct precondition recognition
- repeated exploration
- tool calls
- tokens and latency
- correction burden
- environment-specific mistakes

Use no-memory, evidence-only, and procedure arms. Predeclare the scoring rule.

A negative or inconclusive result does not enable broader recall.

**Verify**: synthetic evaluation fixtures cover keep, adapt, and reject results.

### Step 9: Add shadow advisor checkpoints

Define a typed checkpoint and advice protocol.

The advisor receives:

- checkpoint kind
- proposed action hash
- active policy references
- bounded recall budget
- current context session

It can return `continue`, `annotate`, `reconsider`, or `escalate`.

Every advice result writes an intervention event and stop reason. The main agent remains free to ignore advice in shadow mode.

Advice must identify its basis:

- evidence
- active insight
- enforced policy reference
- assumption

**Verify**: advisor tests prove no block, abort, tool call, mutation, or recursive self-supervision occurs.

### Step 10: Add advisor progress and termination rules

Each intervention must do one of these actions:

- permit continuation
- add new bounded evidence
- request a specifically changed plan
- recommend escalation
- terminate its own advisory scope

“Think more” is invalid advice.

Use a separate intervention budget:

- maximum interruptions
- maximum recall queries
- maximum replan requests
- maximum added tokens
- deadline

**Verify**: repeated identical reconsideration stops with `no-novelty` or budget exhaustion.

### Step 11: Expose traces without exposing private context

Workbench can show:

- recall branches and termination
- consumed budget
- selected evidence IDs
- contradiction state
- procedure version
- advisor checkpoint and action
- linked outcome

Keep content bounded and domain-filtered. Avoid full transcript or private reasoning display.

**Verify**: Workbench tests prove bounds, scope, and inert rendering.

### Step 12: Document the operational boundary

Document:

- cooperative recall as the default
- strict budget inheritance
- one resumed main continuation
- no speculative effects
- advisor shadow authority
- the separate operator gate for future blocking behavior

**Verify**: run `bun run check` and `nix flake check --offline`.

## Test plan

Use deterministic fake retrieval adapters and a fake clock. Include randomized branch completion order without real concurrency timing.

Each test must assert termination, result provenance, budget consumption, or an invalid transition. Do not assert internal fiber implementation.

## Done criteria

- [x] Every recall has a parent context session and finite budget.
- [x] Every child decreases `maxDepth`, keeps other hard totals at or below the parent, and cannot widen scope.
- [x] All branches join or cancel before the parent returns.
- [x] Cycle, novelty, stability, timeout, contradiction, and cancellation exits are observable.
- [x] The main continuation receives one bounded result.
- [x] Procedures retain preconditions, authority, version, evidence, and evaluation.
- [x] Cross-provider procedure transfer has controlled evaluation evidence.
- [x] Advisor behavior remains shadow-only and cannot block or mutate.
- [x] `bun run check` exits 0.
- [x] `plans/README.md` marks Plan 006 `DONE`.

## STOP conditions

Stop and report if:

- Plan 005 has no positive, source-bound closed-loop gate.
- A recall branch needs tool or filesystem effects.
- A child budget can equal or exceed its parent.
- A provider cannot identify the parent context session.
- Procedure transfer requires copying or mutating an authoritative skill.
- Advisor behavior blocks, aborts, deploys, commits, or changes policy.
- Evaluation requires hosted calls without operator authority.

## Maintenance notes

Do not enable blocking supervision as a small follow-up. It changes authority and requires a separate design decision.

Keep recall branches pure and finite. Keep the main continuation single-shot.
