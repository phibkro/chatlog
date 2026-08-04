import { homedir } from "node:os";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { listSourceReceipts, type SourceReceipt } from "./source-receipts";

export type SourceStatus = "connected" | "available" | "not-found" | "planned";

export interface SourceConfiguration {
  id: string;
  kind: string;
  label: string;
  path: string;
  domain?: string;
  enabled?: boolean;
}

export interface SourceReceiptSummary {
  receiptHash: string;
  eventBatchHash: string;
  conversationProjectionHash: string;
  partialTail: boolean;
  itemCounts: SourceReceipt["itemCounts"];
  lossCounts: SourceReceipt["lossCounts"];
}

export interface SourceCatalogItem {
  id: string;
  kind: string;
  label: string;
  description: string;
  path?: string;
  domain: string;
  status: SourceStatus;
  previewCommand?: string;
  importCommand?: string;
  privacy: string;
  lastReceiptSummary?: SourceReceiptSummary;
}

interface SourceConfigFile {
  sources?: SourceConfiguration[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function loadConfiguredSources(): Promise<SourceConfiguration[]> {
  const path = process.env.CHATLOG_SOURCE_CONFIG
    ? resolve(process.env.CHATLOG_SOURCE_CONFIG)
    : `${homedir()}/.config/chatlog/sources.json`;
  if (!(await exists(path))) return [];
  const parsed = (await Bun.file(path).json()) as SourceConfigFile;
  if (!Array.isArray(parsed.sources)) throw new Error(`${path}: sources must be an array`);
  return parsed.sources.filter((source) => source.enabled !== false);
}

export async function sourceCatalog(dataRoot?: string): Promise<SourceCatalogItem[]> {
  const home = homedir();
  const receipts = dataRoot ? await listSourceReceipts(dataRoot, 200) : [];
  const receiptFor = (path?: string): SourceReceiptSummary | undefined => {
    if (!path) return undefined;
    const receipt = receipts.find(
      (candidate) => candidate.source.path === path || candidate.source.path.startsWith(`${path}#`),
    );
    if (!receipt) return undefined;
    return {
      receiptHash: receipt.receiptHash,
      eventBatchHash: receipt.eventBatchHash,
      conversationProjectionHash: receipt.conversationProjectionHash,
      partialTail: receipt.partialTail,
      itemCounts: receipt.itemCounts,
      lossCounts: receipt.lossCounts,
    };
  };
  const builtins: Array<
    Omit<SourceCatalogItem, "status" | "lastReceiptSummary"> & { probe?: string }
  > = [
    {
      id: "claude-code",
      kind: "session-log",
      label: "Claude Code",
      description: "Local coding sessions, subagents, tools and token usage.",
      path: `${home}/.claude/projects`,
      probe: `${home}/.claude/projects`,
      domain: "coding",
      privacy: "Read-only local discovery; canonical output is secret-redacted.",
    },
    {
      id: "codex",
      kind: "session-log",
      label: "Codex",
      description: "Local rollout history, model events and function calls.",
      path: `${home}/.codex/sessions`,
      probe: `${home}/.codex/sessions`,
      domain: "coding",
      privacy: "Read-only local discovery; canonical output is secret-redacted.",
    },
    {
      id: "pi",
      kind: "session-log",
      label: "Pi",
      description: "Local Pi agent sessions across configured model providers.",
      path: `${home}/.pi/agent/sessions`,
      probe: `${home}/.pi/agent/sessions`,
      domain: "coding",
      privacy: "Read-only local discovery; canonical output is secret-redacted.",
    },
    {
      id: "omp",
      kind: "session-log",
      label: "Oh My Pi",
      description: "Local OMP lead and delegated-agent sessions across configured providers.",
      path: `${home}/.omp/agent/sessions`,
      probe: `${home}/.omp/agent/sessions`,
      domain: "coding",
      privacy: "Read-only local discovery; canonical output is secret-redacted.",
    },
  ];

  const resolved: SourceCatalogItem[] = [];
  for (const item of builtins) {
    const { probe, ...source } = item;
    resolved.push({
      ...source,
      status: probe && (await exists(probe)) ? "connected" : "not-found",
      lastReceiptSummary: receiptFor(source.path),
    });
  }

  const configuredSources = await loadConfiguredSources();
  const configuredPaths = new Set(configuredSources.map((source) => resolve(source.path)));
  for (const configured of configuredSources) {
    const path = resolve(configured.path);
    const available = await exists(path);
    const isChatGPT = configured.kind === "chatgpt-export" || configured.kind === "openai-export";
    const isGeneric = configured.kind === "generic-events" || configured.kind === "generic-jsonl";
    resolved.push({
      id: configured.id,
      kind: configured.kind,
      label: configured.label,
      description: isChatGPT
        ? "ChatGPT export graph with declared current-branch projection."
        : isGeneric
          ? "Versioned Chatlog AgentEventEnvelope JSONL; arbitrary provider JSONL is not accepted."
          : configured.kind === "anthropic-export"
            ? "Claude Web conversations, brainstorming and broader personal context."
            : "Configured external conversation source.",
      path,
      domain: configured.domain ?? (isGeneric ? "coding" : isChatGPT ? "personal" : "general"),
      status: available ? "available" : "not-found",
      ...(available && isChatGPT
        ? {
            previewCommand: `chatlog preview chatgpt ${shellQuote(path)} ${shellQuote(configured.domain ?? "personal")}`,
            importCommand: `chatlog import chatgpt ${shellQuote(path)} ${shellQuote(configured.domain ?? "personal")}`,
          }
        : available && isGeneric
          ? {
              previewCommand: `chatlog preview generic ${shellQuote(path)} ${shellQuote(configured.domain ?? "coding")}`,
              importCommand: `chatlog import generic ${shellQuote(path)} ${shellQuote(configured.domain ?? "coding")}`,
            }
          : configured.kind === "anthropic-export" && available
            ? {
                previewCommand: `chatlog preview anthropic ${shellQuote(path)} ${shellQuote(configured.domain ?? "general")}`,
                importCommand: `chatlog import anthropic ${shellQuote(path)} ${shellQuote(configured.domain ?? "general")}`,
              }
            : {}),
      lastReceiptSummary: receiptFor(path),
      privacy: "Imported on demand into the local redacted corpus; source remains read-only.",
    });
  }

  if (dataRoot) {
    let exportIndex = 0;
    for (const name of new Bun.Glob("data-*.zip").scanSync({ cwd: dataRoot, onlyFiles: true })) {
      const path = resolve(dataRoot, name);
      if (configuredPaths.has(path)) continue;
      exportIndex++;
      resolved.push({
        id: `anthropic-export-discovered-${exportIndex}`,
        kind: "anthropic-export",
        label: "Claude Web export",
        description: "Discovered Anthropic data export; ready for an explicit local import.",
        path,
        domain: "general",
        status: "available",
        previewCommand: `chatlog preview anthropic ${shellQuote(path)} general`,
        importCommand: `chatlog import anthropic ${shellQuote(path)} general`,
        lastReceiptSummary: receiptFor(path),
        privacy: "Discovery does not read conversation content. Import remains explicit and local.",
      });
    }
  }

  resolved.push(
    {
      id: "chatgpt-export",
      kind: "openai-export",
      label: "ChatGPT export",
      description: "ChatGPT export graph with declared current-branch projection.",
      domain: "personal",
      status: "available",
      previewCommand: "chatlog preview chatgpt <export-path> [domain]",
      importCommand: "chatlog import chatgpt <export-path> [domain]",
      privacy:
        "Read-only local export; preview writes no state and import preserves alternate branches as redacted evidence.",
    },
    {
      id: "generic-jsonl",
      kind: "generic-jsonl",
      label: "Chatlog event JSONL",
      description: "Versioned Chatlog AgentEventEnvelope JSONL with a required producer header.",
      domain: "coding",
      status: "available",
      previewCommand: "chatlog preview generic <events.jsonl> [domain]",
      importCommand: "chatlog import generic <events.jsonl> [domain]",
      privacy:
        "Only the versioned Chatlog event contract is accepted; input stays read-only and canonical output is redacted.",
    },
  );
  return resolved;
}
