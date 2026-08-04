import type { InsightScope, InsightValidTime } from "./insights";

export const CONTEXT_SCHEMA_VERSION = 1 as const;
/**
 * A recall result emits two terminal batches plus two lifecycle batches per
 * branch. Keep the staged input and every stored session outbox finite.
 */
export const MAX_STAGED_RECALL_EVENT_BATCHES = 256;
export const MAX_CONTEXT_RECALL_INVOCATIONS = 256;
export const MAX_CONTEXT_SESSIONS = 1_024;

export type ContextItemKind = "evidence" | "insight" | "procedure" | "current-state";
export type ContextRiskClass = "low" | "medium" | "high";
export type ContextExposure = "shadow" | "evidence-only" | "limited-insight";
export type ContextDeliveryMode =
  | "startup-hook"
  | "tool-recall"
  | "fresh-session-prompt"
  | "prompt-bundle";

export interface ContextTarget {
  provider: string;
  harness: string;
  model: string | null;
  role: string;
}

export type ContextReceiptEvidence =
  | "hook-output"
  | "tool-result"
  | "prompt-artifact"
  | "provider-acknowledgment";

export interface ProviderContextCapabilities {
  startupHook: boolean;
  toolRecall: boolean;
  freshSessionPrompt: boolean;
  checkpoint: boolean;
  acknowledgment: boolean;
  maximumContextTokens: number;
  encodingOverheadTokens: number;
  receiptEvidence: ContextReceiptEvidence[];
}

export interface ContextBudget {
  tokens: number;
  results: number;
  latencyMs: number;
  costUsd: number;
}

export const MAX_CONTEXT_BUDGET: Readonly<ContextBudget> = {
  tokens: 100_000,
  results: 64,
  latencyMs: 60_000,
  costUsd: 100,
};

export interface ContextSessionBudget {
  total: ContextBudget;
  remaining: ContextBudget;
}

export interface RecallInvocationRecord {
  invocationId: string;
  invocationHash: string;
  contentHash: string;
  traceHash: string;
  lifecycleTimestampFloor?: string;
}

export interface ContextSession {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  contextSessionId: string;
  nativeSessionId: string | null;
  sessionNonce: string | null;
  target: ContextTarget;
  projectIdentity: string;
  cwd: string;
  domainPolicy: string[];
  path: string | null;
  pinnedInsightProjectionHash: string;
  pinnedEvidenceProjectionHash: string;
  selectionPolicyVersion: string;
  deliveryPolicyVersion: string;
  budget: ContextSessionBudget;
  consumedBundleHashes: string[];
  committedDeliveryBatchHashes: string[];
  attemptedBundleHashes: string[];
  consumedRecallHashes: string[];
  consumedRecallInvocations: RecallInvocationRecord[];
  pendingEventBatchHashes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ContextSessionInput {
  nativeSessionId: string | null;
  sessionNonce?: string | null;
  provider: string;
  harness: string;
  model: string | null;
  role: string;
  projectIdentity: string;
  cwd: string;
  domainPolicy: string[];
  path: string | null;
  pinnedInsightProjectionHash: string;
  pinnedEvidenceProjectionHash: string;
  selectionPolicyVersion: string;
  deliveryPolicyVersion: string;
  totalBudget: ContextBudget;
  createdAt: string;
}

export interface ContextRequestScope extends InsightScope {
  readonly itemPermissions?: readonly string[];
}
export interface ContextRequest {
  task: string;
  query: string;
  contextSessionId: string;
  target: ContextTarget;
  capabilities: ProviderContextCapabilities;
  scope: ContextRequestScope;
  allowedItemKinds: ContextItemKind[];
  riskCeiling: ContextRiskClass;
  freshAfter: string | null;
  budget: ContextBudget;
  fixedInstructionTokens: number;
  deliveryMode: ContextDeliveryMode;
  exposure: ContextExposure;
  now: string;
}

export interface ContextScoreComponents {
  lexical: number;
  semantic: number;
  temporal: number;
  procedure: number;
  total: number;
}

export interface ContextCandidate {
  id: string;
  kind: ContextItemKind;
  content: string;
  evidenceReferences: string[];
  selectionReason: string;
  scores: ContextScoreComponents;
  scope: InsightScope;
  validTime: InsightValidTime;
  authority: string;
  advisory: boolean;
  riskClass: ContextRiskClass;
  estimatedTokens: number;
  estimatedCharacters: number;
  estimatedLatencyMs: number;
  estimatedCostUsd: number;
}

export interface ContextBundleItem extends ContextCandidate {
  rank: number;
}

export type ContextOmissionReason =
  | "kind-not-allowed"
  | "task-mismatch"
  | "exposure-denied"
  | "risk-ceiling"
  | "stale"
  | "not-yet-valid"
  | "expired"
  | "domain-mismatch"
  | "user-mismatch"
  | "organization-mismatch"
  | "project-mismatch"
  | "repository-mismatch"
  | "path-mismatch"
  | "harness-mismatch"
  | "model-mismatch"
  | "tool-mismatch"
  | "token-budget"
  | "result-budget"
  | "latency-budget"
  | "cost-budget";

export interface ContextOmission {
  itemId: string;
  reason: ContextOmissionReason;
}

export interface ContextBundleBudget {
  beforeTokens: number;
  afterTokens: number;
  beforeResults: number;
  afterResults: number;
  beforeLatencyMs: number;
  afterLatencyMs: number;
  beforeCostUsd: number;
  afterCostUsd: number;
  fixedInstructionTokens: number;
  encodingOverheadTokens: number;
}

export interface ContextBundle {
  schemaVersion: typeof CONTEXT_SCHEMA_VERSION;
  contextSessionId: string;
  target: ContextTarget;
  deliveryMode: ContextDeliveryMode;
  exposure: ContextExposure;
  shadow: boolean;
  pinnedInsightProjectionHash: string;
  pinnedEvidenceProjectionHash: string;
  inputHash: string;
  policyHash: string;
  bundleHash: string;
  items: ContextBundleItem[];
  omissions: ContextOmission[];
  budget: ContextBundleBudget;
  plannedAt: string;
}

export type ContextPlanErrorCode =
  | "invalid-request"
  | "session-mismatch"
  | "scope-denied"
  | "budget-exhausted";

export type ContextPlanResult =
  | { ok: true; value: ContextBundle }
  | { ok: false; error: { code: ContextPlanErrorCode; message: string } };
