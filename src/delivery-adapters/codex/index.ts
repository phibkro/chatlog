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

export const CODEX_ADAPTER_ID = "codex" as const;
export const CODEX_ADAPTER_VERSION = "1" as const;
const CODEX_RECEIPT_EVIDENCE: ContextReceiptEvidence[] = [
  "hook-output",
  "tool-result",
  "prompt-artifact",
];
Object.freeze(CODEX_RECEIPT_EVIDENCE);

export const CODEX_CONTEXT_CAPABILITIES: Readonly<ProviderContextCapabilities> = Object.freeze({
  startupHook: true,
  toolRecall: true,
  freshSessionPrompt: true,
  checkpoint: false,
  acknowledgment: false,
  maximumContextTokens: 200_000,
  encodingOverheadTokens: 28,
  receiptEvidence: CODEX_RECEIPT_EVIDENCE,
});

const CONFIG: DeliveryAdapterConfig = {
  id: CODEX_ADAPTER_ID,
  version: CODEX_ADAPTER_VERSION,
  capabilities: CODEX_CONTEXT_CAPABILITIES,
  supportedModes: ["startup-hook", "tool-recall", "fresh-session-prompt"],
  matchesTarget: (target: ContextTarget): boolean =>
    targetMatches(target, ["openai", "codex"], ["codex", "codex-cli"]),
  encode: (bundle: ContextBundle): string => {
    if (bundle.deliveryMode === "startup-hook") return renderStartupHook(bundle);
    if (bundle.deliveryMode === "tool-recall") return renderToolRecall(bundle);
    return renderPromptBundle(bundle);
  },
};

export function createCodexDeliveryAdapter(): DeliveryAdapter {
  return createDeliveryAdapter(CONFIG);
}

export const createCodexAdapter = createCodexDeliveryAdapter;
