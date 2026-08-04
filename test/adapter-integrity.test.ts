import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude";
import { CodexAdapter } from "../src/adapters/codex";
import { OmpAdapter, PiAdapter } from "../src/adapters/pi";

const fixtureRoot = join(import.meta.dir, "fixtures/events");

async function copyFixture(name: string, root: string, filename: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await cp(join(fixtureRoot, name), join(root, filename));
}

test("Pi emits canonical project identity, fallback relations, and image loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-adapter-integrity-pi-"));
  const repo = join(root, "repo");
  const cwd = join(repo, "src");
  const sourceRoot = join(root, "pi");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  const records = [
    {
      type: "session",
      id: "pi-project",
      cwd,
      timestamp: "2026-08-01T12:00:00.000Z",
    },
    {
      type: "message",
      id: "m1",
      timestamp: "2026-08-01T12:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "shell", arguments: {} }],
      },
    },
    {
      type: "message",
      id: "m2",
      timestamp: "2026-08-01T12:00:02.000Z",
      message: {
        role: "toolResult",
        content: [
          { type: "toolResult", toolCallId: "missing-call", content: "fallback result" },
          { type: "image", id: "image-1", data: "synthetic-image" },
        ],
      },
    },
  ];
  await writeFile(
    join(sourceRoot, "session.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  const adapter = new PiAdapter(sourceRoot);
  const batch = await adapter.adapt((await adapter.discover())[0]!);
  const started = batch.events.find((event) => event.kind === "session.started");
  expect(started?.payload.project).toBe(repo);

  const fallback = batch.events.find(
    (event) => event.kind === "tool.result.observed" && event.payload.output === "fallback result",
  );
  expect(fallback).toBeDefined();
  const parent = fallback!.relations.parent;
  expect(parent).toBeTruthy();
  expect(fallback!.relations.causedBy).toEqual([parent!]);
  expect(batch.semanticLoss).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "attachment-body-excluded",
        details: expect.objectContaining({ blockType: "image" }),
      }),
    ]),
  );

  const omp = await new OmpAdapter(sourceRoot).adapt((await adapter.discover())[0]!);
  expect(omp.origin.kind === "observed" ? omp.origin.source.harness : null).toBe("omp");
  expect(omp.events.find((event) => event.kind === "session.started")?.payload.sourceKind).toBe(
    "omp-session",
  );
});

test("Codex does not infer success from completed response-item lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-adapter-integrity-codex-"));
  await copyFixture("codex.jsonl", root, "rollout.jsonl");
  const adapter = new CodexAdapter(root);
  const batch = await adapter.adapt((await adapter.discover())[0]!);

  expect(
    batch.events.some(
      (event) => event.kind === "tool.execution.observed" && event.payload.status === "succeeded",
    ),
  ).toBe(false);
  expect(
    batch.events.some(
      (event) => event.kind === "tool.result.observed" && event.payload.callId === "call-2",
    ),
  ).toBe(true);
  expect(batch.semanticLoss).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "encrypted-content-unavailable",
        details: expect.objectContaining({ blockType: "encrypted_content" }),
      }),
      expect.objectContaining({
        code: "attachment-body-excluded",
        details: expect.objectContaining({ blockType: "input_image" }),
      }),
      expect.objectContaining({
        code: "attachment-body-excluded",
        details: expect.objectContaining({ blockType: "image" }),
      }),
      expect.objectContaining({
        code: "attachment-body-excluded",
        details: expect.objectContaining({ blockType: "computer_screenshot" }),
      }),
      expect.objectContaining({
        code: "provider-field-unsupported",
        details: expect.objectContaining({ blockType: "computer_initialize_state" }),
      }),
    ]),
  );
});

test("Claude retains standalone result and tool-result text in its event batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-adapter-integrity-claude-"));
  await copyFixture("claude.jsonl", root, "session.jsonl");
  const adapter = new ClaudeAdapter(root);
  const batch = await adapter.adapt((await adapter.discover())[0]!);

  expect(
    batch.events.some(
      (event) =>
        event.kind === "message.created" && event.payload.content === "standalone result text",
    ),
  ).toBe(true);
  expect(
    batch.events.some(
      (event) => event.kind === "tool.result.observed" && event.payload.output === "file contents",
    ),
  ).toBe(true);
  expect(batch.semanticLoss).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "provider-field-unsupported",
        details: expect.objectContaining({ blockType: "advisor_tool_result" }),
      }),
      expect.objectContaining({
        code: "attachment-body-excluded",
        details: expect.objectContaining({ blockType: "image" }),
      }),
      expect.objectContaining({
        code: "attachment-body-excluded",
        details: expect.objectContaining({ blockType: "document" }),
      }),
      expect.objectContaining({
        code: "provider-field-unsupported",
        details: expect.objectContaining({ blockType: "web_search_tool_result" }),
      }),
      expect.objectContaining({
        code: "provider-field-unsupported",
        details: expect.objectContaining({ blockType: "web_fetch_tool_result" }),
      }),
    ]),
  );
});
