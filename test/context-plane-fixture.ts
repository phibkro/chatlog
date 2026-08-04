import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexConversation, indexEventBatch, openAnalysis } from "../src/analysis";
import { deriveCorpus } from "../src/derive";
import { persistEventBatch } from "../src/event-store";
import type { AcceptedMemoryLedger } from "../src/experience-memory";
import { applyInsightMigration } from "../src/insight-migration";
import { reconcileActiveSources } from "../src/source-authority";
import type { Conversation } from "../src/types";
import { syntheticEventBatch } from "./event-fixture";

export async function contextPlaneFixture(destination?: string): Promise<string> {
  const root = destination ?? (await mkdtemp(join(tmpdir(), "chatlog-context-plane-")));
  const conversation: Conversation = {
    id: "context-source",
    title: "Router lock repair",
    provider: "openai",
    harness: "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:01:00.000Z",
    sourcePath: "/context-source",
    contentHash: "a".repeat(64),
    turns: [
      { role: "user", content: "Fix router lock contention." },
      { role: "assistant", content: "Serialize custody before mutating router state." },
    ],
  };
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, conversation, 0, 1);
  const objectDirectory = join(root, "corpus", "objects", "aa");
  await mkdir(objectDirectory, { recursive: true });
  await writeFile(
    join(objectDirectory, `${conversation.contentHash}.json`),
    JSON.stringify(conversation),
  );
  const { contentHash: _contentHash, ...projection } = conversation;
  const batch = syntheticEventBatch(projection);
  const batchHash = await persistEventBatch(root, batch);
  indexEventBatch(db, batch, batchHash, conversation.contentHash);
  const sources = {
    [conversation.sourcePath]: {
      contentHash: conversation.contentHash,
      eventBatchHash: batchHash,
      conversationProjectionHash: conversation.contentHash,
    },
  };
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources }));
  reconcileActiveSources(db, sources);
  db.close();
  await deriveCorpus(root);

  const ledger: AcceptedMemoryLedger = {
    schemaVersion: 1,
    ledgerId: "context-plane-test",
    projectIdentity: "/project",
    entries: [
      {
        id: "router-lock",
        status: "accepted",
        judgment: "correct",
        valence: "positive",
        provenance: {
          packetHash: "b".repeat(64),
          proposalSetHash: "c".repeat(64),
          operatorReviewHash: "d".repeat(64),
          candidateAlias: "C001",
          candidateId: "e".repeat(20),
        },
        trigger: "router lock contention",
        scope: { kind: "global", value: null },
        polarity: "check",
        action: "Acquire the router lock before mutation.",
        situation: "Concurrent router mutation.",
        outcome: "Router state remains serial.",
        lesson: "Router writes require serialized lock custody.",
        confidence: 0.9,
        freshness: "current",
        canonicalDocs: ["design-specs/experience-memory.md"],
        evidencePointers: [`chatlog://event/${batchHash}/${batch.events[0]!.eventId}`],
      },
    ],
  };
  const memory = ledger.entries[0]!;
  const proposals = {
    schemaVersion: 1,
    packetHash: memory.provenance.packetHash,
    generator: { provider: "test" },
    proposals: {
      C001: { lesson: memory.lesson, suggestedValence: "positive", rationale: "test" },
    },
  };
  const proposalBytes = `${JSON.stringify(proposals, null, 2)}\n`;
  memory.provenance.proposalSetHash = createHash("sha256").update(proposalBytes).digest("hex");
  const reviews = {
    schemaVersion: 1,
    packetHash: memory.provenance.packetHash,
    proposalSetHash: memory.provenance.proposalSetHash,
    reviewer: { id: "operator" },
    reviews: {
      C001: { status: "reviewed", judgment: "correct", valence: "positive", feedback: "" },
    },
  };
  const reviewBytes = `${JSON.stringify(reviews, null, 2)}\n`;
  memory.provenance.operatorReviewHash = createHash("sha256").update(reviewBytes).digest("hex");
  const publicDirectory = join(
    root,
    "derived",
    "adjudication",
    "refinery",
    memory.provenance.packetHash,
    "public",
  );
  const privateDirectory = join(
    root,
    "derived",
    "adjudication",
    "refinery-private",
    memory.provenance.packetHash,
  );
  await Promise.all([
    mkdir(publicDirectory, { recursive: true }),
    mkdir(privateDirectory, { recursive: true }),
    mkdir(join(root, "memory"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(publicDirectory, "proposals.json"), proposalBytes),
    writeFile(join(publicDirectory, "operator-reviews.json"), reviewBytes),
    writeFile(
      join(privateDirectory, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packetHash: memory.provenance.packetHash,
        candidates: [{ candidateAlias: "C001", candidateId: memory.provenance.candidateId }],
      })}\n`,
    ),
    writeFile(join(root, "memory", "accepted-ledger.json"), `${JSON.stringify(ledger)}\n`),
  ]);
  const migrated = await applyInsightMigration(root);
  if (!migrated.ok) throw new Error(JSON.stringify(migrated.error));
  return root;
}
