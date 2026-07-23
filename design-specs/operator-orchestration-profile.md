# Design-spec: operator orchestration profile

Status: **FROZEN — slice 1 authorized** (operator 2026-07-23, lens confirmed).
Slices 2–4 remain draft. Revise the spec explicitly if a build learning forces
it; never drift silently.

Author lane: chatlog. Companion prior art: `docs/operator-preference-profile.md`
(the hand-authored prototype this spec automates and extends).

---

## The one felt outcome

Run one command against the local corpus and get back **an evidence-cited map of
where the operator places deterministic guardrails and how much agent
non-determinism they permit inside them** — per agent-role — plus a first
characterization of the operator's lean on the **autonomy ↔ determinism** axis.
That map is the input to designing the ideal orchestration layer.

The operator's thesis is the spine of the analysis:

> Agent orchestration is harnessing the power of non-determinism inside
> deterministic guardrails.

So the deliverable is **not** a scalar "autonomy vs determinism" score. It is a
**decision boundary**: *grants autonomy WHEN ⟨context⟩ · imposes determinism
WHEN ⟨context⟩*, with the guardrail placement made explicit. Autonomy and
determinism are represented by two analytical poles the operator named — **Flue**
(agent self-propelling non-determinism) and **Mastra** (deterministic
workflow/guardrails) — used here only to *characterize the operator's measured
lean*, NOT as a proposal to adopt Mastra into the spine (standing rule: Mastra
stays out of the spine).

## User journey

1. Operator runs `bun run query orchestration-profile` (name provisional).
2. Gets a bounded, evidence-cited report:
   - **The lean**: where the operator sits on autonomy↔determinism, as a
     boundary not a number — "in context C, autonomy latitude L within guardrail
     G", each claim citing `chatlog://` turn pointers.
   - **Per-role profiles**: the same boundary sliced by agent role
     (manager / worker / reviewer / advisor …) — because the operator grants a
     worker different latitude than a manager.
   - **Guardrail inventory**: the deterministic structures the operator
     repeatedly imposes (one-writer, spec-freeze, gate-before-act, A/B-with-
     recommendation, stop-and-report) and the *conditions* that trigger each.
   - **Autonomy inventory**: the latitudes the operator repeatedly grants
     (self-propel, tracer-bullet-and-continue, don't-wait-for-approval-in-lane,
     recommend-and-proceed) and their triggering conditions.
3. Every conclusion is falsifiable against the corpus and reads back to the
   operator's own sense — the operator can say "yes that's me" or "no" against
   cited evidence, not vibes.

## What it must produce (the missing output kinds)

chatlog today emits knowledge candidates (skill / gotcha / memory-or-adr /
claude-md) and a hand-written prose profile. This spec adds two output kinds:

| Output | Shape | Consumes |
|---|---|---|
| `orchestration-lean` | evidence-cited boundary doc: guardrail vs autonomy signals, per context | corpus + derive + new signal miners |
| `role-prompt-profile` | per-role prompting profile (defaults, latitudes, guardrails, model-routing) ranked by what measurably worked | above + role segmentation + eval harness |

## Goal / Constraints / Values

**Goal.** Turn the one-off hand-authored operator profile into a repeatable,
role-segmented, effectiveness-ranked derivation that reveals the operator's
orchestration decision boundary and feeds per-agent prompting profiles.

**Constraints** (inherited from chatlog, non-negotiable):
- **Zero-egress by default.** Hosted models only for bounded retrieval rerank
  (≤50 candidates, ≤600 redacted chars), never for raw-corpus synthesis egress.
  Any synthesis stage that calls a hosted model must declare its exact egress
  surface, same as `semantic`/`ask` do today.
- **Content-addressed + idempotent.** Outputs are derived artifacts keyed by
  input-projection hash; unchanged corpus → identical output.
- **Evidence-cited.** Every claim binds to `chatlog://` turn pointers. No
  assertion without a corpus referent (the operator-profile's E-ledger is the bar).
- **No auto-promotion.** Profiles are nominations for operator review, not
  applied config. Frequency is signal, not decision (existing refinery policy).
- **Mutable, not fossilized.** Model names and routing are time-sensitive; the
  artifact re-derives from fresh corpus and never hardcodes a model as eternal.
- **Build on existing infra.** Reuse derive/refinery/analytics/eval; do not
  build a parallel ML pipeline. One construct per problem.

**Values.** Measured over frequency (effectiveness ranking beats "says it a
lot"). Evidence over assertion. Single source of truth (the corpus; the profile
is a derivation with a traceable edge back to it).

## The hardest risk, attacked first (the tracer bullet)

The central unknown: **can the corpus actually distinguish an autonomy-grant from
a determinism-impose reliably enough to characterize a lean?** If that signal is
too noisy, every downstream artifact is built on sand. So slice 1 is exactly that
test, and it also *directly answers what the operator asked to see*:

**Slice 1 — the orchestration-lean tracer.** Mine both signal classes from the
existing corpus, produce ONE evidence-cited `orchestration-lean` document with
the decision boundary, no role segmentation yet. Falsifier below. This reuses
`query`/`derive`; it is essentially the operator-profile focused on the
autonomy/determinism boundary and made repeatable. **Ship this first — it tells
the operator their lean before any generation machinery is built.**

Then, in risk order:
- **Slice 2 — role segmentation.** Infer agent role per session (from launch
  prompt, label, project, harness) since the data model has model-per-session but
  no role. Prerequisite for per-role anything.
- **Slice 3 — effectiveness ranking.** Run the existing (unmeasured)
  `agent-eval/promotion-v1` control/treatment loop so profiles rank by what
  worked, not by frequency.
- **Slice 4 — `role-prompt-profile` output format.** Emit the per-role profiles;
  define the schema so it can later feed the live fleet (herdr-monitor config,
  model policy, launch prompts) — closing the generate-edge.

Each slice is 1:1 spec→code→PR, gated on its falsifier.

## Falsifiers / definition of done

| Capability | Falsifier that must fail before impl and pass before ship |
|---|---|
| lean signal validity | A hand-labelled sample of N corpus turns disagrees with the miner's autonomy-grant vs determinism-impose classification beyond an agreed error bar. |
| decision boundary | The boundary predicts the operator's actual choice (autonomy vs guardrail) on held-out conversations no better than the base rate. |
| evidence binding | Any conclusion lacks a resolvable `chatlog://` pointer, or a cited pointer does not support the claim. |
| zero-egress | A default run makes any hosted call beyond the declared bounded-rerank surface, or fails to report its egress. |
| idempotence | Two runs on an unchanged corpus produce different `orchestration-lean` content hashes. |
| role segmentation (S2) | A session's inferred role contradicts its launch prompt/label on a labelled sample beyond the error bar. |
| effectiveness (S3) | A profile recommendation ranks above an alternative that the eval harness shows produced worse gate-pass / more corrections / more tokens-to-gate. |
| no fossilization | The artifact hardcodes a model name as permanent rather than deriving it from the current corpus snapshot. |

## Explicit non-goals / deferrals

- **Not** adopting Mastra (or Flue) into the spine — they are analytical poles here.
- **Not** live/continuous ingestion — batch snapshot stays (scheduling deferred).
- **Not** auto-applying profiles to the live fleet — output is a reviewed
  nomination; wiring to herdr-monitor/model-policy is a later, separate spec.
- **Not** an ML/embedding pipeline — heuristic miners + the existing eval loop.
- **Not** a web/API-chat adapter — corpus stays the four local harnesses.

## Why this is the right first move

The expensive foundation already exists (corpus, redaction, derivation with
heuristic outcomes, frequency mining, analytics, an unrun A/B eval contract), and
the hand-authored operator-profile proves the corpus is rich enough. This spec's
slice 1 gives the operator the answer they asked for — their autonomy↔determinism
lean, evidence-backed — while proving the analytical foundation before investing
in the per-role generation machinery.
