import { openContextSession } from "../src/context-session";
import type { ContextSession } from "../src/context-types";

export async function openTestContextSession(
  root: string,
  nonce: string,
  nativeSessionId: string | null = null,
): Promise<ContextSession> {
  const opened = await openContextSession(root, {
    nativeSessionId,
    ...(nativeSessionId === null ? { sessionNonce: nonce } : {}),
    provider: "openai",
    harness: "codex",
    model: "test-model",
    role: "coding-agent",
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: null,
    pinnedInsightProjectionHash: "a".repeat(64),
    pinnedEvidenceProjectionHash: "b".repeat(64),
    selectionPolicyVersion: "test-selection-v1",
    deliveryPolicyVersion: "test-delivery-v1",
    totalBudget: { tokens: 10_000, results: 64, latencyMs: 10_000, costUsd: 10 },
    createdAt: "2026-08-04T00:00:00.000Z",
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}
