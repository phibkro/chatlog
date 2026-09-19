<!-- generated-by: foundry@v1 -->

# AGENTS.md — project contract

Generated boilerplate from `homelab/foundry/profile-v1` (single source:
homelab/docs/PROJECTS.md, "Project conventions contract"). Hand edits here are
flagged as drift by `conventions-check`; record real divergences in
`.conventions-exceptions` instead.

## Contract

- **Mission state:** `STATE.md` is the single mission-state file. It declares a
  lifecycle — `idea | spec | spec-frozen | build | park | archive` — plus
  Now / Next / Blocked. Agents read it first; keep it current.
- **Agent doc:** this file is THE agent doc. Where a harness wants CLAUDE.md,
  it is a symlink to AGENTS.md. Never a second prose copy.
- **Specs:** design work lives in `docs/specs/`. Lifecycle ≥ spec requires
  that directory to exist.
- **Lifecycle gates:** idea → spec → spec-frozen → build → park → archive, one
  executable gate per transition (defined in the conventions contract).
  spec-frozen additionally requires `Frozen: yes` in STATE.md.
- **Checks:** `just check` = lint + format (+ typecheck/tests per toolchain);
  `just conventions-check` = conventions drift gate. Both green before merge.

## PROJECT-SPECIFIC (replace this section)

<!-- Everything above is generated boilerplate — regenerate, don't edit. -->

Chatlog is a local, provider-agnostic context layer for coding agents (Bun +
TypeScript; flake description: "local, redacted coding-session corpus,
Workbench, and MCP server"). It turns Claude Code, Codex, Pi, OMP, ChatGPT, and
Anthropic activity into portable evidence, governed insights, and bounded
context for later sessions.

- Runtime / package manager: Bun. Workspace membership is declared by
  [`package.json`](package.json); consult it when selecting package commands. Nix flake
  provides the package and dev shell (`nix build .#chatlog`,
  `nix run .#workbench`); direnv via `.envrc`.
- Build, typecheck, test entry points: `bun run check` is the full gate
  (format + lint + no-throw ratchet + typecheck + tests + builds).
  `bun test`; `bun run typecheck`; `bun run lint` / `lint:fix`;
  `bun run fmt` / `fmt:check`. CLI: `bun run src/cli.ts <command>`.
- What an agent must know that is unique to this repo:
  - `analysis/chatlog.sqlite` is LIVE operator data — never touch,
    checkpoint, or stop anything holding it; text/config changes only.
  - Evidence model: immutable redacted `EventBatch` at the `SourceAdapter`
    seam is canonical evidence; conversations are deterministic projections;
    `corpus/manifest.json` is the authority for active source mappings.
    Derived state must fail closed on any disagreement.
  - Privacy invariants: no raw unredacted provider payload is stored;
    reasoning/opaque events stay out of FTS, mining, and context delivery;
    source dirs are only read, never written; corpus files are mode 0600.
  - Insight promotion requires explicit human authority (Memory Lab
    adjudication bundles; separate preview-and-apply records the transition).
  - Specs are accessible at `docs/specs/`, a symlink to the existing
    `design-specs/` source directory; Workbench UI is under `apps/workbench-web`.
