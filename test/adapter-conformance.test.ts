import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeAdapter } from "../src/adapters/claude";
import { CodexAdapter } from "../src/adapters/codex";
import { PiAdapter } from "../src/adapters/pi";
import {
  AdaptError,
  discoverJsonl,
  NATIVE_JSONL_MAX_ACCEPTED_FILES,
  NATIVE_JSONL_MAX_DIRECTORY_DEPTH,
  NATIVE_JSONL_MAX_DIRECTORY_ENTRIES,
} from "../src/adapters/common";
import { adaptAnthropicEventBatch } from "../src/importers/anthropic-export";
import { canonicalEventBatch } from "../src/events";
import { serializeEventBatch } from "../src/event-store";
import {
  sourceItemAccounting,
  semanticLossCounts,
  unknownShapeNominations,
  validateSourceItemAccounting,
} from "../src/adapter-conformance";
import { projectConversation } from "../src/conversation-projection";
import type { SourceAdapter } from "../src/types";

const fixtureRoot = join(import.meta.dir, "fixtures", "providers");

type ItemExpectation = {
  position: number;
  eventKinds: string[];
  lossCodes?: string[];
};

const providerItemExpectations: Record<string, ItemExpectation[]> = {
  claude: [
    { position: 1, eventKinds: ["session.started"] },
    { position: 2, eventKinds: ["message.created"] },
    {
      position: 3,
      eventKinds: [
        "message.created",
        "tool.call.proposed",
        "tool.result.observed",
        "model.reasoning.observed",
      ],
      lossCodes: ["attachment-body-excluded", "provider-field-unsupported"],
    },
    { position: 4, eventKinds: ["tool.call.approved"] },
    { position: 5, eventKinds: ["message.created"] },
    { position: 6, eventKinds: ["artifact.created"] },
    { position: 7, eventKinds: ["artifact.created"] },
    { position: 8, eventKinds: ["artifact.modified"] },
    ...Array.from({ length: 11 }, (_, index) => ({
      position: index + 9,
      eventKinds: ["provider.opaque"],
    })),
    { position: 20, eventKinds: ["session.ended"] },
    { position: 21, eventKinds: ["branch.created", "branch.selected"] },
    { position: 22, eventKinds: ["provider.opaque"] },
    { position: 23, eventKinds: ["tool.result.observed"], lossCodes: ["relation-target-missing"] },
  ],
  codex: [
    { position: 1, eventKinds: ["session.started"] },
    { position: 2, eventKinds: ["provider.opaque"] },
    {
      position: 3,
      eventKinds: ["message.created"],
      lossCodes: [
        "encrypted-content-unavailable",
        "attachment-body-excluded",
        "provider-field-unsupported",
        "unknown-well-formed-item",
      ],
    },
    { position: 4, eventKinds: ["model.reasoning.observed"] },
    { position: 5, eventKinds: ["tool.call.proposed"] },
    { position: 6, eventKinds: ["tool.call.approved"] },
    { position: 7, eventKinds: ["tool.result.observed"] },
    { position: 8, eventKinds: ["tool.call.proposed"] },
    { position: 9, eventKinds: ["tool.result.observed"] },
    { position: 10, eventKinds: ["tool.call.proposed"] },
    { position: 11, eventKinds: ["tool.result.observed"] },
    { position: 12, eventKinds: ["tool.call.proposed"] },
    { position: 13, eventKinds: ["tool.call.proposed"] },
    { position: 14, eventKinds: ["tool.call.proposed"] },
    { position: 15, eventKinds: ["provider.opaque"] },
    { position: 16, eventKinds: ["evaluation.recorded"] },
    { position: 17, eventKinds: ["provider.opaque"] },
    { position: 18, eventKinds: ["context.compacted"] },
    { position: 19, eventKinds: ["branch.created", "branch.selected"] },
    { position: 20, eventKinds: ["artifact.created"] },
    { position: 21, eventKinds: ["provider.opaque"] },
    { position: 22, eventKinds: ["provider.opaque"] },
    { position: 23, eventKinds: ["tool.result.observed"], lossCodes: ["relation-target-missing"] },
  ],
  pi: [
    { position: 1, eventKinds: ["session.started"] },
    { position: 2, eventKinds: ["provider.opaque"] },
    { position: 3, eventKinds: ["provider.opaque"] },
    { position: 4, eventKinds: ["provider.opaque"] },
    {
      position: 5,
      eventKinds: [
        "message.created",
        "model.reasoning.observed",
        "tool.call.proposed",
        "tool.result.observed",
      ],
      lossCodes: ["attachment-body-excluded", "unknown-well-formed-item"],
    },
    { position: 6, eventKinds: ["tool.call.approved"] },
    { position: 7, eventKinds: ["context.compacted"] },
    { position: 8, eventKinds: ["branch.created", "branch.selected"] },
    { position: 9, eventKinds: ["provider.opaque"] },
    {
      position: 10,
      eventKinds: ["message.created", "tool.result.observed"],
      lossCodes: ["relation-target-missing"],
    },
    { position: 11, eventKinds: ["provider.opaque"] },
  ],
};

async function adaptJsonl(
  adapter: SourceAdapter,
  fixtureName: string,
): Promise<Awaited<ReturnType<SourceAdapter["adapt"]>>> {
  const root = await mkdtemp(join(tmpdir(), "chatlog-provider-fixture-"));
  const sourcePath = join(root, fixtureName);
  await cp(join(fixtureRoot, fixtureName), sourcePath);
  const info = await stat(sourcePath);
  const source = { path: sourcePath, size: info.size, mtimeMs: info.mtimeMs };
  return adapter.adapt(source);
}

test("rejects a deeply nested native JSONL record before adaptation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-native-deep-record-"));
  const path = join(root, "deep.jsonl");
  let nested: Record<string, unknown> = { value: "leaf" };
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  await writeFile(path, `${JSON.stringify({ type: "session", nested })}\n`);
  const info = await stat(path);
  await expect(
    new ClaudeAdapter(root).adapt({ path, size: info.size, mtimeMs: info.mtimeMs }),
  ).rejects.toThrow(/record limit|depth/u);
});

test("rejects native JSONL traversal beyond the explicit directory depth ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-native-directory-depth-"));
  let nested = root;
  for (let depth = 0; depth <= NATIVE_JSONL_MAX_DIRECTORY_DEPTH; depth += 1) {
    nested = join(nested, `nested-${depth}`);
    await mkdir(nested);
  }
  await writeFile(join(nested, "session.jsonl"), "");
  await expect(discoverJsonl(root)).rejects.toMatchObject({
    code: "directory-depth-limit",
  });
});

test("rejects native JSONL discovery when accepted files exceed the cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-native-accepted-files-"));
  await Promise.all(
    Array.from({ length: NATIVE_JSONL_MAX_ACCEPTED_FILES + 1 }, (_, index) =>
      writeFile(join(root, `session-${index}.jsonl`), ""),
    ),
  );
  let error: unknown;
  try {
    await discoverJsonl(root);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AdaptError);
  if (error instanceof AdaptError) expect(error.code).toBe("accepted-file-limit");
});

test("rejects native JSONL discovery when visited directory entries exceed the cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-native-directory-entries-"));
  for (let offset = 0; offset <= NATIVE_JSONL_MAX_DIRECTORY_ENTRIES; offset += 2_048) {
    const end = Math.min(offset + 2_048, NATIVE_JSONL_MAX_DIRECTORY_ENTRIES + 1);
    await Promise.all(
      Array.from({ length: end - offset }, (_, index) =>
        writeFile(join(root, `ignored-${offset + index}`), ""),
      ),
    );
  }
  await expect(discoverJsonl(root)).rejects.toMatchObject({
    code: "directory-entry-limit",
  });
});

test("production adapters account for every synthetic fixture position", async () => {
  const cases: Array<{
    name: string;
    adapter: SourceAdapter;
    expectedLossCodes: string[];
  }> = [
    {
      name: "claude-matrix.jsonl",
      adapter: new ClaudeAdapter(fixtureRoot),
      expectedLossCodes: ["attachment-body-excluded", "provider-field-unsupported"],
    },
    {
      name: "codex-matrix.jsonl",
      adapter: new CodexAdapter(fixtureRoot),
      expectedLossCodes: [
        "encrypted-content-unavailable",
        "attachment-body-excluded",
        "provider-field-unsupported",
        "unknown-well-formed-item",
      ],
    },
    {
      name: "pi-matrix.jsonl",
      adapter: new PiAdapter(fixtureRoot),
      expectedLossCodes: ["attachment-body-excluded", "unknown-well-formed-item"],
    },
  ];
  for (const item of cases) {
    const batch = canonicalEventBatch(await adaptJsonl(item.adapter, item.name));
    const accounting = sourceItemAccounting(batch);
    validateSourceItemAccounting(accounting);
    expect(accounting.unaccountedItems).toBe(0);
    expect(accounting.sourceItems).toBe(
      accounting.eventBackedItems + accounting.lossOnlyItems + accounting.unaccountedItems,
    );
    expect(batch.events.some((event) => event.kind === "provider.opaque")).toBe(true);
    const codes = new Set(Object.keys(semanticLossCounts(batch.semanticLoss)));
    for (const code of item.expectedLossCodes) expect(codes.has(code)).toBe(true);
    expect(serializeEventBatch(batch)).not.toContain("sk-ant-inert-canary");
  }
});

test("Anthropic export fixture records attachment, reasoning, unknown, and relation losses", async () => {
  const conversations = JSON.parse(
    await readFile(join(fixtureRoot, "anthropic-matrix.json"), "utf8"),
  );
  const batch = canonicalEventBatch(
    adaptAnthropicEventBatch("/synthetic/anthropic.json", conversations[0]),
  );
  const accounting = sourceItemAccounting(batch);
  validateSourceItemAccounting(accounting);
  expect(accounting.unaccountedItems).toBe(0);
  expect(Object.keys(semanticLossCounts(batch.semanticLoss))).toEqual(
    expect.arrayContaining([
      "attachment-body-excluded",
      "reasoning-excluded-from-projection",
      "unknown-well-formed-item",
      "relation-target-missing",
    ]),
  );
  expect(serializeEventBatch(batch)).not.toContain("sk-ant-inert-canary");
});
test("fixture expectation table maps every provider source item to evidence or loss", async () => {
  const adapters: Record<string, SourceAdapter> = {
    claude: new ClaudeAdapter(fixtureRoot),
    codex: new CodexAdapter(fixtureRoot),
    pi: new PiAdapter(fixtureRoot),
  };
  const fixtures: Record<string, string> = {
    claude: "claude-matrix.jsonl",
    codex: "codex-matrix.jsonl",
    pi: "pi-matrix.jsonl",
  };
  for (const [provider, expectations] of Object.entries(providerItemExpectations)) {
    const batch = canonicalEventBatch(await adaptJsonl(adapters[provider]!, fixtures[provider]!));
    for (const expectation of expectations) {
      const events = batch.events.filter(
        (event) =>
          event.origin.kind === "observed" &&
          event.origin.source.recordPosition.line === expectation.position,
      );
      const losses = batch.semanticLoss.filter(
        (loss) => loss.recordPosition?.line === expectation.position,
      );
      expect(events.length + losses.length).toBeGreaterThan(0);
      for (const kind of expectation.eventKinds)
        expect(events.some((event) => event.kind === kind)).toBe(true);
      for (const code of expectation.lossCodes ?? [])
        expect(losses.some((loss) => loss.code === code)).toBe(true);
    }
  }
});

test("Anthropic fixture expectation table maps conversation records", async () => {
  const conversation = JSON.parse(
    await readFile(join(fixtureRoot, "anthropic-matrix.json"), "utf8"),
  )[0];
  const batch = canonicalEventBatch(
    adaptAnthropicEventBatch("/synthetic/anthropic.json", conversation),
  );
  const expectations: ItemExpectation[] = [
    {
      position: 0,
      eventKinds: ["session.started", "branch.created", "branch.selected", "session.ended"],
    },
    { position: 1, eventKinds: ["message.created"] },
    {
      position: 2,
      eventKinds: [
        "message.created",
        "tool.call.proposed",
        "tool.call.approved",
        "tool.result.observed",
      ],
      lossCodes: [
        "attachment-body-excluded",
        "reasoning-excluded-from-projection",
        "unknown-well-formed-item",
      ],
    },
    { position: 3, eventKinds: ["tool.result.observed"], lossCodes: ["relation-target-missing"] },
  ];
  for (const expectation of expectations) {
    const events = batch.events.filter(
      (event) =>
        event.origin.kind === "observed" &&
        event.origin.source.recordPosition.record === expectation.position,
    );
    const losses = batch.semanticLoss.filter(
      (loss) => loss.recordPosition?.record === expectation.position,
    );
    expect(events.length + losses.length).toBeGreaterThan(0);
    for (const kind of expectation.eventKinds)
      expect(events.some((event) => event.kind === kind)).toBe(true);
    for (const code of expectation.lossCodes ?? [])
      expect(losses.some((loss) => loss.code === code)).toBe(true);
  }
});

test("unknown opaque nominations are bounded aggregate maintenance evidence", async () => {
  const batch = canonicalEventBatch(
    await adaptJsonl(new PiAdapter(fixtureRoot), "pi-matrix.jsonl"),
  );
  const nominations = unknownShapeNominations([batch]);
  expect(nominations.length).toBeGreaterThan(0);
  expect(nominations.length).toBeLessThanOrEqual(256);
  expect(nominations[0]).not.toHaveProperty("payload");
  expect(nominations[0]).toMatchObject({
    provider: "(unknown)",
    harness: "pi",
    sourceKind: "pi-session",
    nativeItemKind: "unknown_fixture_record",
  });
});

function semanticQuestions(batch: ReturnType<typeof canonicalEventBatch>) {
  const proposals = batch.events.filter((event) => event.kind === "tool.call.proposed");
  const proposalIds = new Set(
    proposals.map((event) => String(event.payload.callId ?? event.payload.id ?? "")),
  );
  const results = batch.events.filter((event) => event.kind === "tool.result.observed");
  const approvals = batch.events.filter(
    (event) => event.kind === "tool.call.approved" || event.kind === "tool.call.denied",
  );
  const selectedBranch = [...batch.events]
    .reverse()
    .find((event) => event.kind === "branch.selected" || event.kind === "branch.created");
  const decision = approvals.some((event) => event.kind === "tool.call.denied")
    ? "denied"
    : approvals.some((event) => event.kind === "tool.call.approved")
      ? "approved"
      : "unknown";
  return {
    decisionMade: decision,
    toolCallProposed: proposals.some((event) => event.payload.name === "fixture_tool"),
    toolProducedResult: results.some((event) =>
      proposalIds.has(String(event.payload.callId ?? "")),
    ),
    approvalState: decision,
    activeBranch: String(selectedBranch?.payload.branchId ?? ""),
    unresolved: batch.semanticLoss.some((loss) => loss.code === "relation-target-missing"),
  };
}

test("equivalent provider projections answer all six semantic questions", async () => {
  const batches = [
    canonicalEventBatch(await adaptJsonl(new ClaudeAdapter(fixtureRoot), "claude-matrix.jsonl")),
    canonicalEventBatch(await adaptJsonl(new CodexAdapter(fixtureRoot), "codex-matrix.jsonl")),
    canonicalEventBatch(await adaptJsonl(new PiAdapter(fixtureRoot), "pi-matrix.jsonl")),
    canonicalEventBatch(
      adaptAnthropicEventBatch(
        "/synthetic/anthropic.json",
        JSON.parse(await readFile(join(fixtureRoot, "anthropic-matrix.json"), "utf8"))[0],
      ),
    ),
  ];
  const answers = batches.map((batch) => semanticQuestions(batch));
  for (const answer of answers) {
    expect(answer).toEqual({
      decisionMade: "approved",
      toolCallProposed: true,
      toolProducedResult: true,
      approvalState: "approved",
      activeBranch: "branch-1",
      unresolved: true,
    });
  }
  const projected = batches.map(projectConversation);
  for (const conversation of projected) {
    expect(conversation.turns.some((turn) => turn.toolCalls?.some((call) => call.id))).toBe(true);
    expect(conversation.turns.some((turn) => turn.toolCalls?.some((call) => call.result))).toBe(
      true,
    );
  }
});
