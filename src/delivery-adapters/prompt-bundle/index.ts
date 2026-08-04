import type {
  ContextReceiptEvidence,
  ContextTarget,
  ProviderContextCapabilities,
} from "../../context-types";
import { createDeliveryAdapter, renderPromptBundle, type DeliveryAdapterConfig } from "../shared";
import type { DeliveryAdapter } from "../types";

export const PROMPT_BUNDLE_ADAPTER_ID = "prompt-bundle" as const;
export const PROMPT_BUNDLE_ADAPTER_VERSION = "1" as const;

const PROMPT_BUNDLE_RECEIPT_EVIDENCE: ContextReceiptEvidence[] = ["prompt-artifact"];
Object.freeze(PROMPT_BUNDLE_RECEIPT_EVIDENCE);

export const PROMPT_BUNDLE_CONTEXT_CAPABILITIES: Readonly<ProviderContextCapabilities> =
  Object.freeze({
    startupHook: false,
    toolRecall: false,
    freshSessionPrompt: true,
    checkpoint: false,
    acknowledgment: false,
    maximumContextTokens: 128_000,
    encodingOverheadTokens: 16,
    receiptEvidence: PROMPT_BUNDLE_RECEIPT_EVIDENCE,
  });

const CONFIG: DeliveryAdapterConfig = {
  id: PROMPT_BUNDLE_ADAPTER_ID,
  version: PROMPT_BUNDLE_ADAPTER_VERSION,
  capabilities: PROMPT_BUNDLE_CONTEXT_CAPABILITIES,
  supportedModes: ["prompt-bundle"],
  matchesTarget: (target: ContextTarget): boolean =>
    target.provider.trim().length > 0 &&
    target.harness.trim().length > 0 &&
    target.role.trim().length > 0,
  encode: renderPromptBundle,
};

export function createPromptBundleAdapter(): DeliveryAdapter {
  return createDeliveryAdapter(CONFIG);
}

export const createPromptBundleDeliveryAdapter = createPromptBundleAdapter;
