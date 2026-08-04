#!/usr/bin/env bun
import { readBoundedInputText } from "./bounded-input";
import { startContextPlaneSession } from "./context-plane";
import { resolvePluginDataRoot } from "./data-root";
import { canonicalRecallPath } from "./recall-budget";
import { projectOf } from "./project-identity";

export const SESSION_START_INPUT_MAX_BYTES = 64 * 1024;

interface SessionStartInput {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  source?: unknown;
  provider?: unknown;
  harness?: unknown;
  model?: unknown;
  role?: unknown;
  domain?: unknown;
}

async function readInput(): Promise<SessionStartInput | undefined> {
  try {
    const bounded = await readBoundedInputText(
      Bun.stdin.stream(),
      SESSION_START_INPUT_MAX_BYTES,
      "Chatlog SessionStart input",
    );
    if (!bounded.ok) {
      process.stderr.write(`${bounded.error.message}\n`);
      return undefined;
    }
    const input: unknown = JSON.parse(bounded.value);
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as SessionStartInput)
      : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function authoritativeTarget(
  input: SessionStartInput,
): { provider: string; harness: string; model: string; role: string } | undefined {
  const provider = nonEmptyText(input.provider);
  const harness = nonEmptyText(input.harness);
  const model = nonEmptyText(input.model);
  if (!provider || !harness || !model) return undefined;
  const normalizedProvider = provider.toLowerCase();
  const normalizedHarness = harness.toLowerCase();
  const claude =
    ["anthropic", "claude"].includes(normalizedProvider) &&
    ["claude", "claude-code"].includes(normalizedHarness);
  const codex =
    ["openai", "codex"].includes(normalizedProvider) &&
    ["codex", "codex-cli"].includes(normalizedHarness);
  if (!claude && !codex) return undefined;
  return {
    provider,
    harness,
    model,
    role: nonEmptyText(input.role) ?? "coding-agent",
  };
}

async function main(): Promise<void> {
  const input = await readInput();
  if (
    input?.hook_event_name !== "SessionStart" ||
    input.source !== "startup" ||
    typeof input.session_id !== "string" ||
    typeof input.cwd !== "string"
  )
    return;
  const target = authoritativeTarget(input);
  if (!target) return;

  const resolvedRoot = resolvePluginDataRoot(input.cwd);
  if (!resolvedRoot.ok) {
    process.stderr.write(`Chatlog session start refused: ${resolvedRoot.error.message}\n`);
    return;
  }
  const root = resolvedRoot.value;
  const canonicalCwd = canonicalRecallPath(input.cwd);
  if (canonicalCwd === undefined) {
    process.stderr.write("Chatlog session start refused: cwd must be an absolute canonical path\n");
    return;
  }
  const configuredPath = process.env.CHATLOG_CONTEXT_PATH?.trim();
  const contextPath = canonicalRecallPath(configuredPath ?? canonicalCwd);
  if (contextPath === undefined) {
    process.stderr.write(
      "Chatlog session start refused: CHATLOG_CONTEXT_PATH must be an absolute canonical path\n",
    );
    return;
  }
  const projectIdentity = projectOf(input.cwd);

  const domain =
    nonEmptyText(input.domain) ??
    process.env.CHATLOG_DOMAIN?.trim() ??
    process.env.CHATLOG_DOMAINS?.split(",")[0]?.trim() ??
    "coding";
  const started = await startContextPlaneSession(root, {
    nativeSessionId: input.session_id,
    target,
    projectIdentity,
    cwd: canonicalCwd,
    domainPolicy: [domain],
    path: contextPath,
    totalBudget: {
      tokens: Number(process.env.CHATLOG_CONTEXT_TOKENS ?? 2_000),
      results: Number(process.env.CHATLOG_CONTEXT_RESULTS ?? 4),
      latencyMs: Number(process.env.CHATLOG_CONTEXT_LATENCY_MS ?? 250),
      costUsd: Number(process.env.CHATLOG_CONTEXT_COST_USD ?? 0),
    },
  });
  if (!started.ok) {
    process.stderr.write(`Chatlog session start refused: ${started.error.message}\n`);
    return;
  }

  const context = [
    "Chatlog context session bound to this startup.",
    `contextSessionId=${started.value.contextSessionId}`,
    `nativeSessionId=${input.session_id}`,
    `provider=${target.provider}`,
    `harness=${target.harness}`,
    `model=${target.model}`,
    "Use chatlog_context with this contextSessionId for operator-authorized task context.",
    "Use chatlog_bounded_recall with this contextSessionId for finite follow-up recall.",
  ].join("\n");
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })}\n`,
  );
}

await main();
