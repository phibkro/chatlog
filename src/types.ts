export type Provider = "anthropic" | "openai" | string;
export type Harness = "claude-code" | "codex" | "pi" | string;

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
}

export interface Turn {
  role: string;
  content: string;
  at?: string;
  toolCalls?: ToolCall[];
  tokens?: TokenUsage;
}

export interface Conversation {
  id: string;
  provider: Provider;
  harness: Harness;
  project: string;
  cwd: string;
  model: string;
  startedAt: string;
  endedAt: string;
  turns: Turn[];
  resumeId?: string;
  sourcePath: string;
  contentHash: string;
}

export interface SourceFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface AdaptResult {
  conversation: Omit<Conversation, "contentHash">;
  partialTail: boolean;
}

export interface SourceAdapter {
  readonly harness: Harness;
  discover(): Promise<SourceFile[]>;
  adapt(source: SourceFile): Promise<AdaptResult>;
}
