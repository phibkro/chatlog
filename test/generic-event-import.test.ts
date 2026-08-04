import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture, makeEvent, makeObservedSource, type AgentEventEnvelope } from "../src/events";
import { projectConversation } from "../src/conversation-projection";
import {
  GENERIC_EVENT_MAX_BATCH_SEMANTIC_LOSSES,
  GENERIC_EVENT_MAX_LINES,
  GENERIC_EVENT_SCHEMA,
  GENERIC_EVENT_SCHEMA_VERSION,
} from "../src/generic-event-schema";
import {
  GENERIC_MAX_CORPUS_OBJECT_BYTES,
  GENERIC_MAX_MANIFEST_BYTES,
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

function fixture(sourcePath: string, content = "synthetic message"): string {
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
    payload: { role: "user", content },
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
test("generic preview rejects a symlink instead of reopening a checked path", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-generic-symlink-"));
  const target = join(root, "target.jsonl");
  const source = join(root, "events.jsonl");
  await writeFile(target, fixture(target));
  await symlink(target, source);

  await expect(previewGenericEvents(source, join(root, "data"))).rejects.toThrow(
    /not a regular file/u,
  );
});

test("generic parsing bounds physical lines and semantic-loss cardinality before retention", () => {
  const source = "/tmp/synthetic-events.jsonl";
  const tooManyLines = `${JSON.stringify(header())}${"\n".repeat(GENERIC_EVENT_MAX_LINES + 1)}`;
  expect(() => parseGenericEventText(tooManyLines, source)).toThrow(
    "physical line count exceeds bound",
  );

  const batch = {
    type: "batch",
    events: [],
    semanticLoss: Array.from({ length: GENERIC_EVENT_MAX_BATCH_SEMANTIC_LOSSES + 1 }, () => ({})),
  };
  expect(() =>
    parseGenericEventText(`${JSON.stringify(header())}\n${JSON.stringify(batch)}\n`, source),
  ).toThrow("semantic-loss limit");
});

test("rejects an oversized generic-event corpus manifest before parsing", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-generic-manifest-limit-"));
  const source = join(base, "events.jsonl");
  const root = join(base, "data");
  await writeFile(source, fixture(source));
  const manifestPath = join(root, "corpus", "manifest.json");
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(manifestPath, "");
  await truncate(manifestPath, GENERIC_MAX_MANIFEST_BYTES + 1);
  await expect(previewGenericEvents(source, root)).rejects.toThrow(
    /generic-event corpus manifest.*file limit/u,
  );
});

test("rejects an oversized generic-event prior corpus object", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-generic-object-limit-"));
  const source = join(base, "events.jsonl");
  const root = join(base, "data");
  await writeFile(source, fixture(source));
  await importGenericEvents(source, root, { derive: false });
  const manifest = JSON.parse(await readFile(join(root, "corpus", "manifest.json"), "utf8")) as {
    sources: Record<string, { contentHash: string }>;
  };
  const contentHash = Object.values(manifest.sources)[0]!.contentHash;
  const objectPath = join(
    root,
    "corpus",
    "objects",
    contentHash.slice(0, 2),
    `${contentHash}.json`,
  );
  await writeFile(objectPath, "");
  await truncate(objectPath, GENERIC_MAX_CORPUS_OBJECT_BYTES + 1);
  await writeFile(source, fixture(source, "changed message"));
  await expect(previewGenericEvents(source, root)).rejects.toThrow(
    /generic-event prior corpus object.*file limit/u,
  );
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
test("generic import rejects observed forged reserved context events", () => {
  const source = "/tmp/synthetic-events.jsonl";
  const original = JSON.parse(fixture(source).split("\n")[1]!) as AgentEventEnvelope;
  const { eventId: _eventId, schemaVersion: _schemaVersion, ...input } = original;
  for (const kind of ["context.bundle.acknowledged", "context.outcome.observed"] as const) {
    const forged = makeEvent({ ...input, kind });
    expect(() =>
      parseGenericEventText(`${JSON.stringify(header())}\n${JSON.stringify(forged)}\n`, source),
    ).toThrow("chatlog");
  }
});

test("generic imports cannot assert closed-loop evaluator authority", () => {
  const source = "/tmp/synthetic-events.jsonl";
  const lines = fixture(source).trimEnd().split("\n");
  for (const reserved of [
    { ...header(), sourceKind: "chatlog-closed-loop-evaluator" },
    { ...header(), adapterRecipe: "chatlog-closed-loop-evaluator-v1" },
  ]) {
    lines[0] = JSON.stringify(reserved);
    expect(() => parseGenericEventText(`${lines.join("\n")}\n`, source)).toThrow(
      "reserved closed-loop evaluator authority",
    );
  }
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
