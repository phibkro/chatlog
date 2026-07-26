import { basename } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { readJsonLines } from "../jsonl";
import type { AdaptResult, SourceAdapter, SourceFile, ToolCall, Turn } from "../types";
import { redact } from "../redact";
import { AdaptError, assertObject, contentText, discoverJsonl, finishTimes, projectOf } from "./common";

const RECORDS = new Set([
  "session",
  "session_info",
  "model_change",
  "thinking_level_change",
  "message",
  "compaction",
  "branch_summary",
  "custom",
]);
const BLOCKS = new Set(["text", "thinking", "toolCall", "toolResult", "image"]);

const adaptSource = Effect.fnUntraced(function* (
  harness: "pi",
  source: SourceFile,
): Effect.fn.Return<AdaptResult, AdaptError> {
  const turns: Turn[] = [];
  let id = basename(source.path, ".jsonl");
  let cwd = "";
  let model = "";
  let provider = "(unknown)";
  let fallback = new Date(source.mtimeMs).toISOString();

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
          reason: `unknown pi record type ${rec.type}`,
          itemType: rec.type,
        }),
      );
    if (typeof rec.timestamp === "string") fallback = rec.timestamp;
    if (rec.type === "session") {
      id = String(rec.id ?? id);
      cwd = String(rec.cwd ?? "");
      return;
    }
    if (rec.type === "model_change") {
      model = String(rec.modelId ?? model);
      provider = String(rec.provider ?? provider);
      return;
    }
    if (rec.type !== "message") return;
    const msg = rec.message;
    if (!msg || typeof msg.role !== "string")
      return yield* Effect.fail(
        new AdaptError({ path: source.path, line, reason: "malformed pi message" }),
      );
    if (typeof msg.model === "string") model = msg.model;
    if (typeof msg.provider === "string") provider = msg.provider;
    const calls: ToolCall[] = [];
    if (Array.isArray(msg.content))
      for (const block of msg.content)
        if (block?.type === "toolCall")
          calls.push({
            id: block.id,
            name: String(block.name ?? "tool"),
            arguments: redact(JSON.stringify(block.arguments ?? {})),
          });
    if (msg.role === "toolResult")
      calls.push({ id: msg.toolCallId, name: String(msg.toolName ?? "tool_result") });
    const u = msg.usage;
    const tokens = u
      ? {
          input: Number(u.input ?? 0),
          output: Number(u.output ?? 0),
          cachedInput: Number(u.cacheRead ?? 0),
          cacheWrite: Number(u.cacheWrite ?? 0),
          reasoning: Number(u.reasoning ?? 0),
          total: Number(u.totalTokens ?? 0),
        }
      : undefined;
    turns.push({
      role: msg.role === "toolResult" ? "tool" : msg.role,
      content: yield* contentText(msg.content, source.path, line, BLOCKS),
      at: rec.timestamp,
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(tokens ? { tokens } : {}),
    });
  });

  // See codex.ts for why the visitor captures the first failure as a value
  // instead of throwing across readJsonLines' synchronous, non-Effect-aware
  // callback boundary.
  let failure: AdaptError | undefined;
  const parsed = yield* Effect.promise(() =>
    readJsonLines(source.path, (rec, line) => {
      if (failure) return;
      const exit = Effect.runSyncExit(processRecord(rec, line));
      if (Exit.isFailure(exit)) failure = Cause.squash(exit.cause) as AdaptError;
    }),
  );
  if (failure) return yield* Effect.fail(failure);

  const [startedAt, endedAt] = finishTimes(turns, fallback);
  return {
    partialTail: parsed.partialTail,
    conversation: {
      id,
      provider,
      harness,
      project: projectOf(cwd),
      cwd,
      model: model || "(unknown)",
      startedAt,
      endedAt,
      turns,
      resumeId: id,
      sourcePath: source.path,
    },
  };
});

export class PiAdapter implements SourceAdapter {
  readonly harness = "pi" as const;
  constructor(private root: string) {}
  discover() {
    return discoverJsonl(this.root);
  }
  adapt(source: SourceFile): Promise<AdaptResult> {
    return Effect.runPromise(adaptSource(this.harness, source));
  }
}
