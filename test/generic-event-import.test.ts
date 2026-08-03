import { expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture, makeEvent, makeObservedSource, type AgentEventEnvelope } from "../src/events";
import { projectConversation } from "../src/conversation-projection";
import { GENERIC_EVENT_SCHEMA, GENERIC_EVENT_SCHEMA_VERSION } from "../src/generic-event-schema";
import {
  importGenericEvents,
  parseGenericEventText,
  previewGenericEvents,
} from "../src/importers/generic-events";

function header() {
  return {
    schema: GENERIC_EVENT_SCHEMA,
    schemaVersion: GENERIC_EVENT_SCHEMA_VERSION,
    type: "header" as const,
    producer: { name: "synthetic-producer", version: "1.0.0" },
    provider: "synthetic-provider",
    harness: "synthetic-harness",
    sourceKind: "generic-jsonl",
    domain: "coding",
    capturePolicyVersion: "chatlog-redacted-capture-v1",
    ordering: {
      key: "sequence" as const,
      contiguous: true as const,
      relations: "prior-only" as const,
    },
    identity: { key: "eventId" as const, algorithm: "sha256" as const },
    adapterRecipe: "chatlog-generic-events-v1:synthetic-producer@1.0.0",
  };
}

function fixture(sourcePath: string): string {
  const sourceBase = {
    provider: "synthetic-provider",
    harness: "synthetic-harness",
    sourceKind: "generic-jsonl",
    sourcePath,
    adapterRecipe: header().adapterRecipe,
    capturePolicyVersion: header().capturePolicyVersion,
  };
  const started = makeEvent({
    kind: "session.started",
    sequence: 0,
    actor: { kind: "provider", name: "synthetic" },
    scope: { sessionId: "synthetic-session", project: "fixture" },
    origin: {
      kind: "observed",
      source: makeObservedSource(
        {
          ...sourceBase,
          nativeSessionId: "synthetic-session",
          nativeItemId: "session-started",
          recordPosition: { line: 2 },
        },
        { kind: "session.started", canary: "token=fixture" },
      ),
    },
    relations: {},
    payload: {
      id: "synthetic-session",
      sessionId: "synthetic-session",
      provider: "synthetic-provider",
      harness: "synthetic-harness",
      project: "fixture",
      cwd: "",
      model: "synthetic-model",
    },
    capture: capture("normalized"),
  });
  const message = makeEvent({
    kind: "message.created",
    sequence: 1,
    actor: { kind: "human" },
    scope: { sessionId: "synthetic-session", project: "fixture" },
    origin: {
      kind: "observed",
      source: makeObservedSource(
        {
          ...sourceBase,
          nativeSessionId: "synthetic-session",
          nativeItemId: "message-1",
          recordPosition: { line: 3 },
        },
        { kind: "message.created", canary: "secret=fixture" },
      ),
    },
    relations: { parent: started.eventId },
    payload: { role: "user", content: "synthetic message" },
    capture: capture("normalized"),
  });
  return `${JSON.stringify(header())}\n${JSON.stringify(started)}\n${JSON.stringify(message)}\n`;
}

test("valid versioned generic stream previews without writing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-generic-preview-"));
  const source = join(root, "events.jsonl");
  await writeFile(source, fixture(source));
  const result = await previewGenericEvents(source, root);
  expect(result.schema).toBe("chatlog/generic-event-import-preview-v1");
  expect(result.events).toBe(2);
  expect(result.kinds["message.created"]).toBe(1);
  expect(await readdir(root)).toEqual(["events.jsonl"]);
});

test("generic import is idempotent, redacts canaries, and writes source receipt", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-generic-import-"));
  const source = join(base, "events.jsonl");
  const root = join(base, "data");
  await writeFile(source, fixture(source));
  const first = await importGenericEvents(source, root, { derive: false });
  expect(first.imported).toBe(1);
  expect(first.receipt.source.path).toBe(source);
  expect(JSON.stringify(first.receipt)).not.toContain("token=fixture");
  const second = await importGenericEvents(source, root, { derive: false });
  expect(second.skipped).toBe(1);
});

test("unsupported versions, duplicate IDs, bad relations, and chatlog origins fail closed", () => {
  const source = "/tmp/synthetic-events.jsonl";
  const event = JSON.parse(fixture(source).split("\n")[1]!) as AgentEventEnvelope;
  expect(() =>
    parseGenericEventText(
      `${JSON.stringify({ ...header(), schemaVersion: 99 })}\n${JSON.stringify(event)}\n`,
      source,
    ),
  ).toThrow("unsupported");
  expect(() =>
    parseGenericEventText(
      `${JSON.stringify(header())}\n${JSON.stringify(event)}\n${JSON.stringify(event)}\n`,
      source,
    ),
  ).toThrow("duplicate");
  const broken = { ...event, sequence: 0, relations: { parent: "missing" } };
  expect(() =>
    parseGenericEventText(`${JSON.stringify(header())}\n${JSON.stringify(broken)}\n`, source),
  ).toThrow("relation");
});

test("complete final records do not imply partialTail, while a truncated final record is explicit loss", () => {
  const source = "/tmp/synthetic-events.jsonl";
  const complete = parseGenericEventText(fixture(source).trimEnd(), source);
  expect(complete.batch.partialTail).toBe(false);
  const truncated = parseGenericEventText(
    `${fixture(source)}{"schemaVersion":1,"eventId":"truncated`,
    source,
  );
  expect(truncated.batch.partialTail).toBe(true);
  expect(truncated.batch.semanticLoss).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "partial-live-tail" })]),
  );
});

test("oversized lines fail before generic JSONL validation", () => {
  const source = "/tmp/synthetic-events.jsonl";
  const oversized = "x".repeat(256 * 1024 + 1);
  expect(() =>
    parseGenericEventText(`${JSON.stringify(header())}\n${oversized}\n`, source),
  ).toThrow("line exceeds size limit");
});

test("opaque generic events stay out of conversation projection", () => {
  const source = "/tmp/synthetic-events.jsonl";
  const message = JSON.parse(fixture(source).split("\n")[2]!) as AgentEventEnvelope;
  (message as unknown as Record<string, unknown>).kind = "future.provider.kind";
  message.sequence = 0;
  message.relations = {};
  if (message.origin.kind === "observed") message.origin.source.recordPosition = { line: 2 };
  const parsed = parseGenericEventText(
    `${JSON.stringify(header())}\n${JSON.stringify(message)}\n`,
    source,
  );
  expect(parsed.batch.events[0]?.kind).toBe("provider.opaque");
  expect(projectConversation(parsed.batch).turns).toEqual([]);
});
