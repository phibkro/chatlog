import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewInsightMigration } from "../src/insight-migration";

const HASH = "d".repeat(64);
const CANDIDATE = "e".repeat(20);
const pointer = `chatlog://conversation/${HASH}/turn/0`;
const hashBytes = (value: string): string => createHash("sha256").update(value).digest("hex");

test("v1 migration preview is deterministic and does not write", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-insight-migration-"));
  const packet = HASH;
  const publicDir = join(root, "derived", "adjudication", "refinery", packet, "public");
  const privateDir = join(root, "derived", "adjudication", "refinery-private", packet);
  await mkdir(publicDir, { recursive: true });
  await mkdir(privateDir, { recursive: true });
  const proposals = {
    schemaVersion: 1,
    packetHash: packet,
    generator: { provider: "test", model: "test", effort: "low", recipe: "test" },
    proposals: {
      C001: {
        lesson: "Keep the evidence exact",
        suggestedValence: "positive",
        rationale: "fixture",
      },
    },
  };
  const proposalBytes = `${JSON.stringify(proposals, null, 2)}\n`;
  const proposalSetHash = hashBytes(proposalBytes);
  const reviews = {
    schemaVersion: 1,
    packetHash: packet,
    proposalSetHash,
    reviewer: { id: "operator" },
    reviews: {
      C001: { status: "reviewed", judgment: "correct", valence: "positive", feedback: "" },
    },
  };
  const reviewBytes = `${JSON.stringify(reviews, null, 2)}\n`;
  await writeFile(join(publicDir, "proposals.json"), proposalBytes);
  await writeFile(join(publicDir, "operator-reviews.json"), reviewBytes);
  await writeFile(
    join(privateDir, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 2, packetHash: packet, sourceBindingHash: HASH, candidates: [{ candidateAlias: "C001", candidateId: CANDIDATE }] }, null, 2)}\n`,
  );
  const ledger = {
    schemaVersion: 1,
    ledgerId: "v1",
    projectIdentity: "project",
    entries: [
      {
        id: "memory-one",
        status: "accepted",
        judgment: "correct",
        valence: "positive",
        provenance: {
          packetHash: packet,
          proposalSetHash,
          operatorReviewHash: hashBytes(reviewBytes),
          candidateAlias: "C001",
          candidateId: CANDIDATE,
        },
        trigger: "when evidence matters",
        scope: { kind: "repository", value: "project" },
        polarity: "check",
        action: "keep evidence exact",
        situation: "situation",
        outcome: "outcome",
        lesson: "Keep the evidence exact",
        confidence: 0.8,
        freshness: "current",
        canonicalDocs: ["https://docs.example/authority"],
        evidencePointers: [pointer],
      },
    ],
  };
  const ledgerPath = join(root, "memory", "accepted-ledger.json");
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const first = await previewInsightMigration(root);
  const second = await previewInsightMigration(root);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (first.ok && second.ok)
    expect(JSON.stringify(first.value.ledger)).toBe(JSON.stringify(second.value.ledger));
  expect(await readFile(ledgerPath, "utf8")).toContain("accepted");
});
