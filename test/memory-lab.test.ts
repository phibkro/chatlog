import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdjudicationPacket, HumanAdjudicationAnswers } from "../src/refinery-adjudication";
import type { MemoryProposalSet, OperatorReview } from "../src/workbench/memory-lab";
import { MemoryLab } from "../src/workbench/memory-lab";
import { WorkbenchData } from "../src/workbench/data";
import { workbenchHandler } from "../src/workbench/server";

async function fixture(): Promise<{
  root: string;
  directory: string;
  packet: AdjudicationPacket;
  template: HumanAdjudicationAnswers;
  proposalSet: MemoryProposalSet;
  proposalSetHash: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-lab-"));
  const packet: AdjudicationPacket = {
    schemaVersion: 2,
    packetHash: "public-packet-hash",
    sourceBindingHash: "private-source-binding",
    blinded: true,
    selectionRecipe: "refinery-human-adjudication-v3",
    instructions: {
      untrustedEvidence: true,
      verdicts: {
        genuine: "genuine",
        mixed: "mixed",
        boilerplate: "boilerplate",
      },
      evidence: "select evidence",
      insufficientContext: "ask the operator",
    },
    candidates: [
      {
        candidateAlias: "C001",
        signatureTheme: "repeated unusual recovery",
        evidence: [
          {
            evidenceId: "E01",
            sessionAlias: "S01",
            projectAlias: "P01",
            harnessAlias: "H01",
            snippet: "A blinded historical snippet.",
          },
        ],
      },
      {
        candidateAlias: "C002",
        signatureTheme: "uncertain operating boundary",
        evidence: [
          {
            evidenceId: "E02",
            sessionAlias: "S02",
            projectAlias: "P02",
            harnessAlias: "H02",
            snippet: "A second blinded historical snippet.",
          },
        ],
      },
    ],
  };
  const template: HumanAdjudicationAnswers = {
    schemaVersion: 2,
    packetHash: packet.packetHash,
    adjudicator: { id: "" },
    answers: {
      C001: {
        status: "unanswered",
        verdict: null,
        genuineEvidenceIds: [],
        confidence: null,
        reasoning: "",
      },
      C002: {
        status: "unanswered",
        verdict: null,
        genuineEvidenceIds: [],
        confidence: null,
        reasoning: "",
      },
    },
  };
  const proposalSet: MemoryProposalSet = {
    schemaVersion: 1,
    packetHash: packet.packetHash,
    generator: {
      provider: "test-provider",
      model: "test-model",
      effort: "medium",
      recipe: "memory-proposal-v1",
    },
    proposals: {
      C001: {
        lesson: "Preserve a proven recovery when this unusual failure recurs.",
        suggestedValence: "positive",
        rationale: "The evidence records a concrete successful recovery.",
      },
      C002: {
        lesson: "Ask before crossing an uncertain operating boundary.",
        suggestedValence: "neutral",
        rationale: "The evidence does not establish operator intent.",
      },
    },
  };
  const directory = join(root, "derived", "adjudication", "refinery", packet.packetHash, "public");
  const proposalBytes = `${JSON.stringify(proposalSet)}\n`;
  const proposalSetHash = createHash("sha256").update(proposalBytes).digest("hex");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(directory, "packet.json"), `${JSON.stringify(packet)}\n`, { mode: 0o600 }),
    writeFile(join(directory, "answers.template.json"), `${JSON.stringify(template)}\n`, {
      mode: 0o600,
    }),
    writeFile(join(directory, "proposals.json"), proposalBytes, {
      mode: 0o600,
    }),
  ]);
  return { root, directory, packet, template, proposalSet, proposalSetHash };
}

function reviewed(
  judgment: "correct" | "incorrect",
  valence: "positive" | "negative" | "neutral",
  feedback = "",
): OperatorReview {
  return { status: "reviewed", judgment, valence, feedback };
}

test("Memory Lab HTTP reads stay available while writes require capability, header, and bounds", async () => {
  const { root, packet, proposalSetHash } = await fixture();
  const data = new WorkbenchData(root);
  const lab = new MemoryLab(root);
  const readOnly = workbenchHandler(data, undefined, lab);
  const writable = workbenchHandler(data, undefined, lab, true);
  const payload = {
    packetHash: packet.packetHash,
    proposalSetHash,
    candidateAlias: "C001",
    reviewerId: "operator",
    review: reviewed("correct", "positive"),
  };
  try {
    const read = await readOnly(new Request("http://localhost/api/memory-lab"));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      packet: { packetHash: packet.packetHash },
      proposalSetHash,
    });

    const denied = await readOnly(
      new Request("http://localhost/api/memory-lab/draft", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "memory lab writes disabled" });

    const missingHeader = await writable(
      new Request("http://localhost/api/memory-lab/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
    expect(missingHeader.status).toBe(403);
    expect(await missingHeader.json()).toEqual({ error: "memory lab write header required" });

    const wrongContentType = await writable(
      new Request("http://localhost/api/memory-lab/draft", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(wrongContentType.status).toBe(415);
    expect(await wrongContentType.json()).toEqual({
      error: "memory lab writes require application/json",
    });

    const oversized = await writable(
      new Request("http://localhost/api/memory-lab/draft", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify({ payload: "x".repeat(16 * 1024) }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "memory lab request is too large" });

    const saved = await writable(
      new Request("http://localhost/api/memory-lab/draft", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      reviews: { reviews: { C001: { judgment: "correct" } } },
    });

    const ordinaryMutation = await writable(
      new Request("http://localhost/api/overview", { method: "POST" }),
    );
    expect(ordinaryMutation.status).toBe(405);
    expect(await ordinaryMutation.json()).toEqual({ error: "read-only workbench" });
  } finally {
    data.close();
  }
});

test("Memory Lab returns proposals and persists a separate exact operator-review ledger", async () => {
  const { root, directory, packet, proposalSet, proposalSetHash } = await fixture();
  const oldAnswers = '{"legacy":"must remain byte-for-byte"}\n';
  const oldFinalAnswers = "{malformed legacy final";
  await writeFile(join(directory, "answers.draft.json"), oldAnswers, { mode: 0o600 });
  await writeFile(join(directory, "answers.json"), oldFinalAnswers, { mode: 0o600 });
  const lab = new MemoryLab(root);

  expect(await lab.get()).toMatchObject({
    ok: true,
    value: {
      packet: { packetHash: packet.packetHash },
      proposalSet,
      proposalSetHash,
      reviews: {
        proposalSetHash,
        reviewer: { id: "" },
        reviews: {
          C001: { status: "unanswered", judgment: null, valence: null, feedback: "" },
          C002: { status: "unanswered", judgment: null, valence: null, feedback: "" },
        },
      },
      progress: {
        total: 2,
        completed: 0,
        correct: 0,
        incorrect: 0,
        unsure: 0,
        unanswered: 2,
      },
      finalized: false,
    },
  });

  const first = await lab.save({
    packetHash: packet.packetHash,
    proposalSetHash,
    candidateAlias: "C001",
    reviewerId: " operator ",
    review: reviewed("correct", "positive"),
  });
  expect(first).toMatchObject({
    ok: true,
    value: {
      reviews: {
        reviewer: { id: "operator" },
        reviews: { C001: { status: "reviewed", feedback: "" } },
      },
      progress: { completed: 1, correct: 1, unanswered: 1 },
    },
  });
  const draftPath = join(directory, "operator-reviews.draft.json");
  expect((await stat(draftPath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(draftPath, "utf8"))).toMatchObject({
    schemaVersion: 1,
    packetHash: packet.packetHash,
    proposalSetHash,
    reviewer: { id: "operator" },
    reviews: { C001: { judgment: "correct", valence: "positive", feedback: "" } },
  });
  expect(await new MemoryLab(root).get()).toMatchObject({
    ok: true,
    value: {
      proposalSetHash,
      reviews: {
        proposalSetHash,
        reviewer: { id: "operator" },
        reviews: { C001: { judgment: "correct", valence: "positive" } },
      },
    },
  });
  expect(await readFile(join(directory, "answers.draft.json"), "utf8")).toBe(oldAnswers);
  expect(await readFile(join(directory, "answers.json"), "utf8")).toBe(oldFinalAnswers);
});

test("Memory Lab requires an exact review shape and permits null valence only for unsure", async () => {
  const { root, directory, packet, proposalSetHash } = await fixture();
  const lab = new MemoryLab(root);
  const base = {
    packetHash: packet.packetHash,
    proposalSetHash,
    candidateAlias: "C001",
    reviewerId: "operator",
  };
  expect(
    await lab.save({
      packetHash: packet.packetHash,
      candidateAlias: "C001",
      reviewerId: "operator",
      review: reviewed("correct", "positive"),
    }),
  ).toEqual({
    ok: false,
    status: 400,
    error: "invalid memory lab draft request",
  });

  const invalidResults = await Promise.all(
    [
      { status: "reviewed", judgment: "correct", valence: null, feedback: "" },
      { status: "reviewed", judgment: "unsure", valence: "neutral", feedback: "" },
      { status: "unanswered", judgment: null, valence: null, feedback: "not blank" },
      {
        status: "reviewed",
        judgment: "incorrect",
        valence: "negative",
        feedback: "",
        extra: true,
      },
      {
        status: "reviewed",
        judgment: "incorrect",
        valence: "negative",
        feedback: "x".repeat(1_501),
      },
    ].map((review) => lab.save({ ...base, review })),
  );
  for (const result of invalidResults) {
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: "invalid memory lab draft request",
    });
  }
  expect(await Bun.file(join(directory, "operator-reviews.draft.json")).exists()).toBe(false);

  expect(
    await lab.save({
      ...base,
      review: { status: "reviewed", judgment: "unsure", valence: null, feedback: "" },
    }),
  ).toMatchObject({
    ok: true,
    value: { progress: { unsure: 1, completed: 1 } },
  });
  expect(
    await lab.save({
      ...base,
      extra: true,
      review: reviewed("incorrect", "negative", "Optional correction."),
    }),
  ).toMatchObject({ ok: false, status: 400 });
});

test("Memory Lab requires exact proposal coverage and rejects unknown proposal fields", async () => {
  const missing = await fixture();
  const missingProposal = structuredClone(missing.proposalSet);
  delete missingProposal.proposals.C002;
  await writeFile(
    join(missing.directory, "proposals.json"),
    `${JSON.stringify(missingProposal)}\n`,
    { mode: 0o600 },
  );
  expect(await new MemoryLab(missing.root).get()).toEqual({
    ok: false,
    status: 404,
    error: "memory lab packet not found",
  });

  const extra = await fixture();
  const extraProposal = structuredClone(extra.proposalSet) as MemoryProposalSet & {
    proposals: Record<string, MemoryProposalSet["proposals"][string] & { sourcePath?: string }>;
  };
  extraProposal.proposals.C001.sourcePath = "/private/corpus/session.jsonl";
  await writeFile(join(extra.directory, "proposals.json"), `${JSON.stringify(extraProposal)}\n`, {
    mode: 0o600,
  });
  expect(await new MemoryLab(extra.root).get()).toEqual({
    ok: false,
    status: 404,
    error: "memory lab packet not found",
  });

  const blankLesson = await fixture();
  const blank = structuredClone(blankLesson.proposalSet);
  blank.proposals.C001.lesson = "  ";
  await writeFile(join(blankLesson.directory, "proposals.json"), `${JSON.stringify(blank)}\n`, {
    mode: 0o600,
  });
  expect(await new MemoryLab(blankLesson.root).get()).toMatchObject({
    ok: false,
    status: 404,
  });

  const unknownAlias = await fixture();
  const unknown = structuredClone(unknownAlias.proposalSet);
  unknown.proposals.C999 = {
    lesson: "This alias is not in the public packet.",
    suggestedValence: "neutral",
    rationale: "It must not be surfaced.",
  };
  await writeFile(join(unknownAlias.directory, "proposals.json"), `${JSON.stringify(unknown)}\n`, {
    mode: 0o600,
  });
  expect(await new MemoryLab(unknownAlias.root).get()).toMatchObject({
    ok: false,
    status: 404,
  });

  const invalidTemplate = await fixture();
  await writeFile(
    join(invalidTemplate.directory, "answers.template.json"),
    `${JSON.stringify({ ...invalidTemplate.template, privateManifest: "/private/source" })}\n`,
    { mode: 0o600 },
  );
  expect(await new MemoryLab(invalidTemplate.root).get()).toMatchObject({
    ok: false,
    status: 404,
  });
});

test("Memory Lab fails closed on malformed or inexact operator-review ledgers", async () => {
  const { root, directory, packet, proposalSetHash } = await fixture();
  const draftPath = join(directory, "operator-reviews.draft.json");
  await writeFile(draftPath, "{malformed", { mode: 0o600 });
  const lab = new MemoryLab(root);

  expect(await lab.get()).toEqual({
    ok: false,
    status: 409,
    error: "memory lab review draft is invalid",
  });
  expect(
    await lab.save({
      packetHash: packet.packetHash,
      proposalSetHash,
      candidateAlias: "C001",
      reviewerId: "operator",
      review: reviewed("correct", "positive"),
    }),
  ).toMatchObject({ ok: false, status: 409 });
  expect(await readFile(draftPath, "utf8")).toBe("{malformed");

  const second = await fixture();
  await writeFile(
    join(second.directory, "operator-reviews.draft.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      packetHash: second.packet.packetHash,
      proposalSetHash: second.proposalSetHash,
      reviewer: { id: "operator" },
      reviews: {
        C001: reviewed("correct", "positive"),
      },
    })}\n`,
    { mode: 0o600 },
  );
  expect(await new MemoryLab(second.root).get()).toMatchObject({
    ok: false,
    status: 409,
  });

  const missingHash = await fixture();
  await writeFile(
    join(missingHash.directory, "operator-reviews.draft.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      packetHash: missingHash.packet.packetHash,
      reviewer: { id: "operator" },
      reviews: {
        C001: reviewed("correct", "positive"),
        C002: { status: "unanswered", judgment: null, valence: null, feedback: "" },
      },
    })}\n`,
    { mode: 0o600 },
  );
  expect(await new MemoryLab(missingHash.root).get()).toMatchObject({
    ok: false,
    status: 409,
  });
});

test("Memory Lab invalidates stale drafts and finals when exact proposal bytes change", async () => {
  const draftFixture = await fixture();
  const draftLab = new MemoryLab(draftFixture.root);
  expect(
    await draftLab.save({
      packetHash: draftFixture.packet.packetHash,
      proposalSetHash: draftFixture.proposalSetHash,
      candidateAlias: "C001",
      reviewerId: "operator",
      review: reviewed("correct", "positive"),
    }),
  ).toMatchObject({ ok: true });
  const changedProposals = structuredClone(draftFixture.proposalSet);
  changedProposals.proposals.C001.rationale = "A replacement proposal rationale.";
  await writeFile(
    join(draftFixture.directory, "proposals.json"),
    `${JSON.stringify(changedProposals)}\n`,
    { mode: 0o600 },
  );
  expect(await draftLab.get()).toEqual({
    ok: false,
    status: 409,
    error: "memory lab review draft is invalid",
  });
  expect(
    await draftLab.save({
      packetHash: draftFixture.packet.packetHash,
      proposalSetHash: draftFixture.proposalSetHash,
      candidateAlias: "C002",
      reviewerId: "operator",
      review: reviewed("correct", "neutral"),
    }),
  ).toEqual({
    ok: false,
    status: 409,
    error: "memory lab proposals changed; reload before saving",
  });

  const finalFixture = await fixture();
  const finalLab = new MemoryLab(finalFixture.root);
  const finalDrafts = await Promise.all(
    ["C001", "C002"].map((candidateAlias) =>
      finalLab.save({
        packetHash: finalFixture.packet.packetHash,
        proposalSetHash: finalFixture.proposalSetHash,
        candidateAlias,
        reviewerId: "operator",
        review: reviewed("correct", "positive"),
      }),
    ),
  );
  for (const draft of finalDrafts) expect(draft).toMatchObject({ ok: true });
  expect(
    await finalLab.finalize({
      packetHash: finalFixture.packet.packetHash,
      proposalSetHash: finalFixture.proposalSetHash,
      reviewerId: "operator",
    }),
  ).toMatchObject({ ok: true, value: { finalized: true } });
  const originalProposalBytes = await readFile(
    join(finalFixture.directory, "proposals.json"),
    "utf8",
  );
  await writeFile(join(finalFixture.directory, "proposals.json"), `${originalProposalBytes} `, {
    mode: 0o600,
  });
  expect(await finalLab.get()).toEqual({
    ok: false,
    status: 409,
    error: "finalized memory lab reviews are invalid",
  });
});

test("Memory Lab finalizes only complete reviews and locks mode-0600 output", async () => {
  const { root, directory, packet, proposalSetHash } = await fixture();
  const lab = new MemoryLab(root);
  await lab.save({
    packetHash: packet.packetHash,
    proposalSetHash,
    candidateAlias: "C001",
    reviewerId: "operator",
    review: reviewed("incorrect", "negative", "The correct lesson is to avoid this action."),
  });
  expect(
    await lab.finalize({
      packetHash: packet.packetHash,
      proposalSetHash: "0".repeat(64),
      reviewerId: "operator",
    }),
  ).toEqual({
    ok: false,
    status: 409,
    error: "memory lab proposals changed; reload before finishing",
  });
  expect(
    await lab.finalize({
      packetHash: packet.packetHash,
      reviewerId: "operator",
    }),
  ).toEqual({
    ok: false,
    status: 400,
    error: "invalid memory lab finalize request",
  });
  expect(
    await lab.finalize({
      packetHash: packet.packetHash,
      proposalSetHash,
      reviewerId: "operator",
    }),
  ).toMatchObject({ ok: false, status: 400 });
  expect(await Bun.file(join(directory, "operator-reviews.json")).exists()).toBe(false);

  await lab.save({
    packetHash: packet.packetHash,
    proposalSetHash,
    candidateAlias: "C002",
    reviewerId: "operator",
    review: { status: "reviewed", judgment: "unsure", valence: null, feedback: "" },
  });
  const finalized = await lab.finalize({
    packetHash: packet.packetHash,
    proposalSetHash,
    reviewerId: "operator",
  });
  expect(finalized).toMatchObject({
    ok: true,
    value: {
      finalized: true,
      progress: { total: 2, completed: 2, incorrect: 1, unsure: 1, unanswered: 0 },
    },
  });
  const finalPath = join(directory, "operator-reviews.json");
  expect((await stat(finalPath)).mode & 0o777).toBe(0o600);
  expect(await new MemoryLab(root).get()).toMatchObject({
    ok: true,
    value: { finalized: true },
  });
  expect(
    await lab.save({
      packetHash: packet.packetHash,
      proposalSetHash,
      candidateAlias: "C001",
      reviewerId: "operator",
      review: reviewed("correct", "positive"),
    }),
  ).toMatchObject({ ok: false, status: 409 });
});

test("Memory Lab finalization is create-once across process-local stores", async () => {
  const { root, directory, packet, proposalSetHash } = await fixture();
  const first = new MemoryLab(root);
  const second = new MemoryLab(root);
  const drafts = await Promise.all(
    ["C001", "C002"].map((candidateAlias) =>
      first.save({
        packetHash: packet.packetHash,
        proposalSetHash,
        candidateAlias,
        reviewerId: "draft-operator",
        review: reviewed("correct", "positive"),
      }),
    ),
  );
  for (const draft of drafts) expect(draft).toMatchObject({ ok: true });

  const [left, right] = await Promise.all([
    first.finalize({ packetHash: packet.packetHash, proposalSetHash, reviewerId: "operator-a" }),
    second.finalize({ packetHash: packet.packetHash, proposalSetHash, reviewerId: "operator-b" }),
  ]);
  expect(left).toMatchObject({ ok: true, value: { finalized: true } });
  expect(right).toMatchObject({ ok: true, value: { finalized: true } });
  const gold = JSON.parse(await readFile(join(directory, "operator-reviews.json"), "utf8"));
  expect(["operator-a", "operator-b"]).toContain(gold.reviewer.id);
  expect((await stat(join(directory, "operator-reviews.json"))).mode & 0o777).toBe(0o600);
});
