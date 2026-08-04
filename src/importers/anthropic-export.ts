import { lstat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { indexConversation, indexEventBatch, openAnalysis } from "../analysis";
import { projectConversation, validateCanonicalConversation } from "../conversation-projection";
import { validateBoundedRecord } from "../bounded-input";
import { normalizeConversationDomain } from "../domain";
import type { DeriveSummary } from "../derive";
import { durableAtomicWrite } from "../durable-fs";
import { persistEventBatch } from "../event-store";
import {
  capture,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  makeSemanticLoss,
  redactedHash,
  type AgentEventEnvelope,
  type CaptureDisposition,
  type EventBatch,
} from "../events";
import { redact } from "../redact";
import type { Conversation, ConversationDomain } from "../types";
import { manifestSourcesHash, type ImportReceipt } from "../import-receipts";
import { withIngestLock } from "../lock";
import {
  createOperationIntent,
  recoverPendingOperations,
  resolveManifestWriteFailure,
  resumeCommittedOperation,
} from "../operation-intents";
import type { RefinerySummary } from "../refinery";
import { reconcileSourceAuthority } from "../source-authority";
import {
  buildSourceReceipt,
  persistSourceReceipt,
  persistUnknownShapeNominations,
} from "../source-receipts";
import {
  EXPORT_MAX_ARCHIVE_BYTES,
  EXPORT_MAX_CORPUS_OBJECT_BYTES,
  EXPORT_MAX_FILE_BYTES,
  EXPORT_MAX_MANIFEST_BYTES,
  EXPORT_MAX_MEMBER_BYTES,
  EXPORT_MAX_STDERR_BYTES,
  EXPORT_MAX_TOTAL_BYTES,
  ExportFileTypeError,
  ExportLimitError,
  type ExportLimitFailure,
  readBoundedFile,
  readBoundedTextStream,
} from "./export-limits";
export {
  EXPORT_MAX_ARCHIVE_BYTES as ANTHROPIC_MAX_ARCHIVE_BYTES,
  EXPORT_MAX_CORPUS_OBJECT_BYTES as ANTHROPIC_MAX_CORPUS_OBJECT_BYTES,
  EXPORT_MAX_FILE_BYTES as ANTHROPIC_MAX_FILE_BYTES,
  EXPORT_MAX_MANIFEST_BYTES as ANTHROPIC_MAX_MANIFEST_BYTES,
  EXPORT_MAX_MEMBER_BYTES as ANTHROPIC_MAX_MEMBER_BYTES,
  EXPORT_MAX_TOTAL_BYTES as ANTHROPIC_MAX_TOTAL_BYTES,
} from "./export-limits";
export class AnthropicExportError extends Error {
  readonly code = "anthropic-export-invalid";
}

function failClosed(message: string, cause?: unknown): never {
  throw new AnthropicExportError(message, cause === undefined ? undefined : { cause });
}
export const ANTHROPIC_MAX_CONVERSATIONS = 4_096;
export const ANTHROPIC_MAX_MESSAGES_PER_CONVERSATION = 100_000;
export const ANTHROPIC_MAX_CONTENT_BLOCKS_PER_MESSAGE = 100_000;
export const ANTHROPIC_MAX_ATTACHMENTS_PER_MESSAGE = 16_384;
export const ANTHROPIC_MAX_FILES_PER_MESSAGE = 16_384;
export const ANTHROPIC_MAX_ATTACHMENTS = 200_000;
export const ANTHROPIC_MAX_FILES = 200_000;
export const ANTHROPIC_MAX_EMITTED_EVENTS = 200_000;
export const ANTHROPIC_MAX_SEMANTIC_LOSSES = 32_768;
const ANTHROPIC_RECORD_LIMITS = {
  maxDepth: 32,
  maxKeys: 500_000,
  maxArrayItems: ANTHROPIC_MAX_CONTENT_BLOCKS_PER_MESSAGE,
  maxStringLength: 4 * 1024 * 1024,
  maxBytes: EXPORT_MAX_MEMBER_BYTES,
} as const;

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
  preview: Pick<AnthropicPreviewSummary, "source" | "sourceContentHash" | "proposalId">;
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

function boundedFailure(error: ExportLimitFailure): never {
  return failClosed(error.message, error);
}

function rejectUnknown<T>(error: unknown): Promise<T> {
  return Promise.reject(error);
}

async function readExportJson(path: string, member: string): Promise<string> {
  try {
    const source = resolve(path);
    const info = await lstat(source);
    if (info.isDirectory()) {
      const contentResult = await readBoundedFile(
        join(source, member),
        EXPORT_MAX_FILE_BYTES,
        `${source}#${member}`,
        source,
      );
      if (!contentResult.ok) return boundedFailure(contentResult.error);
      const content = contentResult.value;
      if (content.bytes > EXPORT_MAX_TOTAL_BYTES)
        return boundedFailure(
          new ExportLimitError("total", EXPORT_MAX_TOTAL_BYTES, content.bytes, source),
        );
      return content.text;
    }
    if (extname(source).toLowerCase() !== ".zip")
      failClosed("Anthropic export must be a directory or .zip archive");
    if (!info.isFile()) failClosed(`${source}: Anthropic archive is not a regular file`);
    if (info.size > EXPORT_MAX_ARCHIVE_BYTES)
      return boundedFailure(
        new ExportLimitError("archive", EXPORT_MAX_ARCHIVE_BYTES, info.size, source),
      );

    const child = Bun.spawn(["unzip", "-p", source, member], {
      stdout: "pipe",
      stderr: "pipe",
    });
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    try {
      if (!child.stdout || !child.stderr)
        failClosed("Anthropic export reader did not provide pipes");
      const [textResult, errorResult, exitCode] = await Promise.all([
        readBoundedTextStream(
          child.stdout,
          EXPORT_MAX_MEMBER_BYTES,
          "member",
          `${source}#${member}`,
          stop,
        ),
        readBoundedTextStream(
          child.stderr,
          EXPORT_MAX_STDERR_BYTES,
          "stderr",
          "Anthropic export diagnostic output",
          stop,
        ),
        child.exited,
      ]);
      if (!textResult.ok) return boundedFailure(textResult.error);
      if (!errorResult.ok) return boundedFailure(errorResult.error);
      const text = textResult.value;
      const error = errorResult.value;
      if (exitCode !== 0)
        failClosed(`cannot read ${member} from Anthropic export: ${redact(error.text.trim())}`);
      if (text.bytes > EXPORT_MAX_TOTAL_BYTES)
        return boundedFailure(
          new ExportLimitError("total", EXPORT_MAX_TOTAL_BYTES, text.bytes, `${source}#${member}`),
        );
      return text.text;
    } catch (error) {
      child.kill();
      await child.exited.catch(() => undefined);
      if (error instanceof ExportLimitError || error instanceof ExportFileTypeError)
        return boundedFailure(error);
      return rejectUnknown(error);
    }
  } catch (error) {
    if (error instanceof ExportLimitError || error instanceof ExportFileTypeError)
      return boundedFailure(error);
    return rejectUnknown(error);
  }
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
  const bounded = validateBoundedRecord(item, sourcePath, ANTHROPIC_RECORD_LIMITS);
  if (!bounded.ok) failClosed(bounded.error);
  if (!item.uuid) failClosed(`${sourcePath}: conversation without uuid`);
  const messages = item.chat_messages ?? [];
  if (!Array.isArray(messages))
    failClosed(`${sourcePath}#${item.uuid}: chat_messages must be an array`);
  if (messages.length > ANTHROPIC_MAX_MESSAGES_PER_CONVERSATION)
    failClosed(
      `${sourcePath}#${item.uuid}: Anthropic export exceeds the ${ANTHROPIC_MAX_MESSAGES_PER_CONVERSATION}-message limit`,
    );
  for (const [messageIndex, message] of messages.entries()) {
    const boundedMessage = validateBoundedRecord(
      message,
      `${sourcePath}#${item.uuid}/chat_messages/${messageIndex}`,
      ANTHROPIC_RECORD_LIMITS,
    );
    if (!boundedMessage.ok) failClosed(boundedMessage.error);
    if (
      message.content !== undefined &&
      message.content !== null &&
      !Array.isArray(message.content)
    )
      failClosed(
        `${sourcePath}#${item.uuid}/chat_messages/${messageIndex}/content must be an array`,
      );
    if (
      message.attachments !== undefined &&
      message.attachments !== null &&
      !Array.isArray(message.attachments)
    )
      failClosed(
        `${sourcePath}#${item.uuid}/chat_messages/${messageIndex}/attachments must be an array`,
      );
    if (message.files !== undefined && message.files !== null && !Array.isArray(message.files))
      failClosed(`${sourcePath}#${item.uuid}/chat_messages/${messageIndex}/files must be an array`);
    if ((message.content?.length ?? 0) > ANTHROPIC_MAX_CONTENT_BLOCKS_PER_MESSAGE)
      failClosed(
        `${sourcePath}#${item.uuid}/chat_messages/${messageIndex}: Anthropic export exceeds the ${ANTHROPIC_MAX_CONTENT_BLOCKS_PER_MESSAGE}-content-block limit`,
      );
    if ((message.attachments?.length ?? 0) > ANTHROPIC_MAX_ATTACHMENTS_PER_MESSAGE)
      failClosed(
        `${sourcePath}#${item.uuid}/chat_messages/${messageIndex}: Anthropic export exceeds the ${ANTHROPIC_MAX_ATTACHMENTS_PER_MESSAGE}-attachment limit`,
      );
    if ((message.files?.length ?? 0) > ANTHROPIC_MAX_FILES_PER_MESSAGE)
      failClosed(
        `${sourcePath}#${item.uuid}/chat_messages/${messageIndex}: Anthropic export exceeds the ${ANTHROPIC_MAX_FILES_PER_MESSAGE}-file limit`,
      );
  }
  const resolvedSource = `${resolve(sourcePath)}#conversations/${item.uuid}`;
  const sessionId = item.uuid;
  const records: unknown[] = [item, ...messages];
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
    if (semanticLoss.length >= ANTHROPIC_MAX_SEMANTIC_LOSSES)
      failClosed(
        `${sourcePath}#${item.uuid}: Anthropic export exceeds the ${ANTHROPIC_MAX_SEMANTIC_LOSSES}-semantic-loss limit`,
      );
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
      capture?: CaptureDisposition;
      scope?: AgentEventEnvelope["scope"];
    },
  ): AgentEventEnvelope => {
    if (events.length >= ANTHROPIC_MAX_EMITTED_EVENTS)
      failClosed(
        `${sourcePath}#${item.uuid}: Anthropic export exceeds the ${ANTHROPIC_MAX_EMITTED_EVENTS}-event limit`,
      );
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
  await durableAtomicWrite(path, text);
}

async function loadManifest(path: string, root: string): Promise<CorpusManifest> {
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { version: 1, sources: {} };
    failClosed(
      `cannot read Anthropic corpus manifest ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
  if (!info.isFile()) failClosed(`${path}: Anthropic corpus manifest is not a regular file`);
  const contentResult = await readBoundedFile(
    path,
    EXPORT_MAX_MANIFEST_BYTES,
    `${path} (Anthropic corpus manifest)`,
    root,
  );
  if (!contentResult.ok) return boundedFailure(contentResult.error);
  try {
    const parsed = JSON.parse(contentResult.value.text) as CorpusManifest;
    if (parsed.version !== 1 || !parsed.sources) failClosed("unsupported corpus manifest");
    return parsed;
  } catch (error: unknown) {
    if (error instanceof AnthropicExportError) throw error;
    failClosed(
      `cannot parse Anthropic corpus manifest ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
}

async function readPriorConversation(
  root: string,
  contentHash: string,
  sourcePath: string,
): Promise<Conversation | null> {
  const path = join(root, "corpus", "objects", contentHash.slice(0, 2), `${contentHash}.json`);
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return null;
    failClosed(
      `cannot read Anthropic prior corpus object ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
  if (!info.isFile()) failClosed(`${path}: Anthropic prior corpus object is not a regular file`);
  const contentResult = await readBoundedFile(
    path,
    EXPORT_MAX_CORPUS_OBJECT_BYTES,
    `${path} (Anthropic prior corpus object)`,
    root,
  );
  if (!contentResult.ok) return boundedFailure(contentResult.error);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentResult.value.text);
  } catch (error: unknown) {
    failClosed(
      `cannot parse Anthropic prior corpus object ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
  const conversation = validateCanonicalConversation(parsed, { contentHash, sourcePath });
  if (!conversation) failClosed(`${path}: Anthropic prior corpus object hash or shape mismatch`);
  return conversation;
}

export async function previewAnthropicExport(
  sourcePath: string,
  root: string,
  options: Pick<AnthropicImportOptions, "domain"> = {},
): Promise<AnthropicPreviewSummary> {
  const domain = normalizeConversationDomain(options.domain ?? "general");
  const resolved = resolve(sourcePath);
  const sourceInfo = await lstat(resolved);
  const exportText = await readExportJson(resolved, "conversations.json");
  const conversations = JSON.parse(exportText) as ExportConversation[];
  if (!Array.isArray(conversations))
    failClosed("Anthropic conversations.json must contain an array");
  if (conversations.length > ANTHROPIC_MAX_CONVERSATIONS)
    failClosed(
      `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_CONVERSATIONS}-conversation limit`,
    );

  const manifest = await loadManifest(join(root, "corpus", "manifest.json"), root);
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
    } catch (error) {
      if (error instanceof AnthropicExportError) throw error;
      invalid++;
      continue;
    }
    importable++;
    let itemAttachments = 0;
    let itemFiles = 0;
    for (const message of item.chat_messages ?? []) {
      itemAttachments += message.attachments?.length ?? 0;
      itemFiles += message.files?.length ?? 0;
    }
    if (attachments > ANTHROPIC_MAX_ATTACHMENTS - itemAttachments)
      failClosed(
        `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_ATTACHMENTS}-attachment export limit`,
      );
    if (files > ANTHROPIC_MAX_FILES - itemFiles)
      failClosed(
        `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_FILES}-file export limit`,
      );
    if (turns > ANTHROPIC_MAX_EMITTED_EVENTS - conversation.turns.length)
      failClosed(
        `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_EMITTED_EVENTS}-turn export limit`,
      );
    attachments += itemAttachments;
    files += itemFiles;
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
        const previousConversation = await readPriorConversation(
          root,
          previous.contentHash,
          conversation.sourcePath,
        );
        if (previousConversation) {
          const previousDomain = normalizeConversationDomain(
            previousConversation.domain ?? "general",
          );
          domainOnly =
            previousDomain !== domain &&
            adaptAnthropicConversation(resolved, item, previousDomain).contentHash ===
              previous.contentHash;
        }
      } catch (error) {
        if (error instanceof AnthropicExportError) throw error;
        // A missing or unreadable prior object means preview cannot prove
        // this is a domain-only change, so it remains conservatively changed.
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
      manifestAuthorityHash: manifestSourcesHash(manifest.sources),
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
  options: AnthropicImportOptions,
): Promise<AnthropicImportSummary> {
  const expectedPreview = options.preview;
  if (!expectedPreview) failClosed("Anthropic import requires preview proposal pins");
  return withIngestLock(root, async () => {
    await recoverPendingOperations(root);
    const domain = normalizeConversationDomain(options.domain ?? "general");
    const current = await previewAnthropicExport(sourcePath, root, { domain });
    if (
      !current.ready ||
      current.source !== expectedPreview.source ||
      current.sourceContentHash !== expectedPreview.sourceContentHash ||
      current.proposalId !== expectedPreview.proposalId
    )
      failClosed(`${resolve(sourcePath)}: source no longer matches the preview proposal`);
    const resolved = resolve(sourcePath);
    const source = await lstat(resolved);
    const exportText = await readExportJson(resolved, "conversations.json");
    const sourceContentHash = sha256(exportText);
    if (
      expectedPreview &&
      (resolved !== expectedPreview.source ||
        sourceContentHash !== expectedPreview.sourceContentHash)
    )
      failClosed(`${resolved}: source changed after the preview proposal was checked`);
    const conversations = JSON.parse(exportText) as ExportConversation[];
    if (!Array.isArray(conversations))
      failClosed("Anthropic conversations.json must contain an array");
    if (conversations.length > ANTHROPIC_MAX_CONVERSATIONS)
      failClosed(
        `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_CONVERSATIONS}-conversation limit`,
      );

    const corpusDir = join(root, "corpus");
    const manifestPath = join(corpusDir, "manifest.json");
    const manifest = await loadManifest(manifestPath, root);
    const beforeManifest = structuredClone(manifest);
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
    let totalEvents = 0;
    let totalSemanticLosses = 0;

    try {
      await reconcileSourceAuthority(root, db, manifest.sources);
      for (const item of conversations) {
        const batch = adaptAnthropicEventBatch(resolved, item, domain);
        if (totalEvents > ANTHROPIC_MAX_EMITTED_EVENTS - batch.events.length)
          failClosed(
            `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_EMITTED_EVENTS}-event export limit`,
          );
        if (totalSemanticLosses > ANTHROPIC_MAX_SEMANTIC_LOSSES - batch.semanticLoss.length)
          failClosed(
            `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_SEMANTIC_LOSSES}-semantic-loss export limit`,
          );
        totalEvents += batch.events.length;
        totalSemanticLosses += batch.semanticLoss.length;
        const itemAttachments = (item.chat_messages ?? []).reduce(
          (sum, message) => sum + (message.attachments?.length ?? 0),
          0,
        );
        const itemFiles = (item.chat_messages ?? []).reduce(
          (sum, message) => sum + (message.files?.length ?? 0),
          0,
        );
        if (summary.attachments > ANTHROPIC_MAX_ATTACHMENTS - itemAttachments)
          failClosed(
            `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_ATTACHMENTS}-attachment export limit`,
          );
        if (summary.files > ANTHROPIC_MAX_FILES - itemFiles)
          failClosed(
            `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_FILES}-file export limit`,
          );
        summary.attachments += itemAttachments;
        summary.files += itemFiles;
        const batchHash = await persistEventBatch(root, batch);
        const conversation = projectConversation(batch);
        const sourceReceipt = buildSourceReceipt({
          batch,
          batchHash,
          conversationProjectionHash: conversation.contentHash,
        });
        await persistSourceReceipt(root, sourceReceipt);
        await persistUnknownShapeNominations(root, [batch], sourceReceipt.source.hash);
        if (summary.turns > ANTHROPIC_MAX_EMITTED_EVENTS - conversation.turns.length)
          failClosed(
            `${resolved}: Anthropic export exceeds the ${ANTHROPIC_MAX_EMITTED_EVENTS}-turn export limit`,
          );
        summary.turns += conversation.turns.length;
        const previous = manifest.sources[conversation.sourcePath];
        const objectPath = join(
          corpusDir,
          "objects",
          conversation.contentHash.slice(0, 2),
          `${conversation.contentHash}.json`,
        );
        const existing = await readPriorConversation(
          root,
          conversation.contentHash,
          conversation.sourcePath,
        );
        if (!existing) await atomicWrite(objectPath, JSON.stringify(conversation) + "\n");
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
    } finally {
      db.close();
    }

    const intent = await createOperationIntent(root, {
      operation: "anthropic-import",
      before: beforeManifest,
      after: manifest,
      derive: options.derive !== false,
      receipt: {
        kind: "import",
        input: {
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
        },
      },
    });
    try {
      await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    } catch (error) {
      await resolveManifestWriteFailure(root, intent, error);
    }
    const operation = await resumeCommittedOperation(root, intent);
    const receipt = operation.receipt;
    if (!receipt) throw new Error("committed import operation produced no receipt");
    summary.derived = operation.derived;
    summary.refinery = operation.refinery;
    if (operation.derivationFailed) {
      throw new Error(
        `import committed as receipt ${receipt.receiptId}, but derived state was explicitly invalidated after derivation failed`,
      );
    }
    return { ...summary, receipt };
  });
}
