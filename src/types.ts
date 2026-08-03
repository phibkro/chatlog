import type { EventBatch } from "./events";

export type Provider = "anthropic" | "openai" | string;
export type Harness = "claude-code" | "codex" | "pi" | "claude-web" | string;
export type ConversationDomain = "coding" | "personal" | "ideas" | "research" | "general" | string;

export interface TokenUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: string;
  output?: string;
  approval?: "approved" | "denied";
  execution?: "started" | "succeeded" | "failed" | "unknown";
  result?: "observed" | "error";
  sourceEventIds?: string[];
}

export interface Turn {
  role: string;
  content: string;
  at?: string;
  toolCalls?: ToolCall[];
  tokens?: TokenUsage;
  sourceEventIds?: string[];
}

export interface Conversation {
  id: string;
  title?: string;
  provider: Provider;
  harness: Harness;
  domain?: ConversationDomain;
  sourceKind?: string;
  project: string;
  cwd: string;
  model: string;
  startedAt: string;
  endedAt: string;
  turns: Turn[];
  resumeId?: string;
  sourcePath: string;
  eventBatchHash?: string;
  contentHash: string;
}

export interface SourceFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface SourceAdapter {
  readonly harness: Harness;
  discover(): Promise<SourceFile[]>;
  adapt(source: SourceFile): Promise<EventBatch>;
}
