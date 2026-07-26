import { basename } from "node:path";
import { Effect } from "effect";
import { readJsonLines, type JsonlParseError } from "../jsonl";
import type { AdaptResult, SourceAdapter, SourceFile, TokenUsage, ToolCall, Turn } from "../types";
import { redact } from "../redact";
import { AdaptError, assertObject, contentText, discoverJsonl, finishTimes, projectOf } from "./common";

const RECORDS = new Set([
  "session_meta",
  "turn_context",
  "response_item",
  "event_msg",
  "compacted",
  "world_state",
  "inter_agent_communication_metadata",
]);
// tool_search_call / tool_search_output arrived with Codex's tool-search feature
// (first seen in the corpus 2026-07-23) and halted ingestion for five days: an
// unknown item threw a bare Error, so one upstream addition stopped the whole
// pipeline with no signal. The allowlist still has to track upstream — see the
// quarantine note in ingest for the durable fix — but the item now missing from
// this Set fails as a typed AdaptError{itemType, path, line} instead.
const RESPONSE_ITEMS = new Set([
  "message",
  "agent_message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "local_shell_call",
  "computer_call",
]);
const BLOCKS = new Set([
  "input_text",
  "output_text",
  "text",
  "encrypted_content",
  "input_image",
  "image",
  "computer_initialize_state",
  "computer_screenshot",
]);

const adaptSource = Effect.fnUntraced(function* (
  harness: "codex",
  source: SourceFile,
): Effect.fn.Return<AdaptResult, AdaptError | JsonlParseError> {
  const turns: Turn[] = [];
  let id = basename(source.path, ".jsonl");
  let cwd = "";
  let model = "";
  let provider = "openai";
  let fallback = new Date(source.mtimeMs).toISOString();
  let cumulative: TokenUsage | undefined;

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
          reason: `unknown Codex record type ${rec.type}`,
          itemType: rec.type,
        }),
      );
    if (typeof rec.timestamp === "string") fallback = rec.timestamp;
    const p = rec.payload;
    if (!p || typeof p !== "object")
      return yield* Effect.fail(
        new AdaptError({ path: source.path, line, reason: "Codex payload missing" }),
      );
    if (rec.type === "session_meta") {
      id = String(p.id ?? p.session_id ?? id);
      cwd = String(p.cwd ?? "");
      provider = String(p.model_provider ?? provider);
      return;
    }
    if (rec.type === "turn_context") {
      if (typeof p.cwd === "string") cwd = p.cwd;
      if (typeof p.model === "string") model = p.model;
      return;
    }
    if (rec.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) {
      const u = p.info.total_token_usage;
      cumulative = {
        input: Number(u.input_tokens ?? 0),
        output: Number(u.output_tokens ?? 0),
        cachedInput: Number(u.cached_input_tokens ?? 0),
        reasoning: Number(u.reasoning_output_tokens ?? 0),
        total: Number(u.total_tokens ?? 0),
      };
      return;
    }
    if (rec.type !== "response_item") return;
    if (typeof p.type !== "string" || !RESPONSE_ITEMS.has(p.type))
      return yield* Effect.fail(
        new AdaptError({
          path: source.path,
          line,
          reason: `unknown Codex response item ${JSON.stringify(p.type)}`,
          itemType: typeof p.type === "string" ? p.type : undefined,
        }),
      );
    if (p.type === "message" || p.type === "agent_message") {
      const role = String(p.role ?? p.author ?? "assistant");
      turns.push({
        role,
        content: yield* contentText(p.content, source.path, line, BLOCKS),
        at: rec.timestamp,
      });
    } else if (
      p.type === "function_call" ||
      p.type === "custom_tool_call" ||
      p.type === "tool_search_call"
    ) {
      // function_call carries `arguments` as a JSON *string*; tool_search_call
      // carries an object, which String() flattens to "[object Object]",
      // losing the query.
      const rawArgs = p.arguments ?? p.input ?? "";
      const call: ToolCall = {
        id: p.call_id ?? p.id,
        name: String(p.name ?? p.type),
        arguments: redact(typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)),
      };
      turns.push({ role: "assistant", content: "", at: rec.timestamp, toolCalls: [call] });
    } else if (
      p.type === "function_call_output" ||
      p.type === "custom_tool_call_output" ||
      p.type === "tool_search_output"
    ) {
      // tool_search_output returns matches under `tools`, not `output`.
      const rawOut = p.output ?? p.tools ?? "";
      turns.push({
        role: "tool",
        content: redact(typeof rawOut === "string" ? rawOut : JSON.stringify(rawOut)),
        at: rec.timestamp,
        toolCalls: [{ id: p.call_id, name: "tool_result" }],
      });
    }
  });

  const parsed = yield* readJsonLines(source.path, processRecord);

  if (cumulative) {
    const target = [...turns].toReversed().find((t) => t.role === "assistant") ?? turns.at(-1);
    if (target) target.tokens = cumulative;
  }
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

export class CodexAdapter implements SourceAdapter {
  readonly harness = "codex" as const;
  constructor(private root: string) {}
  discover() {
    return discoverJsonl(this.root, (p) => basename(p).startsWith("rollout-"));
  }
  adapt(source: SourceFile): Promise<AdaptResult> {
    return Effect.runPromise(adaptSource(this.harness, source));
  }
}
