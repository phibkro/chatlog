import type {
  ContextBundle,
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

export const OMP_ADAPTER_ID = "omp" as const;
export const OMP_ADAPTER_VERSION = "1" as const;
const OMP_RECEIPT_EVIDENCE: ContextReceiptEvidence[] = ["prompt-artifact"];
Object.freeze(OMP_RECEIPT_EVIDENCE);

export const OMP_CONTEXT_CAPABILITIES: Readonly<ProviderContextCapabilities> = Object.freeze({
  startupHook: false,
  toolRecall: false,
  freshSessionPrompt: true,
  checkpoint: false,
  acknowledgment: false,
  maximumContextTokens: 200_000,
  encodingOverheadTokens: 24,
  receiptEvidence: OMP_RECEIPT_EVIDENCE,
});

const CONFIG: DeliveryAdapterConfig = {
  id: OMP_ADAPTER_ID,
  version: OMP_ADAPTER_VERSION,
  capabilities: OMP_CONTEXT_CAPABILITIES,
  supportedModes: ["fresh-session-prompt"],
  matchesTarget: (target: ContextTarget): boolean => target.harness.trim().toLowerCase() === "omp",
  encode: (bundle: ContextBundle): string => renderFreshSessionArtifact(bundle),
};

export function createOmpDeliveryAdapter(): DeliveryAdapter {
  return createDeliveryAdapter(CONFIG);
}
