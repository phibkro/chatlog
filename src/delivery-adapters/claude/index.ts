import type {
  ContextBundle,
  ContextReceiptEvidence,
  ContextTarget,
  ProviderContextCapabilities,
} from "../../context-types";
import {
  createDeliveryAdapter,
  renderPromptBundle,
  renderStartupHook,
  renderToolRecall,
  targetMatches,
  type DeliveryAdapterConfig,
} from "../shared";
import type { DeliveryAdapter } from "../types";

export const CLAUDE_ADAPTER_ID = "claude" as const;
export const CLAUDE_ADAPTER_VERSION = "1" as const;
const CLAUDE_RECEIPT_EVIDENCE: ContextReceiptEvidence[] = [
  "hook-output",
  "tool-result",
  "prompt-artifact",
];
Object.freeze(CLAUDE_RECEIPT_EVIDENCE);

export const CLAUDE_CONTEXT_CAPABILITIES: Readonly<ProviderContextCapabilities> = Object.freeze({
  startupHook: true,
  toolRecall: true,
  freshSessionPrompt: true,
  checkpoint: false,
  acknowledgment: false,
  maximumContextTokens: 200_000,
  encodingOverheadTokens: 32,
  receiptEvidence: CLAUDE_RECEIPT_EVIDENCE,
});

const CONFIG: DeliveryAdapterConfig = {
  id: CLAUDE_ADAPTER_ID,
  version: CLAUDE_ADAPTER_VERSION,
  capabilities: CLAUDE_CONTEXT_CAPABILITIES,
  supportedModes: ["startup-hook", "tool-recall", "fresh-session-prompt"],
  matchesTarget: (target: ContextTarget): boolean =>
    targetMatches(target, ["anthropic", "claude"], ["claude", "claude-code"]),
  encode: (bundle: ContextBundle): string => {
    if (bundle.deliveryMode === "startup-hook") return renderStartupHook(bundle);
    if (bundle.deliveryMode === "tool-recall") return renderToolRecall(bundle);
    return renderPromptBundle(bundle);
  },
};

export function createClaudeDeliveryAdapter(): DeliveryAdapter {
  return createDeliveryAdapter(CONFIG);
}

export const createClaudeAdapter = createClaudeDeliveryAdapter;
