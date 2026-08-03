import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { indexConversation, indexEventBatch, openAnalysis } from "../analysis";
import { projectConversation } from "../conversation-projection";
import { deriveCorpus, type DeriveSummary } from "../derive";
import { normalizeConversationDomain } from "../domain";
import { persistEventBatch } from "../event-store";
import {
  capture,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  makeSemanticLoss,
  redactedHash,
  type AgentEventEnvelope,
  type EventBatch,
} from "../events";
import { redact } from "../redact";
import { manifestSourcesHash, writeImportReceipt, type ImportReceipt } from "../import-receipts";
import { withIngestLock } from "../lock";
import { refineCorpus, type RefinerySummary } from "../refinery";
import { reconcileSourceAuthority } from "../source-authority";
import {
  buildSourceReceipt,
  persistSourceReceipt,
  persistUnknownShapeNominations,
} from "../source-receipts";
import type { Conversation, ConversationDomain } from "../types";
export class AnthropicExportError extends Error {
  readonly code = "anthropic-export-invalid";
}

function failClosed(message: string, cause?: unknown): never {
  throw new AnthropicExportError(message, cause === undefined ? undefined : { cause });
}

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
  approval?: string;
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
  branch_id?: string;
  chat_messages?: ExportMessage[];
}

interface CorpusManifest {
  version: 1;
  redactionRecipe?: string;
  projectIdentityRecipe?: string;
  eventRecipe?: string;
  sources: Record<
    string,
    {
      size: number;
      mtimeMs: number;
      contentHash: string;
      eventBatchHash?: string;
      conversationProjectionHash?: string;
      receiptHash?: string;
    }
  >;
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
  if (extname(source).toLowerCase() !== ".zip")
    failClosed("Anthropic export must be a directory or .zip archive");

  const child = Bun.spawn(["unzip", "-p", source, member], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    failClosed(`cannot read ${member} from Anthropic export: ${redact(error.trim())}`);
  return text;
}

function safeJson(value: unknown): string {
  try {
    return redact(JSON.stringify(value ?? {}));
  } catch {
    return "[unserializable tool input]";
  }
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

export function adaptAnthropicEventBatch(
  sourcePath: string,
  item: ExportConversation,
  domain: ConversationDomain = "general",
): EventBatch {
  if (!item.uuid) failClosed(`${sourcePath}: conversation without uuid`);
  const resolvedSource = `${resolve(sourcePath)}#conversations/${item.uuid}`;
  const sessionId = item.uuid;
  const records: unknown[] = [item, ...(item.chat_messages ?? [])];
  const sourceBase = {
    provider: "anthropic",
    harness: "claude-web",
    sourceKind: "anthropic-data-export",
    nativeSessionId: sessionId,
    sourcePath: resolvedSource,
    adapterRecipe: "chatlog-anthropic-export-events-v2",
    capturePolicyVersion: "chatlog-redacted-capture-v1",
  };
  const events: AgentEventEnvelope[] = [];
  const semanticLoss: EventBatch["semanticLoss"][number][] = [];
  const toolEvents = new Map<string, AgentEventEnvelope>();

  const loss = (
    code:
      | "capture-policy-omission"
      | "provider-field-unsupported"
      | "encrypted-content-unavailable"
      | "attachment-body-excluded"
      | "reasoning-excluded-from-projection"
      | "unknown-well-formed-item"
      | "partial-live-tail"
      | "relation-target-missing",
    reason: string,
    sourceItemKind: string,
    sourceLocator: string,
    recordIndex: number,
    recoverable: boolean,
  ): void => {
    semanticLoss.push(
      makeSemanticLoss({
        code,
        reason,
        provider: sourceBase.provider,
        harness: sourceBase.harness,
        sourceItemKind,
        sourceLocator,
        count: 1,
        adapterRecipe: sourceBase.adapterRecipe,
        capturePolicyVersion: sourceBase.capturePolicyVersion,
        recoverable,
        sourcePath: resolvedSource,
        recordPosition: { record: recordIndex },
        nativeItemId: sourceLocator,
      }),
    );
  };
  let previous: AgentEventEnvelope | undefined;
  const add = (
    kind: AgentEventEnvelope["kind"],
    record: unknown,
    recordIndex: number,
    payload: Record<string, unknown>,
    options: {
      nativeItemId: string;
      occurredAt?: string;
      relations?: Record<string, unknown>;
      actor?: AgentEventEnvelope["actor"];
      capture?: ReturnType<typeof capture>;
      scope?: AgentEventEnvelope["scope"];
    },
  ): AgentEventEnvelope => {
    const source = makeObservedSource(
      {
        ...sourceBase,
        nativeItemId: options.nativeItemId,
        recordPosition: { record: recordIndex },
      },
      record,
    );
    const event = makeEvent({
      kind,
      sequence: events.length,
      ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
      actor: options.actor ?? { kind: "provider", name: "claude-web" },
      scope: { sessionId, project: "Claude Web", ...options.scope },
      origin: { kind: "observed", source },
      relations: options.relations ?? {},
      payload,
      capture: options.capture ?? capture("normalized"),
    });
    events.push(event);
    previous = event;
    return event;
  };

  const startedAt = item.created_at ?? item.updated_at ?? new Date(0).toISOString();
  add(
    "session.started",
    item,
    0,
    {
      id: sessionId,
      sessionId,
      provider: "anthropic",
      harness: "claude-web",
      title: redact(item.name || item.summary || "Untitled Claude conversation"),
      domain: normalizeConversationDomain(domain),
      sourceKind: "anthropic-data-export",
      project: "Claude Web",
      cwd: "",
      model: "(export does not identify model)",
      resumeId: sessionId,
    },
    { nativeItemId: `session:${sessionId}`, occurredAt: startedAt },
  );
  if (item.branch_id) {
    const branchCreated = add(
      "branch.created",
      item,
      0,
      { branchId: item.branch_id, summary: "export branch" },
      {
        nativeItemId: `${item.branch_id}:created`,
        ...(item.updated_at ? { occurredAt: item.updated_at } : {}),
        relations: { parent: previous!.eventId },
        scope: { branchId: item.branch_id },
        actor: { kind: "provider", name: "claude-web" },
      },
    );
    add(
      "branch.selected",
      item,
      0,
      { branchId: item.branch_id },
      {
        nativeItemId: `${item.branch_id}:selected`,
        ...(item.updated_at ? { occurredAt: item.updated_at } : {}),
        relations: { causedBy: [branchCreated.eventId], parent: branchCreated.eventId },
        scope: { branchId: item.branch_id },
        actor: { kind: "provider", name: "claude-web" },
      },
    );
  }

  for (const [messageIndex, message] of (item.chat_messages ?? []).entries()) {
    const recordIndex = messageIndex + 1;
    const eventCountBefore = events.length;
    const lossCountBefore = semanticLoss.length;
    const messageId = message.uuid ?? `${sessionId}:message:${messageIndex}`;
    const role =
      message.sender === "human"
        ? "user"
        : message.sender === "assistant"
          ? "assistant"
          : String(message.sender ?? "unknown");
    const text = (message.content ?? []).map(blockText).filter(Boolean);
    if (!text.length && typeof message.text === "string" && message.text.trim())
      text.push(redact(message.text));
    text.push(...attachmentSummary(message));
    const blocks = message.content ?? [];
    const toolUseBlocks = blocks.filter((block) => block.type === "tool_use");
    for (const [blockIndex, block] of blocks.entries()) {
      if (
        !block.type ||
        ["text", "thinking", "tool_use", "tool_result", "image", "document"].includes(block.type)
      ) {
        if (block.type === "image" || block.type === "document")
          loss(
            "attachment-body-excluded",
            `Anthropic export ${block.type} attachment body was not captured`,
            block.type,
            `${messageId}:block:${blockIndex}`,
            recordIndex,
            true,
          );
        continue;
      }
      loss(
        "unknown-well-formed-item",
        `Anthropic export content block type ${block.type} was omitted by the adapter`,
        block.type,
        `${messageId}:block:${blockIndex}`,
        recordIndex,
        true,
      );
    }
    if (blocks.some((block) => block.type === "thinking"))
      loss(
        "reasoning-excluded-from-projection",
        "Anthropic Web export thinking is intentionally excluded by capture policy.",
        "thinking",
        messageId,
        recordIndex,
        true,
      );
    let messageEvent: AgentEventEnvelope | undefined;
    if (text.length || toolUseBlocks.length) {
      messageEvent = add(
        "message.created",
        message,
        recordIndex,
        { role, content: text.join("\n").trim(), messageId },
        {
          nativeItemId: messageId,
          ...(message.created_at ? { occurredAt: message.created_at } : {}),
          ...(previous ? { relations: { parent: previous.eventId } } : {}),
          actor: {
            kind: role === "user" ? "human" : role === "assistant" ? "assistant" : "unknown",
          },
        },
      );
    }
    for (const [blockIndex, block] of blocks.entries()) {
      if (block.type === "tool_use") {
        const callId = block.id ?? `${messageId}:tool:${blockIndex}`;
        const callEvent = add(
          "tool.call.proposed",
          message,
          recordIndex,
          {
            id: callId,
            callId,
            name: redact(block.name ?? "tool"),
            arguments: safeJson(block.input),
          },
          {
            nativeItemId: `${callId}:proposal`,
            ...(message.created_at ? { occurredAt: message.created_at } : {}),
            relations: {
              causedBy: [messageEvent?.eventId ?? previous!.eventId],
              parent: messageEvent?.eventId ?? previous!.eventId,
            },
            actor: { kind: "assistant", name: redact(block.name ?? "tool") },
          },
        );
        toolEvents.set(callId, callEvent);
        const approval = block.approval?.toLowerCase();
        if (approval === "approved" || approval === "denied")
          add(
            approval === "approved" ? "tool.call.approved" : "tool.call.denied",
            message,
            recordIndex,
            { callId, decision: approval },
            {
              nativeItemId: `${callId}:approval`,
              ...(message.created_at ? { occurredAt: message.created_at } : {}),
              relations: { causedBy: [callEvent.eventId], parent: callEvent.eventId },
              actor: { kind: "human" },
            },
          );
      }
      if (block.type === "tool_result" && block.tool_use_id) {
        const callEvent = toolEvents.get(block.tool_use_id);
        if (!callEvent)
          loss(
            "relation-target-missing",
            "Anthropic tool result did not identify a previously observed tool call",
            "tool_result",
            block.tool_use_id,
            recordIndex,
            true,
          );
        add(
          "tool.result.observed",
          message,
          recordIndex,
          {
            callId: block.tool_use_id,
            output: resultText(block),
            ...(block.is_error ? { isError: true } : {}),
          },
          {
            nativeItemId: `${messageId}:result:${blockIndex}`,
            ...(message.created_at ? { occurredAt: message.created_at } : {}),
            relations: callEvent
              ? { causedBy: [callEvent.eventId], parent: callEvent.eventId }
              : { parent: previous?.eventId ?? events[0]!.eventId },
            actor: { kind: "tool", name: "tool_result" },
          },
        );
      }
      if (block.type === "tool_result" && !block.tool_use_id)
        loss(
          "relation-target-missing",
          "Anthropic tool result did not include a tool-use identifier",
          "tool_result",
          `${messageId}:result:${blockIndex}`,
          recordIndex,
          true,
        );
    }
    if (events.length === eventCountBefore && semanticLoss.length === lossCountBefore)
      loss(
        "capture-policy-omission",
        "Anthropic export message contained no capturable content",
        "message",
        messageId,
        recordIndex,
        true,
      );
  }
  add(
    "session.ended",
    item,
    0,
    { id: sessionId },
    {
      nativeItemId: `session:${sessionId}:ended`,
      ...(item.updated_at ? { occurredAt: item.updated_at } : {}),
      ...(previous ? { relations: { parent: previous.eventId } } : {}),
    },
  );
  return {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin(sourceBase, redactedHash(records)),
    events,
    semanticLoss,
    partialTail: false,
    sourceItemCount: records.length,
  };
}

export function adaptAnthropicConversation(
  sourcePath: string,
  item: ExportConversation,
  domain: ConversationDomain = "general",
): Conversation {
  return projectConversation(adaptAnthropicEventBatch(sourcePath, item, domain));
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
    if (parsed.version !== 1 || !parsed.sources) failClosed("unsupported corpus manifest");
    return parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1, sources: {} };
    failClosed(error instanceof Error ? error.message : String(error), error);
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
  if (!Array.isArray(conversations))
    failClosed("Anthropic conversations.json must contain an array");

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
      conversation = adaptAnthropicConversation(resolved, item, domain);
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
        const previousConversation = JSON.parse(
          await readFile(
            join(
              root,
              "corpus",
              "objects",
              previous.contentHash.slice(0, 2),
              `${previous.contentHash}.json`,
            ),
            "utf8",
          ),
        ) as Conversation;
        const previousDomain = normalizeConversationDomain(
          previousConversation.domain ?? "general",
        );
        domainOnly =
          previousDomain !== domain &&
          adaptAnthropicConversation(resolved, item, previousDomain).contentHash ===
            previous.contentHash;
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
  const proposalId = sha256(
    JSON.stringify({
      schema: "chatlog/anthropic-import-preview-v1",
      source: resolved,
      sourceContentHash,
      domain,
      proposed,
      invalid,
    }),
  );
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
    if (!Array.isArray(conversations))
      failClosed("Anthropic conversations.json must contain an array");

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
        const batch = adaptAnthropicEventBatch(resolved, item, domain);
        const batchHash = await persistEventBatch(root, batch);
        const conversation = projectConversation(batch);
        const sourceReceipt = buildSourceReceipt({
          batch,
          batchHash,
          conversationProjectionHash: conversation.contentHash,
        });
        await persistSourceReceipt(root, sourceReceipt);
        await persistUnknownShapeNominations(root, [batch], sourceReceipt.source.hash);
        summary.turns += conversation.turns.length;
        const previous = manifest.sources[conversation.sourcePath];
        if (
          previous?.contentHash === conversation.contentHash &&
          previous.eventBatchHash === batchHash &&
          previous.conversationProjectionHash === conversation.contentHash &&
          previous.receiptHash === sourceReceipt.receiptHash
        ) {
          summary.skipped++;
          continue;
        }
        if (previous) replaced++;
        else added++;

        const objectPath = join(
          corpusDir,
          "objects",
          conversation.contentHash.slice(0, 2),
          `${conversation.contentHash}.json`,
        );
        if (!(await Bun.file(objectPath).exists()))
          await atomicWrite(objectPath, JSON.stringify(conversation) + "\n");
        indexEventBatch(db, batch, batchHash, conversation.contentHash);
        indexConversation(db, conversation, source.mtimeMs, source.size);
        manifest.sources[conversation.sourcePath] = {
          size: source.size,
          mtimeMs: source.mtimeMs,
          contentHash: conversation.contentHash,
          eventBatchHash: batchHash,
          conversationProjectionHash: conversation.contentHash,
          receiptHash: sourceReceipt.receiptHash,
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
      derivationStatus:
        options.derive === false ? "not-requested" : derivationError ? "failed" : "completed",
      derived: summary.derived,
      refinery: summary.refinery,
    });
    if (derivationError) {
      const message =
        derivationError instanceof Error ? derivationError.message : String(derivationError);
      failClosed(
        `import committed as receipt ${receipt.receiptId}, but derivation failed: ${redact(message)}`,
      );
    }
    return { ...summary, receipt };
  });
}
