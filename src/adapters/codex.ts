import { basename } from "node:path";
import { readJsonLines } from "../jsonl";
import type { AdaptResult, SourceAdapter, SourceFile, TokenUsage, ToolCall, Turn } from "../types";
import { redact } from "../redact";
import { assertObject, contentText, discoverJsonl, finishTimes, projectOf } from "./common";

const RECORDS = new Set(["session_meta", "turn_context", "response_item", "event_msg", "compacted", "world_state", "inter_agent_communication_metadata"]);
const RESPONSE_ITEMS = new Set(["message", "agent_message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "web_search_call", "local_shell_call", "computer_call"]);
const BLOCKS = new Set(["input_text", "output_text", "text", "encrypted_content", "input_image", "image", "computer_initialize_state", "computer_screenshot"]);

export class CodexAdapter implements SourceAdapter {
  readonly harness = "codex" as const;
  constructor(private root: string) {}
  discover() { return discoverJsonl(this.root, (p) => basename(p).startsWith("rollout-")); }
  async adapt(source: SourceFile): Promise<AdaptResult> {
    const turns: Turn[] = [];
    let id = basename(source.path, ".jsonl"); let cwd = ""; let model = "";
    let provider = "openai"; let fallback = new Date(source.mtimeMs).toISOString();
    let cumulative: TokenUsage | undefined;
    const parsed = await readJsonLines(source.path, (rec, line) => {
      assertObject(rec, source.path, line);
      if (!RECORDS.has(rec.type)) throw new Error(`${source.path}:${line}: unknown Codex record type ${rec.type}`);
      if (typeof rec.timestamp === "string") fallback = rec.timestamp;
      const p = rec.payload;
      if (!p || typeof p !== "object") throw new Error(`${source.path}:${line}: Codex payload missing`);
      if (rec.type === "session_meta") {
        id = String(p.id ?? p.session_id ?? id); cwd = String(p.cwd ?? ""); provider = String(p.model_provider ?? provider); return;
      }
      if (rec.type === "turn_context") { if (typeof p.cwd === "string") cwd = p.cwd; if (typeof p.model === "string") model = p.model; return; }
      if (rec.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        cumulative = { input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0), cachedInput: Number(u.cached_input_tokens ?? 0), reasoning: Number(u.reasoning_output_tokens ?? 0), total: Number(u.total_tokens ?? 0) };
        return;
      }
      if (rec.type !== "response_item") return;
      if (typeof p.type !== "string" || !RESPONSE_ITEMS.has(p.type)) throw new Error(`${source.path}:${line}: unknown Codex response item ${JSON.stringify(p.type)}`);
      if (p.type === "message" || p.type === "agent_message") {
        const role = String(p.role ?? p.author ?? "assistant");
        turns.push({ role, content: contentText(p.content, source.path, line, BLOCKS), at: rec.timestamp });
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        const call: ToolCall = { id: p.call_id ?? p.id, name: String(p.name ?? p.type), arguments: redact(String(p.arguments ?? p.input ?? "")) };
        turns.push({ role: "assistant", content: "", at: rec.timestamp, toolCalls: [call] });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        turns.push({ role: "tool", content: redact(typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "")), at: rec.timestamp, toolCalls: [{ id: p.call_id, name: "tool_result" }] });
      }
    });
    if (cumulative) {
      const target = [...turns].reverse().find((t) => t.role === "assistant") ?? turns.at(-1);
      if (target) target.tokens = cumulative;
    }
    const [startedAt, endedAt] = finishTimes(turns, fallback);
    return { partialTail: parsed.partialTail, conversation: { id, provider, harness: this.harness, project: projectOf(cwd), cwd, model: model || "(unknown)", startedAt, endedAt, turns, resumeId: id, sourcePath: source.path } };
  }
}
