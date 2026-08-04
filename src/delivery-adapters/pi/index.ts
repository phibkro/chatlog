import type {
  ContextReceiptEvidence,
  ContextTarget,
  ProviderContextCapabilities,
} from "../../context-types";
import {
  createDeliveryAdapter,
  renderFreshSessionArtifact,
  type DeliveryAdapterConfig,
} from "../shared";
import type { DeliveryAdapter } from "../types";

export const PI_ADAPTER_ID = "pi" as const;
export const PI_ADAPTER_VERSION = "1" as const;
const PI_RECEIPT_EVIDENCE: ContextReceiptEvidence[] = ["prompt-artifact"];
Object.freeze(PI_RECEIPT_EVIDENCE);

export const PI_CONTEXT_CAPABILITIES: Readonly<ProviderContextCapabilities> = Object.freeze({
  startupHook: false,
  toolRecall: false,
  freshSessionPrompt: true,
  checkpoint: false,
  acknowledgment: false,
  maximumContextTokens: 128_000,
  encodingOverheadTokens: 24,
  receiptEvidence: PI_RECEIPT_EVIDENCE,
});

const CONFIG: DeliveryAdapterConfig = {
  id: PI_ADAPTER_ID,
  version: PI_ADAPTER_VERSION,
  capabilities: PI_CONTEXT_CAPABILITIES,
  supportedModes: ["fresh-session-prompt"],
  matchesTarget: (target: ContextTarget): boolean => target.harness.trim().toLowerCase() === "pi",
  encode: renderFreshSessionArtifact,
};

export function createPiDeliveryAdapter(): DeliveryAdapter {
  return createDeliveryAdapter(CONFIG);
}

export const createPiAdapter = createPiDeliveryAdapter;
