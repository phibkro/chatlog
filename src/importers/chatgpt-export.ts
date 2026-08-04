import { chmod, lstat, mkdir, opendir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { indexConversation, indexEventBatch, openAnalysis } from "../analysis";
import { projectConversation } from "../conversation-projection";
import { normalizeConversationDomain } from "../domain";
import { validateBoundedRecord } from "../bounded-input";
import { persistEventBatch } from "../event-store";
import {
  capture,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  makeSemanticLoss,
  sha256,
  stableStringify,
  type CaptureDisposition,
  type AgentEventEnvelope,
  type EventBatch,
  type SemanticLossCode,
} from "../events";
import { reconcileSourceAuthority, type CorpusManifest } from "../source-authority";
import { buildSourceReceipt, persistSourceReceipt, type SourceReceipt } from "../source-receipts";
import { withIngestLock } from "../lock";
import { redact } from "../redact";
import type { Conversation, ConversationDomain } from "../types";
import type { DeriveSummary } from "../derive";
import type { RefinerySummary } from "../refinery";
import { deriveCorpus } from "../derive";
import {
  EXPORT_MAX_ARCHIVE_BYTES,
  EXPORT_MAX_CORPUS_OBJECT_BYTES,
  EXPORT_MAX_FILE_BYTES,
  EXPORT_MAX_LISTING_BYTES,
  EXPORT_MAX_MANIFEST_BYTES,
  EXPORT_MAX_MEMBER_BYTES,
  EXPORT_MAX_MEMBERS,
  EXPORT_MAX_STDERR_BYTES,
  EXPORT_MAX_TOTAL_BYTES,
  ExportFileTypeError,
  ExportLimitError,
  type ExportLimitFailure,
  readBoundedFile,
  readBoundedTextStream,
} from "./export-limits";
export {
  EXPORT_MAX_ARCHIVE_BYTES as CHATGPT_MAX_ARCHIVE_BYTES,
  EXPORT_MAX_CORPUS_OBJECT_BYTES as CHATGPT_MAX_CORPUS_OBJECT_BYTES,
  EXPORT_MAX_FILE_BYTES as CHATGPT_MAX_FILE_BYTES,
  EXPORT_MAX_LISTING_BYTES as CHATGPT_MAX_LISTING_BYTES,
  EXPORT_MAX_MANIFEST_BYTES as CHATGPT_MAX_MANIFEST_BYTES,
  EXPORT_MAX_MEMBER_BYTES as CHATGPT_MAX_MEMBER_BYTES,
  EXPORT_MAX_MEMBERS as CHATGPT_MAX_MEMBERS,
  EXPORT_MAX_TOTAL_BYTES as CHATGPT_MAX_TOTAL_BYTES,
} from "./export-limits";
import { refineCorpus } from "../refinery";
export class ChatGPTExportError extends Error {
  readonly code = "chatgpt-export-invalid";
}

function failClosed(message: string, cause?: unknown): never {
  throw new ChatGPTExportError(message, cause === undefined ? undefined : { cause });
}

const CHATGPT_RECIPE = "chatlog-chatgpt-export-events-v1";
const CHATGPT_CAPTURE_POLICY = "chatlog-redacted-capture-v1";
export const CHATGPT_MAX_DIRECTORY_ENTRIES = 4_096;
export const CHATGPT_MAX_DIRECTORY_DEPTH = 32;
export const CHATGPT_MAX_CONVERSATIONS = 4_096;
export const CHATGPT_MAX_MAPPING_CHILDREN_PER_NODE = 256;
export const CHATGPT_MAX_MAPPING_CHILDREN_EDGES = 100_000;
export const CHATGPT_MAX_CONTENT_PARTS_PER_MESSAGE = 256;
export const CHATGPT_MAX_CONTENT_PARTS = 16_384;
export const CHATGPT_MAX_ATTACHMENTS_PER_MESSAGE = 256;
export const CHATGPT_MAX_ATTACHMENTS = 16_384;
export const CHATGPT_MAX_WARNINGS = 32_768;
export const CHATGPT_MAX_SEMANTIC_LOSSES = 32_768;
export const CHATGPT_MAX_EMITTED_EVENTS = 200_000;
const MAX_MAPPING_NODES = 100_000;
const CHATGPT_RECORD_LIMITS = {
  maxDepth: 32,
  maxKeys: 500_000,
  maxArrayItems: CHATGPT_MAX_CONTENT_PARTS,
  maxStringLength: 4 * 1024 * 1024,
  maxBytes: EXPORT_MAX_MEMBER_BYTES,
} as const;

export interface ChatGPTMessageInput {
  id?: unknown;
  author?: unknown;
  create_time?: unknown;
  update_time?: unknown;
  content?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface ChatGPTMappingNodeInput {
  id?: unknown;
  parent?: unknown;
  children?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

export interface ChatGPTConversationInput {
  id?: unknown;
  conversation_id?: unknown;
  title?: unknown;
  create_time?: unknown;
  update_time?: unknown;
  current_node?: unknown;
  mapping?: unknown;
  [key: string]: unknown;
}

export interface ChatGPTWarning {
  code:
    | "missing_current_node"
    | "unknown_current_node"
    | "graph_cycle"
    | "dangling_parent"
    | "dangling_child"
    | "children_disagreement"
    | "unknown_content"
    | "unknown_role"
    | "invalid_timestamp"
    | "invalid_node"
    | "invalid_message"
    | "field_mismatch";
  location: string;
}
function pushChatGPTWarning(warnings: ChatGPTWarning[], warning: ChatGPTWarning): void {
  if (warnings.length >= CHATGPT_MAX_WARNINGS)
    failClosed(
      `${warning.location}: ChatGPT export exceeds the ${CHATGPT_MAX_WARNINGS}-warning limit`,
    );
  warnings.push(warning);
}

export interface ChatGPTParsedMessage {
  messageId: string | null;
  role: string;
  rawRole: unknown;
  rawAuthor: Record<string, unknown>;
  authorExtras: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  rawCreateTime: unknown;
  rawUpdateTime: unknown;
  textParts: readonly string[];
  contentType: string | null;
  contentKnown: boolean;
  unknownParts: readonly unknown[];
  rawContent: unknown;
  metadata: Record<string, unknown> | null;
  attachments: readonly Record<string, unknown>[];
  sourceExtras: Record<string, unknown>;
  rawMessage: Record<string, unknown>;
}

export interface ChatGPTParsedNode {
  nodeId: string;
  embeddedNodeId: string | null;
  parentNodeId: string | null;
  rawParent: unknown;
  sourceChildrenNodeIds: readonly string[] | null;
  childrenNodeIds: readonly string[];
  message: ChatGPTParsedMessage | null;
  sourceExtras: Record<string, unknown>;
  rawNode: unknown;
}

export interface ChatGPTParsedConversation {
  id: string;
  title: string | null;
  createTime: string | null;
  updateTime: string | null;
  rawCreateTime: unknown;
  rawUpdateTime: unknown;
  currentNodeId: string | null;
  currentPathNodeIds: readonly string[];
  visiblePathNodeIds: readonly string[];
  mapping: Readonly<Record<string, ChatGPTParsedNode>>;
  nodes: readonly ChatGPTParsedNode[];
  sourceExtras: Record<string, unknown>;
  rawConversation: ChatGPTConversationInput;
  sourceMember?: string;
  warnings: readonly ChatGPTWarning[];
  branchCount: number;
  attachmentCount: number;
  unknownCount: number;
  omittedCount: number;
}

export interface ChatGPTExportMember {
  path: string;
  text: string;
}

export interface ChatGPTExportReadResult {
  source: string;
  sourceBytes: number;
  sourceModifiedAt: string;
  sourceContentHash: string;
  members: readonly ChatGPTExportMember[];
  conversations: readonly ChatGPTParsedConversation[];
}

export interface ChatGPTReadOptions {
  beforeVerification?: () => void | Promise<void>;
}

export interface ChatGPTImportOptions {
  domain?: ConversationDomain;
  derive?: boolean;
}

export interface ChatGPTPreviewSummary {
  schema: "chatlog/chatgpt-import-preview-v1";
  advisory: true;
  ready: boolean;
  source: string;
  sourceBytes: number;
  sourceModifiedAt: string;
  sourceContentHash: string;
  domain: string;
  receiptId: string;
  proposalId: string;
  discovered: number;
  importable: number;
  invalid: number;
  conversations: number;
  messages: number;
  branches: number;
  attachments: number;
  unknown: number;
  omitted: number;
  new: number;
  changed: number;
  reclassified: number;
  unchanged: number;
  wouldImport: number;
  dateRange: { first: string | null; last: string | null };
  selectedDomain: string;
  exclusions: {
    attachmentBodies: true;
    accountMemories: true;
    customInstructions: true;
    fileBodies: true;
    reasoningInterface: true;
  };
}

export interface ChatGPTImportSummary {
  source: string;
  domain: string;
  discovered: number;
  imported: number;
  skipped: number;
  conversations: number;
  messages: number;
  branches: number;
  attachments: number;
  unknown: number;
  omitted: number;
  receipts: readonly SourceReceipt[];
  receipt: SourceReceipt;
  derived?: DeriveSummary;
  refinery?: RefinerySummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unknownFields(
  value: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> {
  const knownSet = new Set(known);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !knownSet.has(key)));
}

function parseEpoch(value: unknown, location: string, warnings: ChatGPTWarning[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushChatGPTWarning(warnings, { code: "invalid_timestamp", location });
    return null;
  }
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.valueOf())) {
    pushChatGPTWarning(warnings, { code: "invalid_timestamp", location });
    return null;
  }
  return date.toISOString();
}

interface ChatGPTConversationCardinality {
  contentParts: number;
  attachments: number;
}

function parseMessage(
  value: unknown,
  location: string,
  warnings: ChatGPTWarning[],
  cardinality: ChatGPTConversationCardinality,
): ChatGPTParsedMessage | null {
  if (!isRecord(value)) {
    pushChatGPTWarning(warnings, { code: "invalid_message", location });
    return null;
  }
  const author = isRecord(value.author) ? value.author : {};
  const rawRole = author.role;
  const role = text(rawRole) ?? "unknown";
  if (!["user", "assistant", "system", "tool", "developer"].includes(role))
    pushChatGPTWarning(warnings, { code: "unknown_role", location: `${location}/author/role` });
  const bounded = validateBoundedRecord(value, location, CHATGPT_RECORD_LIMITS);
  if (!bounded.ok) failClosed(bounded.error);
  const content = value.content;
  let contentType: string | null = null;
  const textParts: string[] = [];
  const unknownParts: unknown[] = [];
  let contentKnown = false;
  if (isRecord(content)) {
    const rawParts = content.parts;
    if (Array.isArray(rawParts)) {
      if (rawParts.length > CHATGPT_MAX_CONTENT_PARTS_PER_MESSAGE)
        failClosed(
          `${location}/content/parts: ChatGPT export exceeds the ${CHATGPT_MAX_CONTENT_PARTS_PER_MESSAGE}-part message limit`,
        );
      if (cardinality.contentParts > CHATGPT_MAX_CONTENT_PARTS - rawParts.length)
        failClosed(
          `${location}/content/parts: ChatGPT export exceeds the ${CHATGPT_MAX_CONTENT_PARTS}-part conversation limit`,
        );
      cardinality.contentParts += rawParts.length;
    }
    contentType = text(content.content_type);
    if (contentType === "text" || contentType === "multimodal_text") {
      if (Array.isArray(rawParts)) {
        contentKnown = true;
        for (const [index, part] of rawParts.entries()) {
          if (typeof part === "string") textParts.push(redact(part));
          else {
            unknownParts.push(part);
            pushChatGPTWarning(warnings, {
              code: "unknown_content",
              location: `${location}/content/parts/${index}`,
            });
          }
        }
      } else {
        pushChatGPTWarning(warnings, {
          code: "unknown_content",
          location: `${location}/content/parts`,
        });
        unknownParts.push(content.parts);
      }
    } else {
      pushChatGPTWarning(warnings, {
        code: "unknown_content",
        location: `${location}/content/content_type`,
      });
      unknownParts.push(content);
    }
  } else if (content !== undefined && content !== null) {
    pushChatGPTWarning(warnings, { code: "unknown_content", location: `${location}/content` });
    unknownParts.push(content);
  }
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  const rawAttachments = metadata?.attachments;
  let attachments: Record<string, unknown>[] = [];
  if (Array.isArray(rawAttachments)) {
    if (rawAttachments.length > CHATGPT_MAX_ATTACHMENTS_PER_MESSAGE)
      failClosed(
        `${location}/metadata/attachments: ChatGPT export exceeds the ${CHATGPT_MAX_ATTACHMENTS_PER_MESSAGE}-attachment message limit`,
      );
    if (cardinality.attachments > CHATGPT_MAX_ATTACHMENTS - rawAttachments.length)
      failClosed(
        `${location}/metadata/attachments: ChatGPT export exceeds the ${CHATGPT_MAX_ATTACHMENTS}-attachment conversation limit`,
      );
    cardinality.attachments += rawAttachments.length;
    attachments = rawAttachments.filter(isRecord);
  }
  return {
    messageId: text(value.id),
    role,
    rawRole,
    rawAuthor: author,
    authorExtras: unknownFields(author, ["role"]),
    createdAt: parseEpoch(value.create_time, `${location}/create_time`, warnings),
    updatedAt: parseEpoch(value.update_time, `${location}/update_time`, warnings),
    rawCreateTime: value.create_time,
    rawUpdateTime: value.update_time,
    textParts,
    contentType,
    contentKnown,
    unknownParts,
    rawContent: content,
    metadata,
    attachments,
    sourceExtras: unknownFields(value, [
      "id",
      "author",
      "create_time",
      "update_time",
      "content",
      "metadata",
    ]),
    rawMessage: value,
  };
}

export function parseChatGPTConversation(
  value: unknown,
  sourceMember = "conversations.json",
): ChatGPTParsedConversation {
  if (!isRecord(value)) failClosed(`${sourceMember}: conversation must be an object`);
  const id = text(value.id) ?? text(value.conversation_id);
  if (!id) failClosed(`${sourceMember}: conversation id is required`);
  const bounded = validateBoundedRecord(value, `${sourceMember}#${id}`, CHATGPT_RECORD_LIMITS);
  if (!bounded.ok) failClosed(bounded.error);
  if (!isRecord(value.mapping)) failClosed(`${sourceMember}#${id}: mapping must be an object`);
  const mappingInput = value.mapping;
  const warnings: ChatGPTWarning[] = [];
  const cardinality: ChatGPTConversationCardinality = { contentParts: 0, attachments: 0 };
  const mapping = Object.create(null) as Record<string, ChatGPTParsedNode>;
  let childEdges = 0;
  const rawEntries = Object.entries(mappingInput);
  if (rawEntries.length > MAX_MAPPING_NODES)
    failClosed(`${sourceMember}#${id}: mapping exceeds node limit`);
  for (const [nodeId, rawValue] of rawEntries) {
    if (!isRecord(rawValue)) {
      pushChatGPTWarning(warnings, {
        code: "invalid_node",
        location: `${sourceMember}#${id}/mapping/${nodeId}`,
      });
      mapping[nodeId] = {
        nodeId,
        embeddedNodeId: null,
        parentNodeId: null,
        rawParent: undefined,
        sourceChildrenNodeIds: null,
        childrenNodeIds: [],
        message: null,
        sourceExtras: { rawNode: rawValue },
        rawNode: rawValue,
      };
      continue;
    }
    const boundedNode = validateBoundedRecord(
      rawValue,
      `${sourceMember}#${id}/mapping/${nodeId}`,
      CHATGPT_RECORD_LIMITS,
    );
    if (!boundedNode.ok) failClosed(boundedNode.error);
    const embeddedNodeId = text(rawValue.id);
    if (embeddedNodeId && embeddedNodeId !== nodeId)
      pushChatGPTWarning(warnings, {
        code: "field_mismatch",
        location: `${sourceMember}#${id}/mapping/${nodeId}/id`,
      });
    const rawParent = rawValue.parent;
    const parentNodeId = rawParent === null || rawParent === undefined ? null : text(rawParent);
    if (rawParent !== null && rawParent !== undefined && !parentNodeId)
      pushChatGPTWarning(warnings, {
        code: "dangling_parent",
        location: `${sourceMember}#${id}/mapping/${nodeId}/parent`,
      });
    let sourceChildrenNodeIds: string[] | null = null;
    if (rawValue.children !== undefined) {
      if (Array.isArray(rawValue.children)) {
        if (rawValue.children.length > CHATGPT_MAX_MAPPING_CHILDREN_PER_NODE)
          failClosed(
            `${sourceMember}#${id}/mapping/${nodeId}/children: ChatGPT export exceeds the ${CHATGPT_MAX_MAPPING_CHILDREN_PER_NODE}-child node limit`,
          );
        if (childEdges > CHATGPT_MAX_MAPPING_CHILDREN_EDGES - rawValue.children.length)
          failClosed(
            `${sourceMember}#${id}/mapping/${nodeId}/children: ChatGPT export exceeds the ${CHATGPT_MAX_MAPPING_CHILDREN_EDGES}-child edge limit`,
          );
        childEdges += rawValue.children.length;
        if (rawValue.children.every((child) => typeof child === "string"))
          sourceChildrenNodeIds = [...rawValue.children];
        else
          pushChatGPTWarning(warnings, {
            code: "dangling_child",
            location: `${sourceMember}#${id}/mapping/${nodeId}/children`,
          });
      } else
        pushChatGPTWarning(warnings, {
          code: "dangling_child",
          location: `${sourceMember}#${id}/mapping/${nodeId}/children`,
        });
    }
    const message =
      rawValue.message === null || rawValue.message === undefined
        ? null
        : parseMessage(
            rawValue.message,
            `${sourceMember}#${id}/mapping/${nodeId}/message`,
            warnings,
            cardinality,
          );
    mapping[nodeId] = {
      nodeId,
      embeddedNodeId,
      parentNodeId,
      rawParent,
      sourceChildrenNodeIds,
      childrenNodeIds: [],
      message,
      sourceExtras: unknownFields(rawValue, ["id", "parent", "children", "message"]),
      rawNode: rawValue,
    };
  }
  const derivedChildren = new Map<string, string[]>();
  for (const nodeId of Object.keys(mapping)) derivedChildren.set(nodeId, []);
  for (const node of Object.values(mapping)) {
    if (node.parentNodeId === null) continue;
    const children = derivedChildren.get(node.parentNodeId);
    if (!children) {
      pushChatGPTWarning(warnings, {
        code: "dangling_parent",
        location: `${sourceMember}#${id}/mapping/${node.nodeId}/parent`,
      });
      continue;
    }
    children.push(node.nodeId);
  }
  for (const node of Object.values(mapping)) {
    const children = (derivedChildren.get(node.nodeId) ?? []).toSorted();
    node.childrenNodeIds = children;
    if (node.sourceChildrenNodeIds !== null) {
      const sourceChildren = [...node.sourceChildrenNodeIds].toSorted();
      if (stableStringify(sourceChildren) !== stableStringify(children))
        pushChatGPTWarning(warnings, {
          code: "children_disagreement",
          location: `${sourceMember}#${id}/mapping/${node.nodeId}/children`,
        });
      for (const child of node.sourceChildrenNodeIds)
        if (!mapping[child])
          pushChatGPTWarning(warnings, {
            code: "dangling_child",
            location: `${sourceMember}#${id}/mapping/${node.nodeId}/children/${child}`,
          });
    }
  }
  const currentNodeId = text(value.current_node);
  const currentPathReverse: string[] = [];
  let pathValid = true;
  if (value.current_node === undefined || value.current_node === null) {
    pushChatGPTWarning(warnings, {
      code: "missing_current_node",
      location: `${sourceMember}#${id}/current_node`,
    });
    pathValid = false;
  } else if (!currentNodeId || !mapping[currentNodeId]) {
    pushChatGPTWarning(warnings, {
      code: "unknown_current_node",
      location: `${sourceMember}#${id}/current_node`,
    });
    pathValid = false;
  } else {
    const seen = new Set<string>();
    let cursor: string | null = currentNodeId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        pushChatGPTWarning(warnings, {
          code: "graph_cycle",
          location: `${sourceMember}#${id}/mapping/${cursor}/parent`,
        });
        pathValid = false;
        break;
      }
      seen.add(cursor);
      const node: ChatGPTParsedNode | undefined = mapping[cursor];
      if (!node) {
        pushChatGPTWarning(warnings, {
          code: "dangling_parent",
          location: `${sourceMember}#${id}/mapping/${cursor}`,
        });
        pathValid = false;
        break;
      }
      currentPathReverse.push(cursor);
      cursor = node.parentNodeId;
      if (cursor !== null && !mapping[cursor]) {
        pushChatGPTWarning(warnings, {
          code: "dangling_parent",
          location: `${sourceMember}#${id}/mapping/${node.nodeId}/parent`,
        });
        pathValid = false;
        break;
      }
    }
  }
  const currentPathNodeIds = pathValid ? currentPathReverse.toReversed() : [];
  const visiblePathNodeIds = currentPathNodeIds.filter((nodeId) =>
    Boolean(mapping[nodeId]?.message),
  );
  const title = text(value.title);
  const sourceExtras = unknownFields(value, [
    "id",
    "conversation_id",
    "title",
    "create_time",
    "update_time",
    "current_node",
    "mapping",
    "moderation_results",
    "plugin_ids",
    "conversation_template_id",
    "is_archived",
    "safe_urls",
  ]);
  const nodes = Object.values(mapping);
  const attachmentCount = nodes.reduce(
    (count, node) => count + (node.message?.attachments.length ?? 0),
    0,
  );
  const unknownCount = warnings.filter((warning) =>
    [
      "unknown_content",
      "unknown_role",
      "invalid_message",
      "invalid_node",
      "field_mismatch",
      "children_disagreement",
    ].includes(warning.code),
  ).length;
  const omittedCount = warnings.filter((warning) =>
    [
      "missing_current_node",
      "unknown_current_node",
      "graph_cycle",
      "dangling_parent",
      "dangling_child",
    ].includes(warning.code),
  ).length;
  return {
    id,
    title,
    createTime: parseEpoch(value.create_time, `${sourceMember}#${id}/create_time`, warnings),
    updateTime: parseEpoch(value.update_time, `${sourceMember}#${id}/update_time`, warnings),
    rawCreateTime: value.create_time,
    rawUpdateTime: value.update_time,
    currentNodeId,
    currentPathNodeIds,
    visiblePathNodeIds,
    mapping,
    nodes,
    sourceExtras,
    rawConversation: value as ChatGPTConversationInput,
    sourceMember,
    warnings,
    branchCount: nodes.filter((node) => node.childrenNodeIds.length > 1).length,
    attachmentCount,
    unknownCount,
    omittedCount,
  };
}

function mappingOrder(nodes: readonly ChatGPTParsedNode[]): ChatGPTParsedNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const indegree = new Map<string, number>(nodes.map((node) => [node.nodeId, 0]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    children.set(node.nodeId, []);
    if (node.parentNodeId && byId.has(node.parentNodeId) && node.parentNodeId !== node.nodeId) {
      indegree.set(node.nodeId, 1);
      children.get(node.parentNodeId)!.push(node.nodeId);
    }
  }
  for (const nodeChildren of children.values())
    nodeChildren.sort((left, right) => left.localeCompare(right));

  const ready: string[] = [];
  const compareReady = (left: string, right: string): number => left.localeCompare(right);
  const pushReady = (nodeId: string): void => {
    let index = ready.length;
    ready.push(nodeId);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareReady(ready[parent]!, nodeId) <= 0) break;
      ready[index] = ready[parent]!;
      index = parent;
    }
    ready[index] = nodeId;
  };
  const popReady = (): string | undefined => {
    const first = ready[0];
    const last = ready.pop();
    if (last !== undefined && ready.length > 0) {
      let index = 0;
      while (index * 2 + 1 < ready.length) {
        let child = index * 2 + 1;
        const right = child + 1;
        if (right < ready.length && compareReady(ready[right]!, ready[child]!) < 0) child = right;
        if (compareReady(last, ready[child]!) <= 0) break;
        ready[index] = ready[child]!;
        index = child;
      }
      ready[index] = last;
    }
    return first;
  };

  for (const [nodeId, degree] of indegree) if (degree === 0) pushReady(nodeId);
  const result: ChatGPTParsedNode[] = [];
  const emitted = new Set<string>();
  for (;;) {
    const nodeId = popReady();
    if (nodeId === undefined) break;
    const node = byId.get(nodeId);
    if (!node || emitted.has(nodeId)) continue;
    emitted.add(nodeId);
    result.push(node);
    for (const child of children.get(nodeId) ?? []) {
      const next = (indegree.get(child) ?? 1) - 1;
      indegree.set(child, next);
      if (next === 0) pushReady(child);
    }
  }
  for (const node of nodes.toSorted((left, right) => left.nodeId.localeCompare(right.nodeId)))
    if (!emitted.has(node.nodeId)) result.push(node);
  return result;
}

function selectedBranchId(parsed: ChatGPTParsedConversation): string {
  return `chatgpt:${parsed.id}:selected`;
}

function nodeBranchId(
  parsed: ChatGPTParsedConversation,
  selectedNodeIds: ReadonlySet<string>,
  nodeId: string,
): string {
  if (selectedNodeIds.has(nodeId)) return selectedBranchId(parsed);
  return `chatgpt:${parsed.id}:alternate:${nodeId}`;
}

function sourceBase(sourcePath: string, parsed: ChatGPTParsedConversation) {
  return {
    provider: "openai",
    harness: "chatgpt",
    sourceKind: "chatgpt-export",
    nativeSessionId: parsed.id,
    sourcePath,
    adapterRecipe: CHATGPT_RECIPE,
    capturePolicyVersion: CHATGPT_CAPTURE_POLICY,
  };
}

function lossCodeForWarning(warning: ChatGPTWarning): SemanticLossCode {
  if (["dangling_parent", "dangling_child", "graph_cycle"].includes(warning.code))
    return "relation-target-missing";
  if (
    [
      "unknown_content",
      "unknown_role",
      "invalid_message",
      "invalid_node",
      "field_mismatch",
    ].includes(warning.code)
  )
    return "unknown-well-formed-item";
  return "provider-field-unsupported";
}

export function adaptChatGPTEventBatch(
  sourcePath: string,
  item: ChatGPTConversationInput | ChatGPTParsedConversation,
  domain: ConversationDomain = "general",
): EventBatch {
  const parsed =
    "nodes" in (item as Record<string, unknown>) &&
    "currentPathNodeIds" in (item as Record<string, unknown>)
      ? (item as ChatGPTParsedConversation)
      : parseChatGPTConversation(item, sourcePath);
  const bounded = validateBoundedRecord(
    parsed.rawConversation,
    `${sourcePath}#${parsed.id}`,
    CHATGPT_RECORD_LIMITS,
  );
  if (!bounded.ok) failClosed(bounded.error);
  const normalizedDomain = normalizeConversationDomain(domain);
  const base = sourceBase(sourcePath, parsed);
  const events: AgentEventEnvelope[] = [];
  const semanticLoss: EventBatch["semanticLoss"][number][] = [];
  const eventByNode = new Map<string, AgentEventEnvelope>();
  const branchEvents = new Map<string, AgentEventEnvelope>();
  const addLoss = (
    code: SemanticLossCode,
    reason: string,
    sourceItemKind: string,
    sourceLocator: string,
    record?: number,
    nativeItemId?: string,
  ): void => {
    if (semanticLoss.length >= CHATGPT_MAX_SEMANTIC_LOSSES)
      failClosed(
        `${sourcePath}#${parsed.id}: ChatGPT export exceeds the ${CHATGPT_MAX_SEMANTIC_LOSSES}-semantic-loss limit`,
      );
    semanticLoss.push(
      makeSemanticLoss({
        code,
        reason,
        provider: base.provider,
        harness: base.harness,
        sourceItemKind,
        sourceLocator,
        count: 1,
        adapterRecipe: base.adapterRecipe,
        capturePolicyVersion: base.capturePolicyVersion,
        recoverable: true,
        sourcePath,
        ...(record === undefined ? {} : { recordPosition: { record } }),
        ...(nativeItemId ? { nativeItemId } : {}),
      }),
    );
  };
  const add = (
    kind: AgentEventEnvelope["kind"],
    nativeItemId: string,
    raw: unknown,
    record: number,
    payload: Record<string, unknown>,
    options: {
      branchId?: string;
      parent?: string;
      branch?: string;
      occurredAt?: string | null;
      actor?: AgentEventEnvelope["actor"];
      disposition?: CaptureDisposition;
    } = {},
  ): AgentEventEnvelope => {
    if (events.length >= CHATGPT_MAX_EMITTED_EVENTS)
      failClosed(
        `${sourcePath}#${parsed.id}: ChatGPT export exceeds the ${CHATGPT_MAX_EMITTED_EVENTS}-event limit`,
      );
    const source = makeObservedSource(
      {
        ...base,
        nativeItemId,
        recordPosition: { record },
      },
      raw,
    );
    const event = makeEvent({
      kind,
      sequence: events.length,
      ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
      actor: options.actor ?? { kind: "provider", name: "chatgpt" },
      scope: {
        sessionId: parsed.id,
        conversationId: parsed.id,
        ...(options.branchId ? { branchId: options.branchId } : {}),
        project: "ChatGPT",
      },
      origin: { kind: "observed", source },
      relations: {
        ...(options.parent ? { parent: options.parent } : {}),
        ...(options.branch ? { branch: options.branch } : {}),
      },
      payload,
      capture: options.disposition ?? capture("normalized"),
    });
    events.push(event);
    return event;
  };

  const started = add(
    "session.started",
    `conversation:${parsed.id}:started`,
    parsed.rawConversation,
    0,
    {
      id: parsed.id,
      sessionId: parsed.id,
      conversationId: parsed.id,
      provider: "openai",
      harness: "chatgpt",
      title: parsed.title ?? "Untitled ChatGPT conversation",
      domain: normalizedDomain,
      project: "ChatGPT",
      cwd: "",
      model: "(export does not identify model)",
      resumeId: parsed.id,
      rawCreateTime: parsed.rawCreateTime,
      rawUpdateTime: parsed.rawUpdateTime,
      sourceExtras: parsed.sourceExtras,
      rawConversation: parsed.rawConversation,
    },
    {
      occurredAt: parsed.createTime ?? parsed.updateTime,
      actor: { kind: "provider", name: "chatgpt" },
    },
  );
  void started;
  const orderedNodes = mappingOrder(parsed.nodes);
  const selectedNodeIds = new Set(parsed.currentPathNodeIds);
  for (const [warningIndex, warning] of parsed.warnings.entries())
    addLoss(
      lossCodeForWarning(warning),
      `ChatGPT export warning ${warning.code} at ${warning.location}`,
      "chatgpt-warning",
      warning.location,
      orderedNodes.length + warningIndex + 1,
    );

  for (const [nodeIndex, node] of orderedNodes.entries()) {
    const record = nodeIndex + 1;
    const branchId = nodeBranchId(parsed, selectedNodeIds, node.nodeId);
    const parentEvent = node.parentNodeId ? eventByNode.get(node.parentNodeId) : undefined;
    if (node.parentNodeId && !parentEvent) {
      addLoss(
        "relation-target-missing",
        `ChatGPT mapping node ${node.nodeId} refers to a parent that cannot be ordered safely`,
        "mapping-node",
        `${parsed.sourceMember ?? sourcePath}#${parsed.id}/mapping/${node.nodeId}/parent`,
        record,
        node.nodeId,
      );
    }
    let branchEvent: AgentEventEnvelope | undefined;
    const parentNode = node.parentNodeId ? parsed.mapping[node.parentNodeId] : undefined;
    if (parentEvent && parentNode && parentNode.childrenNodeIds.length > 1) {
      branchEvent = add(
        "branch.created",
        `${node.nodeId}:branch`,
        node.rawNode,
        record,
        {
          branchId,
          nodeId: node.nodeId,
          parentNodeId: node.parentNodeId,
          branchSize: parentNode.childrenNodeIds.length,
          sourceChildrenNodeIds: parentNode.sourceChildrenNodeIds,
        },
        { branchId, parent: parentEvent.eventId },
      );
      branchEvents.set(node.nodeId, branchEvent);
    }
    const relations = {
      ...(parentEvent ? { parent: parentEvent.eventId } : {}),
      ...(branchEvent ? { branch: branchEvent.eventId } : {}),
    };
    const message = node.message;
    const hasOpaqueRole = !["user", "assistant"].includes(message?.role ?? "unknown");
    const hasUnknownContent = Boolean(
      message && (!message.contentKnown || message.unknownParts.length),
    );
    const nativeItemId = `${node.nodeId}:${message ? "message" : "node"}`;
    let messageEvent: AgentEventEnvelope;
    if (message && !hasOpaqueRole && message.textParts.length) {
      messageEvent = add(
        "message.created",
        nativeItemId,
        node.rawNode,
        record,
        {
          nodeId: node.nodeId,
          messageId: message.messageId ?? `${parsed.id}:${node.nodeId}`,
          role: message.role,
          content: message.textParts.join("\n"),
          contentType: message.contentType,
          rawCreateTime: message.rawCreateTime,
          rawUpdateTime: message.rawUpdateTime,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
          metadata: message.metadata,
          attachments: message.attachments,
          rawAuthor: message.rawAuthor,
          authorExtras: message.authorExtras,
          sourceExtras: message.sourceExtras,
          nodeSourceExtras: node.sourceExtras,
          rawMessage: message.rawMessage,
          rawNode: node.rawNode,
          ...(message.unknownParts.length ? { rawContent: message.rawContent } : {}),
        },
        {
          branchId,
          ...relations,
          occurredAt: message.createdAt ?? message.updatedAt,
          actor: { kind: message.role === "user" ? "human" : "assistant" },
        },
      );
    } else {
      messageEvent = add(
        "provider.opaque",
        nativeItemId,
        node.rawNode,
        record,
        {
          itemKind: "chatgpt.mapping-node",
          nodeId: node.nodeId,
          messageId: message?.messageId,
          role: message?.role ?? null,
          rawRole: message?.rawRole,
          contentType: message?.contentType,
          rawContent: message?.rawContent,
          metadata: message?.metadata,
          attachments: message?.attachments,
          sourceExtras: node.sourceExtras,
          rawNode: node.rawNode,
          rawMessage: message?.rawMessage,
        },
        {
          branchId,
          ...relations,
          occurredAt: message?.createdAt ?? message?.updatedAt,
          actor: { kind: "unknown", name: message?.role ?? "mapping-node" },
          disposition: capture("opaque"),
        },
      );
    }
    eventByNode.set(node.nodeId, messageEvent);
    if (message?.attachments.length) {
      for (const attachmentIndex of message.attachments.keys())
        addLoss(
          "attachment-body-excluded",
          "ChatGPT export attachment metadata was retained without fetching or storing its body",
          "attachment",
          `${parsed.sourceMember ?? sourcePath}#${parsed.id}/mapping/${node.nodeId}/message/metadata/attachments/${attachmentIndex}`,
          record,
          `${node.nodeId}:attachment:${attachmentIndex}`,
        );
    }
    if (hasUnknownContent)
      addLoss(
        "unknown-well-formed-item",
        "ChatGPT export content was retained as opaque raw JSON because its meaning is not stable",
        "content-block",
        `${parsed.sourceMember ?? sourcePath}#${parsed.id}/mapping/${node.nodeId}/message/content`,
        record,
        `${node.nodeId}:content`,
      );
    if (message?.role === "system" || message?.role === "tool" || message?.role === "developer")
      addLoss(
        "provider-field-unsupported",
        `ChatGPT ${message.role} message remains opaque; no stable portable tool or policy meaning is claimed`,
        "message-role",
        `${parsed.sourceMember ?? sourcePath}#${parsed.id}/mapping/${node.nodeId}/message/author/role`,
        record,
        `${node.nodeId}:role`,
      );
    if (message) {
      const unsupportedFields = ["recipient", "status", "end_turn", "weight", "channel"].filter(
        (field) => field in message.rawMessage,
      );
      if (unsupportedFields.length)
        addLoss(
          "provider-field-unsupported",
          `ChatGPT message fields ${unsupportedFields.join(", ")} were retained as raw metadata without portable semantics`,
          "message-fields",
          `${parsed.sourceMember ?? sourcePath}#${parsed.id}/mapping/${node.nodeId}/message`,
          record,
          `${node.nodeId}:fields`,
        );
    }
  }
  const selectionId = selectedBranchId(parsed);
  const currentEvent = parsed.currentPathNodeIds.length
    ? eventByNode.get(parsed.currentPathNodeIds.at(-1)!)
    : undefined;
  const selected = add(
    "branch.selected",
    `${parsed.id}:branch-selected`,
    parsed.rawConversation,
    0,
    {
      branchId: selectionId,
      currentNodeId: parsed.currentNodeId,
      pathNodeIds: parsed.currentPathNodeIds,
      visiblePathNodeIds: parsed.visiblePathNodeIds,
      selectionStatus: parsed.currentPathNodeIds.length ? "declared" : "unknown",
    },
    {
      branchId: selectionId,
      ...(currentEvent ? { parent: currentEvent.eventId } : {}),
      actor: { kind: "provider", name: "chatgpt" },
      disposition: parsed.currentPathNodeIds.length
        ? capture("normalized")
        : capture("omitted", "current branch could not be projected safely"),
    },
  );
  const ended = add(
    "session.ended",
    `conversation:${parsed.id}:ended`,
    parsed.rawConversation,
    0,
    { id: parsed.id, currentNodeId: parsed.currentNodeId },
    { parent: selected.eventId, occurredAt: parsed.updateTime ?? parsed.createTime },
  );
  void ended;
  return {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin(base, parsed.rawConversation),
    events,
    semanticLoss,
    partialTail: false,
    sourceItemCount: orderedNodes.length + parsed.warnings.length + 1,
  };
}

export function adaptChatGPTConversation(
  sourcePath: string,
  item: ChatGPTConversationInput | ChatGPTParsedConversation,
  domain: ConversationDomain = "general",
): Conversation {
  return projectConversation(adaptChatGPTEventBatch(sourcePath, item, domain));
}

function candidateMember(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === "conversations.json" ||
    /^\d+\.json$/.test(name) ||
    /^conversation[-_].*\.json$/.test(name)
  );
}

function boundedFailure(error: ExportLimitFailure): never {
  return failClosed(error.message, error);
}

function rejectUnknown<T>(error: unknown): Promise<T> {
  return Promise.reject(error);
}

async function unzipText(
  source: string,
  args: string[],
  limit: number,
  kind: "member" | "listing",
  members: readonly string[] = [],
): Promise<{ text: string; bytes: number }> {
  const archive = await lstat(source);
  if (!archive.isFile()) failClosed(`${source}: ChatGPT archive is not a regular file`);
  if (archive.size > EXPORT_MAX_ARCHIVE_BYTES)
    return boundedFailure(
      new ExportLimitError("archive", EXPORT_MAX_ARCHIVE_BYTES, archive.size, source),
    );
  const child = Bun.spawn(["unzip", ...args, source, ...members], {
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
    if (!child.stdout || !child.stderr) failClosed("ChatGPT export reader did not provide pipes");
    const [stdoutResult, stderrResult, exitCode] = await Promise.all([
      readBoundedTextStream(child.stdout, limit, kind, `ChatGPT ${kind} output`, stop),
      readBoundedTextStream(
        child.stderr,
        EXPORT_MAX_STDERR_BYTES,
        "stderr",
        "ChatGPT export diagnostic output",
        stop,
      ),
      child.exited,
    ]);
    if (!stdoutResult.ok) return boundedFailure(stdoutResult.error);
    if (!stderrResult.ok) return boundedFailure(stderrResult.error);
    const stdout = stdoutResult.value;
    const stderr = stderrResult.value;
    if (exitCode !== 0) failClosed(`cannot read ChatGPT export: ${redact(stderr.text.trim())}`);
    return stdout;
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    if (error instanceof ExportLimitError || error instanceof ExportFileTypeError)
      return boundedFailure(error);
    return rejectUnknown(error);
  }
}

async function readMembers(sourcePath: string): Promise<ChatGPTExportMember[]> {
  try {
    const source = resolve(sourcePath);
    const info = await lstat(source);
    if (info.isSymbolicLink()) failClosed(`${source}: ChatGPT export source must not be a symlink`);
    if (info.isDirectory()) {
      const names: string[] = [];
      const pending: Array<{ path: string; depth: number }> = [{ path: source, depth: 0 }];
      let visitedEntries = 0;
      while (pending.length > 0) {
        const directory = pending.pop()!;
        const handle = await opendir(directory.path);
        try {
          while (true) {
            const entry = await handle.read();
            if (!entry) break;
            visitedEntries += 1;
            if (visitedEntries > CHATGPT_MAX_DIRECTORY_ENTRIES)
              failClosed(
                `${source}: ChatGPT export directory exceeds the ${CHATGPT_MAX_DIRECTORY_ENTRIES}-entry limit`,
              );
            const memberPath = join(directory.path, entry.name);
            if (entry.isSymbolicLink())
              failClosed(`${memberPath}: ChatGPT export directory walk refuses symlink entries`);
            const memberInfo = await lstat(memberPath);
            if (memberInfo.isSymbolicLink())
              failClosed(`${memberPath}: ChatGPT export directory walk refuses symlink entries`);
            if (memberInfo.isDirectory()) {
              if (directory.depth >= CHATGPT_MAX_DIRECTORY_DEPTH)
                failClosed(
                  `${memberPath}: ChatGPT export exceeds the ${CHATGPT_MAX_DIRECTORY_DEPTH}-directory depth limit`,
                );
              pending.push({ path: memberPath, depth: directory.depth + 1 });
              continue;
            }
            if (!memberInfo.isFile()) continue;
            const name = relative(source, memberPath);
            if (!candidateMember(name)) continue;
            if (names.length >= EXPORT_MAX_MEMBERS)
              failClosed(
                `${source}: ChatGPT export exceeds the ${EXPORT_MAX_MEMBERS}-member limit`,
              );
            names.push(name);
          }
        } finally {
          try {
            await handle.close();
          } catch {
            // The directory is already closed when read() reaches EOF.
          }
        }
      }
      names.sort((left, right) => left.localeCompare(right));
      if (!names.length) failClosed(`${source}: ChatGPT export has no conversation JSON member`);
      const entries: Array<{ name: string; size: number }> = [];
      let expectedTotal = 0;
      for (const name of names) {
        const memberPath = join(source, name);
        const memberInfo = await lstat(memberPath);
        if (!memberInfo.isFile()) failClosed(`${memberPath}: export member is not a regular file`);
        if (memberInfo.size > EXPORT_MAX_MEMBER_BYTES)
          boundedFailure(
            new ExportLimitError("member", EXPORT_MAX_MEMBER_BYTES, memberInfo.size, memberPath),
          );
        if (memberInfo.size > EXPORT_MAX_TOTAL_BYTES - expectedTotal)
          boundedFailure(
            new ExportLimitError(
              "total",
              EXPORT_MAX_TOTAL_BYTES,
              expectedTotal + memberInfo.size,
              source,
            ),
          );
        expectedTotal += memberInfo.size;
        entries.push({ name, size: memberInfo.size });
      }
      const members: ChatGPTExportMember[] = [];
      let total = 0;
      for (const entry of entries) {
        const memberPath = join(source, entry.name);
        const contentResult = await readBoundedFile(
          memberPath,
          EXPORT_MAX_MEMBER_BYTES,
          memberPath,
          source,
        );
        if (!contentResult.ok) return boundedFailure(contentResult.error);
        const content = contentResult.value;
        if (content.bytes > EXPORT_MAX_TOTAL_BYTES - total)
          return boundedFailure(
            new ExportLimitError("total", EXPORT_MAX_TOTAL_BYTES, total + content.bytes, source),
          );
        total += content.bytes;
        members.push({ path: `${source}#${entry.name}`, text: content.text });
      }
      return members;
    }
    if (extname(source).toLowerCase() === ".json") {
      const contentResult = await readBoundedFile(source, EXPORT_MAX_FILE_BYTES, source);
      if (!contentResult.ok) return boundedFailure(contentResult.error);
      return [{ path: source, text: contentResult.value.text }];
    }
    if (extname(source).toLowerCase() !== ".zip")
      failClosed("ChatGPT export must be a directory, JSON member, or .zip archive");
    const listingResult = await unzipText(source, ["-Z1"], EXPORT_MAX_LISTING_BYTES, "listing");
    const listing = listingResult.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && candidateMember(line))
      .toSorted();
    if (listing.length > EXPORT_MAX_MEMBERS)
      failClosed(`${source}: ChatGPT export exceeds the ${EXPORT_MAX_MEMBERS}-member limit`);
    if (!listing.length) failClosed(`${source}: ChatGPT export has no conversation JSON member`);
    const members: ChatGPTExportMember[] = [];
    let total = 0;
    for (const member of listing) {
      const content = await unzipText(source, ["-p"], EXPORT_MAX_MEMBER_BYTES, "member", [member]);
      if (content.bytes > EXPORT_MAX_TOTAL_BYTES - total)
        return boundedFailure(
          new ExportLimitError("total", EXPORT_MAX_TOTAL_BYTES, total + content.bytes, source),
        );
      total += content.bytes;
      members.push({ path: `${source}#${member}`, text: content.text });
    }
    return members;
  } catch (error) {
    if (error instanceof ChatGPTExportError) return rejectUnknown(error);
    if (error instanceof ExportLimitError || error instanceof ExportFileTypeError)
      return boundedFailure(error);
    return failClosed(
      `cannot read ChatGPT export: ${redact(error instanceof Error ? error.message : String(error))}`,
      error,
    );
  }
}

function decodeMember(member: ChatGPTExportMember): ChatGPTConversationInput[] {
  let value: unknown;
  try {
    value = JSON.parse(member.text);
  } catch (error) {
    failClosed(`${member.path}: malformed JSON (${redact(String(error))})`);
  }
  if (Array.isArray(value)) return value as ChatGPTConversationInput[];
  if (isRecord(value) && isRecord(value.mapping)) return [value as ChatGPTConversationInput];
  if (isRecord(value) && Array.isArray(value.conversations))
    return value.conversations as ChatGPTConversationInput[];
  failClosed(`${member.path}: expected a conversation object or array`);
}
function hashMembers(members: readonly ChatGPTExportMember[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const member of members) {
    hasher.update(member.path);
    hasher.update("\n");
    hasher.update(member.text);
    hasher.update("\n");
  }
  return hasher.digest("hex");
}

export async function readChatGPTExport(
  sourcePath: string,
  options: ChatGPTReadOptions = {},
): Promise<ChatGPTExportReadResult> {
  const source = resolve(sourcePath);
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    failClosed(
      `cannot read ChatGPT export: ${redact(error instanceof Error ? error.message : String(error))}`,
      error,
    );
  }
  if (info.isSymbolicLink()) failClosed(`${source}: ChatGPT export source must not be a symlink`);
  const members = await readMembers(source);
  await options.beforeVerification?.();
  const verificationMembers = await readMembers(source);
  const sourceContentHash = hashMembers(members);
  const verificationHash = hashMembers(verificationMembers);
  if (sourceContentHash !== verificationHash)
    failClosed(`${source}: source changed while it was being read`);
  const conversations: ChatGPTParsedConversation[] = [];
  let totalConversations = 0;
  for (const member of members) {
    const decoded = decodeMember(member);
    if (totalConversations > CHATGPT_MAX_CONVERSATIONS - decoded.length)
      failClosed(
        `${source}: ChatGPT export exceeds the ${CHATGPT_MAX_CONVERSATIONS}-conversation limit`,
      );
    totalConversations += decoded.length;
    for (const [index, raw] of decoded.entries())
      conversations.push(parseChatGPTConversation(raw, `${member.path}#conversation/${index}`));
  }
  return {
    source,
    sourceBytes: info.isDirectory()
      ? members.reduce((sum, member) => sum + Buffer.byteLength(member.text), 0)
      : info.size,
    sourceModifiedAt: info.mtime.toISOString(),
    sourceContentHash,
    members,
    conversations,
  };
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function loadManifest(root: string): Promise<CorpusManifest> {
  const path = join(root, "corpus", "manifest.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { version: 1, sources: {} };
    failClosed(
      `cannot read ChatGPT corpus manifest ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
  if (!info.isFile()) failClosed(`${path}: ChatGPT corpus manifest is not a regular file`);
  const contentResult = await readBoundedFile(
    path,
    EXPORT_MAX_MANIFEST_BYTES,
    `${path} (ChatGPT corpus manifest)`,
    root,
  );
  if (!contentResult.ok) return boundedFailure(contentResult.error);
  try {
    const value = JSON.parse(contentResult.value.text) as CorpusManifest;
    if (value.version !== 1 || !value.sources) failClosed("unsupported corpus manifest");
    return value;
  } catch (error: unknown) {
    if (error instanceof ChatGPTExportError) throw error;
    failClosed(
      `cannot parse ChatGPT corpus manifest ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
}

async function readPriorConversation(
  root: string,
  contentHash: string,
): Promise<Conversation | null> {
  const path = join(root, "corpus", "objects", contentHash.slice(0, 2), `${contentHash}.json`);
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return null;
    failClosed(
      `cannot read ChatGPT prior corpus object ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
  if (!info.isFile()) failClosed(`${path}: ChatGPT prior corpus object is not a regular file`);
  const contentResult = await readBoundedFile(
    path,
    EXPORT_MAX_CORPUS_OBJECT_BYTES,
    `${path} (ChatGPT prior corpus object)`,
    root,
  );
  if (!contentResult.ok) return boundedFailure(contentResult.error);
  try {
    return JSON.parse(contentResult.value.text) as Conversation;
  } catch (error: unknown) {
    failClosed(
      `cannot parse ChatGPT prior corpus object ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
}

async function previousClassification(
  root: string,
  manifest: CorpusManifest,
  parsed: ChatGPTParsedConversation,
  conversation: Conversation,
  domain: string,
): Promise<"new" | "changed" | "reclassified" | "unchanged"> {
  const previous = manifest.sources[conversation.sourcePath];
  if (!previous) return "new";
  if (previous.contentHash === conversation.contentHash) return "unchanged";
  if (!previous.contentHash) return "changed";
  try {
    const oldConversation = await readPriorConversation(root, previous.contentHash);
    if (!oldConversation) return "changed";
    const oldDomain = normalizeConversationDomain(oldConversation.domain ?? "general");
    if (oldDomain !== domain) {
      const candidate = projectConversation(
        adaptChatGPTEventBatch(conversation.sourcePath, parsed, oldDomain),
      );
      if (candidate.contentHash === previous.contentHash) return "reclassified";
    }
    return "changed";
  } catch (error) {
    if (error instanceof ChatGPTExportError) throw error;
    return "changed";
  }
}

export async function previewChatGPTExport(
  sourcePath: string,
  root: string,
  options: Pick<ChatGPTImportOptions, "domain"> = {},
): Promise<ChatGPTPreviewSummary> {
  const domain = normalizeConversationDomain(options.domain ?? "general");
  const parsed = await readChatGPTExport(sourcePath);
  const manifest = await loadManifest(root);
  const classifications: Array<"new" | "changed" | "reclassified" | "unchanged"> = [];
  const timestamps: string[] = [];
  let messages = 0;
  let branches = 0;
  let attachments = 0;
  let unknown = 0;
  let omitted = 0;
  let invalid = 0;
  let totalEvents = 0;
  let totalSemanticLosses = 0;
  for (const conversation of parsed.conversations) {
    try {
      const batch = adaptChatGPTEventBatch(
        conversation.sourceMember ?? parsed.source,
        conversation,
        domain,
      );
      if (totalEvents > CHATGPT_MAX_EMITTED_EVENTS - batch.events.length)
        failClosed(
          `${parsed.source}: ChatGPT export exceeds the ${CHATGPT_MAX_EMITTED_EVENTS}-event export limit`,
        );
      if (totalSemanticLosses > CHATGPT_MAX_SEMANTIC_LOSSES - batch.semanticLoss.length)
        failClosed(
          `${parsed.source}: ChatGPT export exceeds the ${CHATGPT_MAX_SEMANTIC_LOSSES}-semantic-loss export limit`,
        );
      totalEvents += batch.events.length;
      totalSemanticLosses += batch.semanticLoss.length;
      const projected = projectConversation(batch);
      classifications.push(
        await previousClassification(root, manifest, conversation, projected, domain),
      );
      messages += conversation.nodes.filter((node) => Boolean(node.message)).length;
      branches += conversation.branchCount;
      attachments += conversation.attachmentCount;
      unknown += conversation.unknownCount;
      omitted += conversation.omittedCount;
      timestamps.push(
        ...[conversation.createTime, conversation.updateTime].filter((value): value is string =>
          Boolean(value),
        ),
      );
    } catch (error) {
      if (error instanceof ChatGPTExportError) throw error;
      invalid++;
    }
  }
  const counts = {
    new: classifications.filter((value) => value === "new").length,
    changed: classifications.filter((value) => value === "changed").length,
    reclassified: classifications.filter((value) => value === "reclassified").length,
    unchanged: classifications.filter((value) => value === "unchanged").length,
  };
  const proposalId = sha256(
    stableStringify({
      schema: "chatlog/chatgpt-import-preview-v1",
      source: parsed.source,
      sourceContentHash: parsed.sourceContentHash,
      domain,
      classifications,
    }),
  );
  const receiptId = sha256(stableStringify({ proposalId, counts, source: parsed.source }));
  timestamps.sort();
  return {
    schema: "chatlog/chatgpt-import-preview-v1",
    advisory: true,
    ready: invalid === 0,
    source: parsed.source,
    sourceBytes: parsed.sourceBytes,
    sourceModifiedAt: parsed.sourceModifiedAt,
    sourceContentHash: parsed.sourceContentHash,
    domain,
    selectedDomain: domain,
    receiptId,
    proposalId,
    discovered: parsed.conversations.length,
    importable: parsed.conversations.length - invalid,
    invalid,
    conversations: parsed.conversations.length,
    messages,
    branches,
    attachments,
    unknown,
    omitted,
    ...counts,
    wouldImport: counts.new + counts.changed + counts.reclassified,
    dateRange: { first: timestamps[0] ?? null, last: timestamps.at(-1) ?? null },
    exclusions: {
      attachmentBodies: true,
      accountMemories: true,
      customInstructions: true,
      fileBodies: true,
      reasoningInterface: true,
    },
  };
}

export async function importChatGPTExport(
  sourcePath: string,
  root: string,
  options: ChatGPTImportOptions = {},
): Promise<ChatGPTImportSummary> {
  return withIngestLock(root, async () => {
    const domain = normalizeConversationDomain(options.domain ?? "general");
    const parsed = await readChatGPTExport(sourcePath);
    const sourceInfo = await lstat(parsed.source);
    const manifestPath = join(root, "corpus", "manifest.json");
    const manifest = await loadManifest(root);
    const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
    const summary: Omit<ChatGPTImportSummary, "receipt" | "receipts"> = {
      source: parsed.source,
      domain,
      discovered: parsed.conversations.length,
      imported: 0,
      skipped: 0,
      conversations: 0,
      messages: 0,
      branches: 0,
      attachments: 0,
      unknown: 0,
      omitted: 0,
    };
    const receipts: SourceReceipt[] = [];
    let added = 0;
    let replaced = 0;
    let totalEvents = 0;
    let totalSemanticLosses = 0;
    try {
      await reconcileSourceAuthority(root, db, manifest.sources);
      for (const conversationInput of parsed.conversations) {
        const sourceMember = conversationInput.sourceMember ?? parsed.source;
        const batch = adaptChatGPTEventBatch(sourceMember, conversationInput, domain);
        if (totalEvents > CHATGPT_MAX_EMITTED_EVENTS - batch.events.length)
          failClosed(
            `${parsed.source}: ChatGPT export exceeds the ${CHATGPT_MAX_EMITTED_EVENTS}-event export limit`,
          );
        if (totalSemanticLosses > CHATGPT_MAX_SEMANTIC_LOSSES - batch.semanticLoss.length)
          failClosed(
            `${parsed.source}: ChatGPT export exceeds the ${CHATGPT_MAX_SEMANTIC_LOSSES}-semantic-loss export limit`,
          );
        totalEvents += batch.events.length;
        totalSemanticLosses += batch.semanticLoss.length;
        const batchHash = await persistEventBatch(root, batch);
        const conversation = projectConversation(batch);
        summary.conversations++;
        summary.messages += conversationInput.nodes.filter((node) => Boolean(node.message)).length;
        summary.branches += conversationInput.branchCount;
        summary.attachments += conversationInput.attachmentCount;
        summary.unknown += conversationInput.unknownCount;
        summary.omitted += conversationInput.omittedCount;
        const sourceReceipt = buildSourceReceipt({
          batch,
          batchHash,
          conversationProjectionHash: conversation.contentHash,
        });
        await persistSourceReceipt(root, sourceReceipt);
        receipts.push(sourceReceipt);
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
          root,
          "corpus",
          "objects",
          conversation.contentHash.slice(0, 2),
          `${conversation.contentHash}.json`,
        );
        if (!(await Bun.file(objectPath).exists()))
          await atomicWrite(objectPath, JSON.stringify(conversation) + "\n");
        indexEventBatch(db, batch, batchHash, conversation.contentHash);
        indexConversation(db, conversation, sourceInfo.mtimeMs, sourceInfo.size);
        manifest.sources[conversation.sourcePath] = {
          size: sourceInfo.size,
          mtimeMs: sourceInfo.mtimeMs,
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
    let derived: DeriveSummary | undefined;
    let refinery: RefinerySummary | undefined;
    if (options.derive) {
      derived = await deriveCorpus(root);
      refinery = await refineCorpus(root);
    }
    if (!receipts.length) failClosed(`${parsed.source}: no import receipt was produced`);
    return {
      ...summary,
      receipts,
      receipt: receipts.at(-1)!,
      ...(derived ? { derived } : {}),
      ...(refinery ? { refinery } : {}),
    };
  });
}

export const previewChatgptExport = previewChatGPTExport;
export const importChatgptExport = importChatGPTExport;
