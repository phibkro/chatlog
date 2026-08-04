import {
  CONTEXT_SCHEMA_VERSION,
  type ContextBundle,
  type ContextDeliveryMode,
  type ContextReceiptEvidence,
  type ContextTarget,
  type ProviderContextCapabilities,
} from "../../context-types";

export const DELIVERY_SCHEMA_VERSION = 1 as const;

export interface EncodedContext {
  readonly schemaVersion: typeof DELIVERY_SCHEMA_VERSION;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly contextSessionId: string;
  readonly bundleHash: string;
  readonly target: Readonly<ContextTarget>;
  readonly deliveryMode: ContextDeliveryMode;
  /** The complete provider-facing payload. It is data; it is never executed by an adapter. */
  readonly content: string;
  readonly contentHash: string;
  /** UTF-8 content estimate before the adapter's fixed provider overhead. */
  readonly contentTokens: number;
  /** Exact estimate used for admission, including adapter overhead. */
  readonly estimatedTokens: number;
  /** Alias for callers that use the shorter token-estimate vocabulary. */
  readonly tokenEstimate: number;
  readonly encodingOverheadTokens: number;
  readonly receiptEvidence: readonly ContextReceiptEvidence[];
  /** Explicitly names this as capability evidence, not an acknowledgment. */
  readonly supportedReceiptEvidence: readonly ContextReceiptEvidence[];
}

export type DeliveryErrorCode =
  | "invalid-bundle"
  | "unsupported-mode"
  | "unsupported-target"
  | "budget-overflow"
  | "encoding-error";

export interface DeliveryError {
  readonly code: DeliveryErrorCode;
  readonly message: string;
  readonly adapterId: string;
  readonly mode?: ContextDeliveryMode;
  readonly target?: Readonly<ContextTarget>;
}

export type DeliveryResult<T = EncodedContext> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DeliveryError };

export type DeliverySelectionResult =
  | { readonly ok: true; readonly value: DeliveryAdapter }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "unsupported-target" | "unsupported-mode";
        readonly message: string;
      };
    };

export interface DeliveryAdapter {
  readonly id: string;
  readonly adapterId: string;
  readonly version: string;
  readonly capabilities: Readonly<ProviderContextCapabilities>;
  render(bundle: ContextBundle): DeliveryResult;
}

export type DeliveryModeCapability = "startupHook" | "toolRecall" | "freshSessionPrompt";

/** Keeps this module's imported schema visible to type-only consumers. */
export type ContextSchemaVersion = typeof CONTEXT_SCHEMA_VERSION;
