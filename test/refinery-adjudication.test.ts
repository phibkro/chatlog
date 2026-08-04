import { expect, test } from "bun:test";
import {
  buildAdjudicationPacket,
  chooseSignatureDiverseCandidates,
  REFINERY_CHALLENGE_IDS,
  sanitizeAdjudicationSnippet,
  validateAdjudicationAnswers,
} from "../src/refinery-adjudication";
import type {
  PromotionCandidate,
  PromotionEvidence,
  PromotionType,
  RefineryArtifact,
} from "../src/refinery";

const challengeTypes: Record<string, PromotionType> = {
  "1ad36ba6c1fb7fb08211": "claude-md",
  "74e94149e4337a28f731": "claude-md",
  "2b30fe00a74088a7d8e6": "claude-md",
  dc281ccc417ad9a65d00: "memory-or-adr",
  db6cfef5927487273969: "memory-or-adr",
  "0e26687832b89604a4b9": "memory-or-adr",
  "813434c9909b44190093": "memory-or-adr",
  b3df9468fc44c5fd089e: "memory-or-adr",
  d1e7c4a3455a73033067: "memory-or-adr",
  "7819705d83ee3de7090e": "memory-or-adr",
  "707c237feeef2547ca2f": "gotcha-skill",
};

function evidence(candidateIndex: number, evidenceIndex: number): PromotionEvidence {
  const conversationHash = `${String(candidateIndex + 1).padStart(2, "0")}${String(
    evidenceIndex + 1,
  ).repeat(62)}`.slice(0, 64);
  const sessionId = `private-session-${candidateIndex}-${evidenceIndex}`;
  const project = `/srv/share/projects/private-${candidateIndex % 4}`;
  const harness =
    evidenceIndex % 3 === 0 ? "codex" : evidenceIndex % 3 === 1 ? "claude-code" : "pi";
  const model = "private-model";
  const pointerUri = `chatlog://conversation/${"a".repeat(64)}/turn/${evidenceIndex}`;
  return {
    conversationHash,
    sessionId,
    project,
    harness,
    model,
    pointer: {
      turnIndex: evidenceIndex,
      uri: pointerUri,
    },
    snippet: `Source ${conversationHash} ${sessionId} ${project} ${harness === "pi" ? "Pi" : harness} ${model} ${pointerUri}; cross-reference /srv/share/projects/private-3; read /nix/store and file://internal/thing; contact person@example.com at https://internal.example/path; candidate ${candidateIndex} evidence ${evidenceIndex}`,
  };
}

function candidate(
  id: string,
  type: PromotionType,
  ratioRank: number,
  index: number,
): PromotionCandidate {
  return {
    id,
    type,
    signature: `/srv/share/projects/private-${index % 4}:theme-${index % 9}`,
    title: `private title ${index}`,
    status: type === "wiki-page-later" ? "deferred-follow-up" : "curation-required",
    frequency: {
      occurrences: 100,
      distinctSnippets: ratioRank + 1,
      conversations: 20,
      sessions: 10,
      projects: 2,
      harnesses: 2,
      threshold: 3,
    },
    evidence: Array.from({ length: 6 }, (_, evidenceIndex) => evidence(index, evidenceIndex)),
    curation: { principle: "private principle", route: "private route", checks: [] },
    evaluation: {
      contract: "agent-eval/promotion-v1",
      status: "unmeasured",
      minimumRunsPerArm: 3,
      control: "control",
      treatment: "treatment",
      metrics: [],
      keepRule: "keep",
      cutRule: "cut",
    },
  };
}

function artifact(): RefineryArtifact {
  const slots: Array<{ id: string; type: PromotionType }> = [
    // Low empirical tercile: four fixed + six balance rows.
    { id: REFINERY_CHALLENGE_IDS[0], type: challengeTypes[REFINERY_CHALLENGE_IDS[0]]! },
    { id: REFINERY_CHALLENGE_IDS[1], type: challengeTypes[REFINERY_CHALLENGE_IDS[1]]! },
    { id: REFINERY_CHALLENGE_IDS[2], type: challengeTypes[REFINERY_CHALLENGE_IDS[2]]! },
    { id: REFINERY_CHALLENGE_IDS[3], type: challengeTypes[REFINERY_CHALLENGE_IDS[3]]! },
    { id: "low-skill-1", type: "skill" },
    { id: "low-skill-2", type: "skill" },
    { id: "low-gotcha-1", type: "gotcha-skill" },
    { id: "low-gotcha-2", type: "gotcha-skill" },
    { id: "low-claude-1", type: "claude-md" },
    { id: "low-memory-1", type: "memory-or-adr" },
    // Middle: two fixed + eight balance rows.
    { id: REFINERY_CHALLENGE_IDS[4], type: challengeTypes[REFINERY_CHALLENGE_IDS[4]]! },
    { id: REFINERY_CHALLENGE_IDS[5], type: challengeTypes[REFINERY_CHALLENGE_IDS[5]]! },
    { id: "mid-skill-1", type: "skill" },
    { id: "mid-skill-2", type: "skill" },
    { id: "mid-skill-3", type: "skill" },
    { id: "mid-gotcha-1", type: "gotcha-skill" },
    { id: "mid-gotcha-2", type: "gotcha-skill" },
    { id: "mid-claude-1", type: "claude-md" },
    { id: "mid-claude-2", type: "claude-md" },
    { id: "mid-claude-3", type: "claude-md" },
    // High: five fixed + five balance rows.
    { id: REFINERY_CHALLENGE_IDS[6], type: challengeTypes[REFINERY_CHALLENGE_IDS[6]]! },
    { id: REFINERY_CHALLENGE_IDS[7], type: challengeTypes[REFINERY_CHALLENGE_IDS[7]]! },
    { id: REFINERY_CHALLENGE_IDS[8], type: challengeTypes[REFINERY_CHALLENGE_IDS[8]]! },
    { id: REFINERY_CHALLENGE_IDS[9], type: challengeTypes[REFINERY_CHALLENGE_IDS[9]]! },
    { id: REFINERY_CHALLENGE_IDS[10], type: challengeTypes[REFINERY_CHALLENGE_IDS[10]]! },
    { id: "high-skill-1", type: "skill" },
    { id: "high-skill-2", type: "skill" },
    { id: "high-gotcha-1", type: "gotcha-skill" },
    { id: "high-gotcha-2", type: "gotcha-skill" },
    { id: "high-claude-1", type: "claude-md" },
  ];
  return {
    schemaVersion: 1,
    inputProjectionHash: "projection-hash",
    recipeHash: "recipe-hash",
    threshold: 3,
    policy: {
      autoPromotion: false,
      frequencyIsSignalNotDecision: true,
      referenceWikiDeferred: true,
    },
    candidates: slots.map((slot, index) => candidate(slot.id, slot.type, index, index)),
  };
}

test("blinded packet is deterministic, balanced, reversible, and contains every challenge", () => {
  const source = artifact();
  const first = buildAdjudicationPacket(source, 30, "seed");
  const second = buildAdjudicationPacket(source, 30, "seed");
  expect(first).toEqual(second);
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  expect(first.privateManifest.selection.selectedStrata).toEqual({
    low: 10,
    middle: 10,
    high: 10,
  });
  expect(first.privateManifest.selection.selectedTypes).toEqual({
    "memory-or-adr": 8,
    "claude-md": 8,
    "gotcha-skill": 7,
    skill: 7,
  });
  expect(
    REFINERY_CHALLENGE_IDS.every((id) =>
      first.privateManifest.candidates.some((item) => item.candidateId === id),
    ),
  ).toBe(true);
  expect(first.packet.candidates).toHaveLength(30);
  expect(Object.keys(first.answers.answers)).toEqual(
    first.packet.candidates.map((item) => item.candidateAlias),
  );
  expect(first.answers).not.toHaveProperty("promotionEligible");

  for (const publicCandidate of first.packet.candidates) {
    const privateCandidate = first.privateManifest.candidates.find(
      (mapping) => mapping.candidateAlias === publicCandidate.candidateAlias,
    );
    expect(privateCandidate).toBeDefined();
    expect(publicCandidate.evidence.map((item) => item.evidenceId)).toEqual(
      privateCandidate!.evidence.map((item) => item.evidenceId),
    );
    expect(new Set(privateCandidate!.evidence.map((item) => item.sourceIndex)).size).toBe(
      publicCandidate.evidence.length,
    );
  }
});

test("public packet and markdown do not leak source identifiers or bakeoff metadata", () => {
  const source = artifact();
  const built = buildAdjudicationPacket(source, 30, "seed");
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  const publicText = JSON.stringify({ packet: built.packet, markdown: built.markdown });
  for (const item of source.candidates) {
    expect(publicText).not.toContain(item.id);
    expect(publicText).not.toContain(item.title);
    for (const sourceEvidence of item.evidence) {
      expect(publicText).not.toContain(sourceEvidence.sessionId);
      expect(publicText).not.toContain(sourceEvidence.conversationHash);
      expect(publicText).not.toContain(sourceEvidence.pointer.uri);
      expect(publicText).not.toContain(sourceEvidence.project);
      expect(publicText).not.toContain(sourceEvidence.model);
      if (sourceEvidence.harness.length >= 4)
        expect(publicText.toLowerCase()).not.toContain(sourceEvidence.harness.toLowerCase());
    }
  }
  expect(publicText).not.toContain("occurrences");
  expect(publicText).not.toContain("distinctSnippets");
  expect(publicText).not.toContain("gotcha-skill");
  expect(publicText).not.toContain("memory-or-adr");
  expect(publicText).not.toContain("/srv/share");
  expect(publicText).not.toContain("person@example.com");
  expect(publicText).not.toContain("internal.example");
  expect(publicText).not.toContain("chatlog://");
  expect(publicText).not.toContain("file://");
  expect(publicText).not.toContain("/nix/store");
  expect(publicText).not.toContain("<codex_internal_context");
  expect(publicText).not.toMatch(/\bpi\b/i);
});

test("packet hash and aliases change with the selection seed", () => {
  const source = artifact();
  const first = buildAdjudicationPacket(source, 30, "seed-a");
  const second = buildAdjudicationPacket(source, 30, "seed-b");
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(first.packet.packetHash).not.toBe(second.packet.packetHash);
  expect(first.privateManifest.candidates.map((item) => item.candidateId)).not.toEqual(
    second.privateManifest.candidates.map((item) => item.candidateId),
  );
});

test("packet hash binds the exact private source mapping", () => {
  const firstSource = artifact();
  const secondSource = structuredClone(firstSource);
  secondSource.candidates[0]!.evidence[0]!.pointer.uri = "chatlog://changed-private-pointer";
  const first = buildAdjudicationPacket(firstSource, 30, "seed");
  const second = buildAdjudicationPacket(secondSource, 30, "seed");
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(first.packet.sourceBindingHash).not.toBe(second.packet.sourceBindingHash);
  expect(first.packet.packetHash).not.toBe(second.packet.packetHash);
});

test("signature selection updates diversity after every chosen candidate", () => {
  const duplicateA = candidate("duplicate-a", "skill", 100, 100);
  duplicateA.signature = "scope:repeated-family";
  duplicateA.frequency.distinctSnippets = 100;
  const duplicateB = candidate("duplicate-b", "skill", 99, 99);
  duplicateB.signature = "scope:repeated-family";
  duplicateB.frequency.distinctSnippets = 99;
  const distinct = candidate("distinct", "skill", 1, 1);
  distinct.signature = "scope:distinct-family";
  distinct.frequency.distinctSnippets = 1;

  expect(
    chooseSignatureDiverseCandidates([duplicateA, duplicateB, distinct], 2, "seed").map(
      (item) => item.signature,
    ),
  ).toEqual(expect.arrayContaining(["scope:repeated-family", "scope:distinct-family"]));
});

test("answer template and schema bind exact candidate and evidence aliases", () => {
  const built = buildAdjudicationPacket(artifact(), 30, "seed");
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  expect(built.answers.packetHash).toBe(built.packet.packetHash);
  const schema = built.answerSchema as any;
  expect(schema.properties.packetHash.const).toBe(built.packet.packetHash);
  expect(schema.properties.answers.required).toEqual(
    built.packet.candidates.map((item) => item.candidateAlias),
  );
  for (const packetCandidate of built.packet.candidates) {
    const answerSchema = schema.properties.answers.properties[packetCandidate.candidateAlias];
    expect(answerSchema.properties.genuineEvidenceIds.items.enum).toEqual(
      packetCandidate.evidence.map((item) => item.evidenceId),
    );
    expect(answerSchema.oneOf).toHaveLength(5);
    expect(answerSchema.oneOf[2].properties.genuineEvidenceIds.maxItems).toBe(0);
    expect(answerSchema.oneOf[3].properties.genuineEvidenceIds.minItems).toBe(1);
  }
});

test("completed answer validation rejects inconsistent or unfinished labels", () => {
  const built = buildAdjudicationPacket(artifact(), 30, "seed");
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  const blank = structuredClone(built.answers);
  blank.adjudicator.id = "reviewer-1";
  expect(validateAdjudicationAnswers(built.packet, blank, false).ok).toBe(true);
  expect(validateAdjudicationAnswers(built.packet, built.answers).ok).toBe(false);

  const complete = structuredClone(built.answers);
  complete.adjudicator.id = "reviewer-1";
  for (const alias of Object.keys(complete.answers))
    complete.answers[alias] = {
      status: "decided",
      verdict: "genuine",
      genuineEvidenceIds: [
        built.packet.candidates.find((item) => item.candidateAlias === alias)!.evidence[0]!
          .evidenceId,
      ],
      confidence: "medium",
      reasoning: "The cited evidence substantively demonstrates the pattern.",
    };
  expect(validateAdjudicationAnswers(built.packet, complete).ok).toBe(true);

  const inconsistent = structuredClone(complete) as any;
  const firstAlias = built.packet.candidates[0]!.candidateAlias;
  inconsistent.answers[firstAlias].verdict = "boilerplate";
  expect(validateAdjudicationAnswers(built.packet, inconsistent)).toMatchObject({
    ok: false,
    errors: [{ code: "invalid-answer", candidateAlias: firstAlias }],
  });
});

test("packet construction rejects invalid counts and duplicate fixed IDs", () => {
  expect(buildAdjudicationPacket(artifact(), 0)).toMatchObject({
    ok: false,
    error: { code: "invalid-count" },
  });
  expect(buildAdjudicationPacket(artifact(), 10)).toMatchObject({
    ok: false,
    error: { code: "count-below-fixed-set" },
  });
  expect(buildAdjudicationPacket(artifact(), 30, "seed", ["same", "same"])).toMatchObject({
    ok: false,
    error: { code: "duplicate-fixed-id" },
  });
  expect(buildAdjudicationPacket(artifact(), 30, "seed", ["missing"])).toMatchObject({
    ok: false,
    error: { code: "missing-fixed-id" },
  });
});

test("packet-specific sanitization removes common PII and structural paths", () => {
  expect(
    sanitizeAdjudicationSnippet(
      "Use sk-abcdefghijklmnopqrstuvwxyz at https://internal.example/path or file://x from /home/nori/x and /nix/store; mail a@b.com or 10.0.0.8 using Codex with Pagu",
      [["pagu", "P1"]],
    ),
  ).toBe(
    "Use [REDACTED_API_KEY] at [URI] or [URI] from [PATH] and [PATH]; mail [EMAIL] or [IP] using [MODEL] with P1",
  );
});
