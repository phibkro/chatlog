import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { indexConversation, openAnalysis } from "../analysis";
import { deriveCorpus, type DeriveSummary } from "../derive";
import { normalizeConversationDomain } from "../domain";
import { canonicalizeConversation } from "../ingest";
import {
  manifestSourcesHash,
  writeImportReceipt,
  type ImportReceipt,
} from "../import-receipts";
import { withIngestLock } from "../lock";
import { redact } from "../redact";
import { refineCorpus, type RefinerySummary } from "../refinery";
import { reconcileSourceAuthority } from "../source-authority";
import type { Conversation, ConversationDomain, ToolCall, Turn } from "../types";

interface ExportContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: unknown;
  content?: unknown;
  display_content?: unknown;
  is_error?: boolean;
}

interface ExportMessage {
  uuid?: string;
  text?: string;
  content?: ExportContentBlock[];
  sender?: string;
  created_at?: string;
  attachments?: Array<{ file_name?: string; file_type?: string }>;
  files?: Array<{ file_name?: string }>;
}

interface ExportConversation {
  uuid?: string;
  name?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ExportMessage[];
}

interface CorpusManifest {
  version: 1;
  redactionRecipe?: string;
  sources: Record<string, { size: number; mtimeMs: number; contentHash: string }>;
}

export interface AnthropicImportOptions {
  domain?: ConversationDomain;
  derive?: boolean;
}

export interface AnthropicImportSummary {
  source: string;
  domain: string;
  discovered: number;
  imported: number;
  skipped: number;
  turns: number;
  attachments: number;
  files: number;
  derived?: DeriveSummary;
  refinery?: RefinerySummary;
  receipt: ImportReceipt;
}

export interface AnthropicPreviewSummary {
  schema: "chatlog/anthropic-import-preview-v1";
  receiptId: string;
  proposalId: string;
  advisory: true;
  source: string;
  sourceBytes: number;
  sourceModifiedAt: string;
  sourceContentHash: string;
  domain: string;
  ready: boolean;
  discovered: number;
  importable: number;
  invalid: number;
  new: number;
  changed: number;
  reclassified: number;
  unchanged: number;
  wouldImport: number;
  turns: number;
  attachments: number;
  files: number;
  dateRange: {
    first: string | null;
    last: string | null;
  };
  exclusions: {
    modelThinking: true;
    attachmentBodies: true;
    claudeProjects: true;
    memories: true;
  };
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function readExportJson(path: string, member: string): Promise<string> {
  const source = resolve(path);
  const info = await stat(source);
  if (info.isDirectory()) return readFile(join(source, member), "utf8");
  if (extname(source).toLowerCase() !== ".zip") throw new Error("Anthropic export must be a directory or .zip archive");

  const child = Bun.spawn(["unzip", "-p", source, member], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`cannot read ${member} from Anthropic export: ${redact(error.trim())}`);
  return text;
}

function safeJson(value: unknown): string {
  try { return redact(JSON.stringify(value ?? {})); }
  catch { return "[unserializable tool input]"; }
}

function blockText(block: ExportContentBlock): string {
  if (block.type === "text" && typeof block.text === "string") return redact(block.text);
  return "";
}

function resultText(block: ExportContentBlock): string {
  const value = block.content ?? block.display_content;
  if (typeof value === "string") return redact(value);
  if (value != null) return safeJson(value);
  return block.is_error ? "[tool error]" : "";
}

function attachmentSummary(message: ExportMessage): string[] {
  const parts: string[] = [];
  for (const attachment of message.attachments ?? []) {
    const name = redact(attachment.file_name ?? "attachment");
    const type = redact(attachment.file_type ?? "unknown type");
    parts.push(`[Attachment: ${name} · ${type}]`);
  }
  for (const file of message.files ?? []) parts.push(`[File: ${redact(file.file_name ?? "file")}]`);
  return parts;
}

export function adaptAnthropicConversation(
  sourcePath: string,
  item: ExportConversation,
  domain: ConversationDomain = "general",
): Omit<Conversation, "contentHash"> {
  if (!item.uuid) throw new Error(`${sourcePath}: conversation without uuid`);
  const turns: Turn[] = [];
  const toolCalls = new Map<string, ToolCall>();

  for (const message of item.chat_messages ?? []) {
    const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : String(message.sender ?? "unknown");
    const text = (message.content ?? []).map(blockText).filter(Boolean);
    if (!text.length && typeof message.text === "string" && message.text.trim()) text.push(redact(message.text));
    text.push(...attachmentSummary(message));

    const calls: ToolCall[] = [];
    for (const block of message.content ?? []) {
      if (block.type === "tool_use") {
        const call: ToolCall = {
          id: block.id,
          name: redact(block.name ?? "tool"),
          arguments: safeJson(block.input),
        };
        calls.push(call);
        if (block.id) toolCalls.set(block.id, call);
      } else if (block.type === "tool_result" && block.tool_use_id) {
        const call = toolCalls.get(block.tool_use_id);
        if (call) call.output = resultText(block);
      }
    }

    if (text.length || calls.length) {
      turns.push({
        role,
        content: text.join("\n").trim(),
        ...(message.created_at ? { at: message.created_at } : {}),
        ...(calls.length ? { toolCalls: calls } : {}),
      });
    }
  }

  const timestamps = turns.map((turn) => turn.at).filter((value): value is string => Boolean(value)).sort();
  const fallback = item.created_at ?? item.updated_at ?? new Date(0).toISOString();
  return {
    id: item.uuid,
    title: redact(item.name || item.summary || "Untitled Claude conversation"),
    provider: "anthropic",
    harness: "claude-web",
    domain: normalizeConversationDomain(domain),
    sourceKind: "anthropic-data-export",
    project: "Claude Web",
    cwd: "",
    model: "(export does not identify model)",
    startedAt: timestamps[0] ?? fallback,
    endedAt: timestamps.at(-1) ?? item.updated_at ?? fallback,
    turns,
    resumeId: item.uuid,
    sourcePath: `${resolve(sourcePath)}#conversations/${item.uuid}`,
  };
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function loadManifest(path: string): Promise<CorpusManifest> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CorpusManifest;
    if (parsed.version !== 1 || !parsed.sources) throw new Error("unsupported corpus manifest");
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1, sources: {} };
    throw error;
  }
}

export async function previewAnthropicExport(
  sourcePath: string,
  root: string,
  options: Pick<AnthropicImportOptions, "domain"> = {},
): Promise<AnthropicPreviewSummary> {
  const domain = normalizeConversationDomain(options.domain ?? "general");
  const resolved = resolve(sourcePath);
  const sourceInfo = await stat(resolved);
  const exportText = await readExportJson(resolved, "conversations.json");
  const conversations = JSON.parse(exportText) as ExportConversation[];
  if (!Array.isArray(conversations)) throw new Error("Anthropic conversations.json must contain an array");

  const manifest = await loadManifest(join(root, "corpus", "manifest.json"));
  const proposed: Array<{ sourcePath: string; contentHash: string }> = [];
  const observed: Array<{
    sourcePath: string;
    previousHash: string | null;
    classification: "new" | "changed" | "reclassified" | "unchanged";
  }> = [];
  const timestamps: string[] = [];
  let importable = 0;
  let invalid = 0;
  let created = 0;
  let changed = 0;
  let reclassified = 0;
  let unchanged = 0;
  let turns = 0;
  let attachments = 0;
  let files = 0;

  for (const item of conversations) {
    let conversation: Conversation;
    try {
      conversation = canonicalizeConversation(adaptAnthropicConversation(resolved, item, domain));
    } catch {
      invalid++;
      continue;
    }
    importable++;
    for (const message of item.chat_messages ?? []) {
      attachments += message.attachments?.length ?? 0;
      files += message.files?.length ?? 0;
    }
    turns += conversation.turns.length;
    timestamps.push(conversation.startedAt, conversation.endedAt);
    proposed.push({
      sourcePath: conversation.sourcePath,
      contentHash: conversation.contentHash,
    });
    const previous = manifest.sources[conversation.sourcePath];
    let classification: "new" | "changed" | "reclassified" | "unchanged";
    if (!previous) {
      created++;
      classification = "new";
    } else if (previous.contentHash === conversation.contentHash) {
      unchanged++;
      classification = "unchanged";
    } else {
      let domainOnly = false;
      try {
        const previousConversation = JSON.parse(await readFile(
          join(root, "corpus", "objects", previous.contentHash.slice(0, 2), `${previous.contentHash}.json`),
          "utf8",
        )) as Conversation;
        const previousDomain = normalizeConversationDomain(previousConversation.domain ?? "general");
        domainOnly = previousDomain !== domain
          && JSON.stringify({
            ...previousConversation,
            domain,
            contentHash: conversation.contentHash,
          }) === JSON.stringify(conversation);
      } catch {
        // A missing prior object means preview cannot prove this is a
        // domain-only change, so it remains conservatively "changed".
      }
      if (domainOnly) {
        reclassified++;
        classification = "reclassified";
      } else {
        changed++;
        classification = "changed";
      }
    }
    observed.push({
      sourcePath: conversation.sourcePath,
      previousHash: previous?.contentHash ?? null,
      classification,
    });
  }

  proposed.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  observed.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  timestamps.sort();
  const sourceContentHash = sha256(exportText);
  const proposalId = sha256(JSON.stringify({
    schema: "chatlog/anthropic-import-preview-v1",
    source: resolved,
    sourceContentHash,
    domain,
    proposed,
    invalid,
  }));
  const receiptId = sha256(JSON.stringify({ proposalId, observed }));

  return {
    schema: "chatlog/anthropic-import-preview-v1",
    receiptId,
    proposalId,
    advisory: true,
    source: resolved,
    sourceBytes: sourceInfo.size,
    sourceModifiedAt: sourceInfo.mtime.toISOString(),
    sourceContentHash,
    domain,
    ready: invalid === 0,
    discovered: conversations.length,
    importable,
    invalid,
    new: created,
    changed,
    reclassified,
    unchanged,
    wouldImport: created + changed + reclassified,
    turns,
    attachments,
    files,
    dateRange: {
      first: timestamps[0] ?? null,
      last: timestamps.at(-1) ?? null,
    },
    exclusions: {
      modelThinking: true,
      attachmentBodies: true,
      claudeProjects: true,
      memories: true,
    },
  };
}

export async function importAnthropicExport(
  sourcePath: string,
  root: string,
  options: AnthropicImportOptions = {},
): Promise<AnthropicImportSummary> {
  return withIngestLock(root, async () => {
    const domain = normalizeConversationDomain(options.domain ?? "general");
    const resolved = resolve(sourcePath);
    const source = await stat(resolved);
    const exportText = await readExportJson(resolved, "conversations.json");
    const sourceContentHash = sha256(exportText);
    const conversations = JSON.parse(exportText) as ExportConversation[];
    if (!Array.isArray(conversations)) throw new Error("Anthropic conversations.json must contain an array");

    const corpusDir = join(root, "corpus");
    const manifestPath = join(corpusDir, "manifest.json");
    const manifest = await loadManifest(manifestPath);
    const beforeHash = manifestSourcesHash(manifest.sources);
    const beforeSources = Object.keys(manifest.sources).length;
    const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
    const summary: Omit<AnthropicImportSummary, "receipt"> = {
      source: resolved,
      domain,
      discovered: conversations.length,
      imported: 0,
      skipped: 0,
      turns: 0,
      attachments: 0,
      files: 0,
    };
    let added = 0;
    let replaced = 0;

    try {
      await reconcileSourceAuthority(root, db, manifest.sources);
      for (const item of conversations) {
        for (const message of item.chat_messages ?? []) {
          summary.attachments += message.attachments?.length ?? 0;
          summary.files += message.files?.length ?? 0;
        }
        const conversation = canonicalizeConversation(adaptAnthropicConversation(resolved, item, domain));
        summary.turns += conversation.turns.length;
        const previous = manifest.sources[conversation.sourcePath];
        if (previous?.contentHash === conversation.contentHash) {
          summary.skipped++;
          continue;
        }
        if (previous) replaced++;
        else added++;

        const objectPath = join(corpusDir, "objects", conversation.contentHash.slice(0, 2), `${conversation.contentHash}.json`);
        if (!(await Bun.file(objectPath).exists())) await atomicWrite(objectPath, JSON.stringify(conversation) + "\n");
        indexConversation(db, conversation, source.mtimeMs, source.size);
        manifest.sources[conversation.sourcePath] = {
          size: source.size,
          mtimeMs: source.mtimeMs,
          contentHash: conversation.contentHash,
        };
        summary.imported++;
      }
      await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      await reconcileSourceAuthority(root, db, manifest.sources);
    } finally {
      db.close();
    }

    let derivationError: unknown;
    if (options.derive !== false) {
      try {
        summary.derived = await deriveCorpus(root);
        summary.refinery = await refineCorpus(root);
      } catch (error) {
        derivationError = error;
      }
    }
    const receipt = await writeImportReceipt(root, {
      source: {
        path: resolved,
        contentHash: sourceContentHash,
        bytes: source.size,
        modifiedAt: source.mtime.toISOString(),
      },
      domain,
      counts: {
        discovered: summary.discovered,
        imported: summary.imported,
        skipped: summary.skipped,
        turns: summary.turns,
        attachments: summary.attachments,
        files: summary.files,
      },
      manifest: {
        beforeHash,
        afterHash: manifestSourcesHash(manifest.sources),
        beforeSources,
        afterSources: Object.keys(manifest.sources).length,
        added,
        replaced,
        unchanged: summary.skipped,
      },
      deriveEnabled: options.derive !== false,
      derivationStatus: options.derive === false
        ? "not-requested"
        : derivationError
          ? "failed"
          : "completed",
      derived: summary.derived,
      refinery: summary.refinery,
    });
    if (derivationError) {
      const message = derivationError instanceof Error
        ? derivationError.message
        : String(derivationError);
      throw new Error(
        `import committed as receipt ${receipt.receiptId}, but derivation failed: ${redact(message)}`,
      );
    }
    return { ...summary, receipt };
  });
}
