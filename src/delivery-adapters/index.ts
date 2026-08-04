import type { ContextDeliveryMode, ContextTarget } from "../context-types";
import { createClaudeDeliveryAdapter } from "./claude";
import { createCodexDeliveryAdapter } from "./codex";
import { createOmpDeliveryAdapter } from "./omp";
import { createPiDeliveryAdapter } from "./pi";
import { createPromptBundleAdapter } from "./prompt-bundle";
import { targetMatches } from "./shared";
import type { DeliveryAdapter, DeliverySelectionResult } from "./types";

export * from "./types";
export * from "./shared";
export * from "./claude";
export * from "./codex";
export * from "./omp";
export * from "./pi";
export * from "./prompt-bundle";

const CLAUDE = createClaudeDeliveryAdapter();
const CODEX = createCodexDeliveryAdapter();
const OMP = createOmpDeliveryAdapter();
const PI = createPiDeliveryAdapter();
const PROMPT_BUNDLE = createPromptBundleAdapter();

function unsupportedTarget(
  target: ContextTarget,
  mode: ContextDeliveryMode,
): DeliverySelectionResult {
  return {
    ok: false,
    error: {
      code: "unsupported-target",
      message: `no delivery adapter supports ${target.provider}/${target.harness} in ${mode} mode`,
    },
  };
}

/** Select an immutable adapter without rendering or emitting anything. */
export function selectDeliveryAdapter(
  target: ContextTarget,
  mode: ContextDeliveryMode,
): DeliverySelectionResult {
  const provider = target.provider.trim();
  const harness = target.harness.trim();
  const role = target.role.trim();
  if (!provider || !harness || !role) {
    return {
      ok: false,
      error: {
        code: "unsupported-target",
        message: "delivery target provider, harness, and role are required",
      },
    };
  }

  if (mode === "prompt-bundle") return { ok: true, value: PROMPT_BUNDLE };
  if (mode === "fresh-session-prompt") {
    if (target.harness.trim().toLowerCase() === "omp") return { ok: true, value: OMP };
    if (target.harness.trim().toLowerCase() === "pi") return { ok: true, value: PI };
    if (targetMatches(target, ["anthropic", "claude"], ["claude", "claude-code"]))
      return { ok: true, value: CLAUDE };
    if (targetMatches(target, ["openai", "codex"], ["codex", "codex-cli"]))
      return { ok: true, value: CODEX };
    return unsupportedTarget(target, mode);
  }
  if (mode === "startup-hook") {
    if (targetMatches(target, ["anthropic", "claude"], ["claude", "claude-code"]))
      return { ok: true, value: CLAUDE };
    if (targetMatches(target, ["openai", "codex"], ["codex", "codex-cli"]))
      return { ok: true, value: CODEX };
    return unsupportedTarget(target, mode);
  }
  if (mode === "tool-recall") {
    if (targetMatches(target, ["anthropic", "claude"], ["claude", "claude-code"]))
      return { ok: true, value: CLAUDE };
    if (targetMatches(target, ["openai", "codex"], ["codex", "codex-cli"]))
      return { ok: true, value: CODEX };
    return unsupportedTarget(target, mode);
  }

  return {
    ok: false,
    error: {
      code: "unsupported-mode",
      message: `delivery mode ${String(mode)} is unsupported`,
    },
  };
}

export type { DeliveryAdapter };
