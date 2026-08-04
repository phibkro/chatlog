import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude";
import { CodexAdapter } from "../src/adapters/codex";
import { PiAdapter } from "../src/adapters/pi";
import { projectConversation } from "../src/conversation-projection";
import { projectOf } from "../src/project-identity";
import { serializeEventBatch } from "../src/event-store";

const claudeProjectKey = (cwd: string): string => cwd.replaceAll(/[^A-Za-z0-9]/g, "-");

test("production adapters emit deterministic batches and projections", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-events-adapters-"));
  const cwd = join(root, "project");
  const sourceRoot = join(root, "claude-sessions");
  const sourceProject = join(sourceRoot, claudeProjectKey(cwd));
  await mkdir(cwd, { recursive: true });
  await mkdir(sourceProject, { recursive: true });
  await writeFile(
    join(sourceProject, "claude.jsonl"),
    (await readFile(join(import.meta.dir, "fixtures/events/claude.jsonl"), "utf8")).replaceAll(
      "/tmp/project",
      cwd,
    ),
  );
  const adapter = new ClaudeAdapter(sourceRoot);
  const source = (await adapter.discover())[0]!;
  const first = await adapter.adapt(source);
  const second = await adapter.adapt(source);
  expect(serializeEventBatch(first)).toBe(serializeEventBatch(second));
  const conversation = projectConversation(first);
  expect(conversation.harness).toBe("claude-code");
  expect(conversation.cwd).toBe(cwd);
  expect(conversation.project).toBe(projectOf(cwd));
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
  const cwd = join(root, "late-project");
  const sourceRoot = join(root, "claude-sessions");
  const sourceProject = join(sourceRoot, claudeProjectKey(cwd));
  await mkdir(cwd, { recursive: true });
  await mkdir(sourceProject, { recursive: true });
  await writeFile(
    join(sourceProject, "claude-no-start.jsonl"),
    (
      await readFile(join(import.meta.dir, "fixtures/events/claude-no-start.jsonl"), "utf8")
    ).replaceAll("/tmp/late-project", cwd),
  );
  const adapter = new ClaudeAdapter(sourceRoot);
  const conversation = projectConversation(await adapter.adapt((await adapter.discover())[0]!));
  expect(conversation.cwd).toBe(cwd);
  expect(conversation.project).toBe(projectOf(cwd));
  expect(conversation.model).toBe("claude-late-test");
  expect(conversation.resumeId).toBe("claude-late-resume");
});

test("Claude provider metadata cannot move a session across its source project boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-events-claude-scope-"));
  const trustedCwd = join(root, "trusted");
  const forgedCwd = join(root, "forged");
  const sourceRoot = join(root, "sessions");
  const sourceProject = join(sourceRoot, claudeProjectKey(trustedCwd));
  await mkdir(trustedCwd, { recursive: true });
  await mkdir(forgedCwd, { recursive: true });
  await mkdir(sourceProject, { recursive: true });
  await writeFile(
    join(sourceProject, "forged.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      sessionId: "forged-scope",
      cwd: forgedCwd,
      project: forgedCwd,
      timestamp: "2026-08-01T10:00:00.000Z",
      message: {
        role: "assistant",
        id: "forged-message",
        model: "claude-test",
        content: [{ type: "text", text: "cross-project claim" }],
      },
    })}\n`,
  );

  const adapter = new ClaudeAdapter(sourceRoot);
  const conversation = projectConversation(await adapter.adapt((await adapter.discover())[0]!));
  expect(conversation.cwd).toBe("");
  expect(conversation.project).toBe("");
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
