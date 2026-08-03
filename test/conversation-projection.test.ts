import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude";
import { CodexAdapter } from "../src/adapters/codex";
import { PiAdapter } from "../src/adapters/pi";
import { projectConversation } from "../src/conversation-projection";
import { serializeEventBatch } from "../src/event-store";

test("production adapters emit deterministic batches and projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-events-adapters-"));
  await cp(join(import.meta.dir, "fixtures/events/claude.jsonl"), join(root, "claude.jsonl"));
  const adapter = new ClaudeAdapter(root);
  const source = (await adapter.discover())[0]!;
  const first = await adapter.adapt(source);
  const second = await adapter.adapt(source);
  expect(serializeEventBatch(first)).toBe(serializeEventBatch(second));
  const conversation = projectConversation(first);
  expect(conversation.harness).toBe("claude-code");
  expect(conversation.cwd).toBe("/tmp/project");
  expect(conversation.project).toBe("/tmp/project");
  expect(conversation.model).toBe("claude-test");
  expect(conversation.resumeId).toBe("claude-resume");
  expect(conversation.turns.some((turn) => turn.content.includes("private reasoning"))).toBe(false);
  expect(
    conversation.turns.flatMap((turn) => turn.toolCalls ?? []).map((call) => call.name),
  ).toContain("Read");
  expect(first.events.some((event) => event.kind === "model.reasoning.observed")).toBe(true);
});

test("Claude projection retains late metadata without a started record", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-events-claude-late-"));
  await cp(
    join(import.meta.dir, "fixtures/events/claude-no-start.jsonl"),
    join(root, "claude-no-start.jsonl"),
  );
  const adapter = new ClaudeAdapter(root);
  const conversation = projectConversation(await adapter.adapt((await adapter.discover())[0]!));
  expect(conversation.cwd).toBe("/tmp/late-project");
  expect(conversation.project).toBe("/tmp/late-project");
  expect(conversation.model).toBe("claude-late-test");
  expect(conversation.resumeId).toBe("claude-late-resume");
});

test("adapters treat a missing source root as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-events-missing-root-"));
  const adapter = new ClaudeAdapter(join(root, "missing"));
  expect(await adapter.discover()).toEqual([]);
});

test("Codex and Pi preserve compaction and provider distinctions", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-events-codex-pi-"));
  const codexRoot = join(root, "codex");
  const piRoot = join(root, "pi");
  await mkdir(codexRoot, { recursive: true });
  await mkdir(piRoot, { recursive: true });
  await cp(
    join(import.meta.dir, "fixtures/events/codex.jsonl"),
    join(codexRoot, "rollout-synthetic.jsonl"),
  );
  await cp(join(import.meta.dir, "fixtures/events/pi.jsonl"), join(piRoot, "session.jsonl"));
  const codex = new CodexAdapter(codexRoot);
  const pi = new PiAdapter(piRoot);
  const codexBatch = await codex.adapt((await codex.discover())[0]!);
  const piBatch = await pi.adapt((await pi.discover())[0]!);
  const codexConversation = projectConversation(codexBatch);
  expect(codexConversation.model).toBe("codex-test");
  expect(codexConversation.cwd).toBe("/tmp/project");
  expect(codexConversation.project).toBe("/tmp/project");
  expect(
    codexConversation.turns.toReversed().find((turn) => turn.role === "assistant")?.tokens,
  ).toEqual({
    input: 18,
    output: 4,
    cachedInput: 3,
    reasoning: 1,
    total: 26,
  });
  expect(codexBatch.events.some((event) => event.kind === "context.compacted")).toBe(true);
  expect(
    codexBatch.events.some(
      (event) => event.kind === "tool.execution.observed" && event.payload.status === "failed",
    ),
  ).toBe(true);
  expect(piBatch.events.some((event) => event.kind === "model.reasoning.observed")).toBe(true);
  expect(
    piBatch.events.some(
      (event) => event.kind === "provider.opaque" && event.payload.itemKind === "model_change",
    ),
  ).toBe(true);
});
