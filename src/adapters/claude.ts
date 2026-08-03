import { basename, relative } from "node:path";
import { Effect } from "effect";
import { readJsonLines, type JsonlParseError } from "../jsonl";
import type { AdaptResult, SourceAdapter, SourceFile, ToolCall, Turn } from "../types";
import { redact } from "../redact";
import { AdaptError, assertObject, contentText, discoverJsonl, finishTimes, projectOf } from "./common";

const RECORDS = new Set([
  "assistant",
  "user",
  "system",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "mode",
  "permission-mode",
  "bridge-session",
  "custom-title",
  "ai-title",
  "last-prompt",
  "agent-name",
  "agent-setting",
  "frame-link",
  "pr-link",
  "started",
  "result",
]);
const BLOCKS = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "tool_result",
  "tool_reference",
  "advisor_tool_result",
  "fallback",
  "image",
  "document",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
]);

const adaptSource = Effect.fnUntraced(function* (
  harness: "claude-code",
  root: string,
  source: SourceFile,
): Effect.fn.Return<AdaptResult, AdaptError | JsonlParseError> {
  const turns: Turn[] = [];
  let id = basename(source.path, ".jsonl");
  let cwd = "";
  let model = "";
  let resumeId: string | undefined;
  let firstTimestamp = new Date(source.mtimeMs).toISOString();

  const processRecord = Effect.fnUntraced(function* (
    rec: any,
    line: number,
  ): Effect.fn.Return<void, AdaptError> {
    yield* assertObject(rec, source.path, line);
    if (!RECORDS.has(rec.type))
      return yield* Effect.fail(
        new AdaptError({
          path: source.path,
          line,
          reason: `unknown Claude record type ${rec.type}`,
          itemType: rec.type,
        }),
      );
    if (typeof rec.sessionId === "string") {
      id = rec.sessionId;
      resumeId = rec.sessionId;
    }
    if (typeof rec.cwd === "string") cwd = rec.cwd;
    if (typeof rec.timestamp === "string") firstTimestamp = rec.timestamp;
    if (rec.type === "assistant" || rec.type === "user") {
      if (!rec.message || typeof rec.message.role !== "string")
        return yield* Effect.fail(
          new AdaptError({ path: source.path, line, reason: "malformed Claude message" }),
        );
      if (typeof rec.message.model === "string") model = rec.message.model;
      const toolCalls: ToolCall[] = [];
      if (Array.isArray(rec.message.content))
        for (const block of rec.message.content) {
          if (block?.type === "tool_use" || block?.type === "server_tool_use")
            toolCalls.push({
              id: typeof block.id === "string" ? block.id : undefined,
              name: String(block.name ?? block.type),
              arguments: redact(
                typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
              ),
            });
        }
      const usage = rec.message.usage;
      const tokens = usage
        ? {
            input: Number(usage.input_tokens ?? 0),
            output: Number(usage.output_tokens ?? 0),
            cachedInput: Number(usage.cache_read_input_tokens ?? 0),
            cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
            total:
              Number(usage.input_tokens ?? 0) +
              Number(usage.output_tokens ?? 0) +
              Number(usage.cache_read_input_tokens ?? 0) +
              Number(usage.cache_creation_input_tokens ?? 0),
          }
        : undefined;
      turns.push({
        role: rec.message.role,
        content: yield* contentText(rec.message.content, source.path, line, BLOCKS),
        at: rec.timestamp,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(tokens ? { tokens } : {}),
      });
    } else if (rec.type === "system" && typeof rec.content === "string") {
      turns.push({ role: "system", content: redact(rec.content), at: rec.timestamp });
    } else if (rec.type === "result") {
      turns.push({
        role: "assistant",
        content: redact(JSON.stringify(rec.result ?? {})),
        at: rec.timestamp,
      });
    }
  });

  const parsed = yield* readJsonLines(source.path, processRecord);

  if (!cwd) cwd = relative(root, source.path).split("/")[0] ?? "";
  const [startedAt, endedAt] = finishTimes(turns, firstTimestamp);
  return {
    partialTail: parsed.partialTail,
    conversation: {
      id,
      provider: "anthropic",
      harness,
      project: projectOf(cwd),
      cwd,
      model: model || "(unknown)",
      startedAt,
      endedAt,
      turns,
      resumeId,
      sourcePath: source.path,
    },
  };
});

export class ClaudeAdapter implements SourceAdapter {
  readonly harness = "claude-code" as const;
  constructor(private root: string) {}
  discover() {
    return discoverJsonl(this.root);
  }
  adapt(source: SourceFile): Promise<AdaptResult> {
    return Effect.runPromise(adaptSource(this.harness, this.root, source));
  }
}
