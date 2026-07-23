import { homedir } from "node:os";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";

export type SourceStatus = "connected" | "available" | "not-found" | "planned";

export interface SourceConfiguration {
  id: string;
  kind: string;
  label: string;
  path: string;
  domain?: string;
  enabled?: boolean;
}

export interface SourceCatalogItem {
  id: string;
  kind: string;
  label: string;
  description: string;
  path?: string;
  domain: string;
  status: SourceStatus;
  importCommand?: string;
  privacy: string;
}

interface SourceConfigFile {
  sources?: SourceConfiguration[];
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch { return false; }
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function loadConfiguredSources(): Promise<SourceConfiguration[]> {
  const path = process.env.CHATLOG_SOURCE_CONFIG
    ? resolve(process.env.CHATLOG_SOURCE_CONFIG)
    : `${homedir()}/.config/chatlog/sources.json`;
  if (!(await exists(path))) return [];
  const parsed = await Bun.file(path).json() as SourceConfigFile;
  if (!Array.isArray(parsed.sources)) throw new Error(`${path}: sources must be an array`);
  return parsed.sources.filter((source) => source.enabled !== false);
}

export async function sourceCatalog(dataRoot?: string): Promise<SourceCatalogItem[]> {
  const home = homedir();
  const builtins: Array<Omit<SourceCatalogItem, "status"> & { probe?: string }> = [
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
  ];

  const resolved: SourceCatalogItem[] = [];
  for (const item of builtins) {
    const { probe, ...source } = item;
    resolved.push({ ...source, status: probe && await exists(probe) ? "connected" : "not-found" });
  }

  const configuredSources = await loadConfiguredSources();
  const configuredPaths = new Set(configuredSources.map((source) => resolve(source.path)));
  for (const configured of configuredSources) {
    const path = resolve(configured.path);
    const available = await exists(path);
    resolved.push({
      id: configured.id,
      kind: configured.kind,
      label: configured.label,
      description: configured.kind === "anthropic-export"
        ? "Claude Web conversations, brainstorming and broader personal context."
        : "Configured external conversation source.",
      path,
      domain: configured.domain ?? "general",
      status: available ? "available" : "not-found",
      ...(configured.kind === "anthropic-export" && available
        ? { importCommand: `bun run import:anthropic -- ${shellQuote(path)} ${shellQuote(configured.domain ?? "general")}` }
        : {}),
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
        importCommand: `bun run import:anthropic -- ${shellQuote(path)} general`,
        privacy: "Discovery does not read conversation content. Import remains explicit and local.",
      });
    }
  }

  resolved.push(
    {
      id: "chatgpt-export",
      kind: "openai-export",
      label: "ChatGPT export",
      description: "ChatGPT data-export conversations and branches.",
      domain: "general",
      status: "planned",
      privacy: "Will require explicit local import; no automatic upload or hosted analysis.",
    },
    {
      id: "generic-jsonl",
      kind: "generic-jsonl",
      label: "Other agent harness",
      description: "Adapter seam for OpenCode, Gemini, Goose and custom JSONL event streams.",
      domain: "coding",
      status: "planned",
      privacy: "Provider schemas must be explicitly allow-listed before ingestion.",
    },
  );
  return resolved;
}
