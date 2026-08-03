import type { MemoryLabView } from "./main";

export const memoryLabFixture = (completed = 0): MemoryLabView => ({
  packet: {
    packetHash: "fixture-packet",
    candidates: [
      {
        candidateAlias: "C001",
        signatureTheme: "Recovering from an unusual tool boundary",
        evidence: [
          {
            evidenceId: "E01",
            sessionAlias: "S01",
            projectAlias: "P01",
            harnessAlias: "H01",
            snippet: "<img src=x alt=owned> is inert historical text.",
          },
        ],
      },
      {
        candidateAlias: "C002",
        signatureTheme: "A missing operator preference",
        evidence: [
          {
            evidenceId: "E02",
            sessionAlias: "S02",
            projectAlias: "P02",
            harnessAlias: "H02",
            snippet: "The agent stopped and asked before assuming.",
          },
        ],
      },
    ],
  },
  proposalSet: {
    schemaVersion: 1,
    packetHash: "fixture-packet",
    generator: {
      provider: "anthropic",
      model: "fixture-model",
      effort: "medium",
      recipe: "memory-proposal-v1",
    },
    proposals: {
      C001: {
        lesson: "When an unusual tool boundary appears, verify the boundary before continuing.",
        suggestedValence: "negative",
        rationale: "The excerpts describe a repeated failure-and-recovery pattern.",
      },
      C002: {
        lesson: "Ask the operator when a missing preference would materially change the result.",
        suggestedValence: "positive",
        rationale: "The agent stopped instead of inventing an operator preference.",
      },
    },
  },
  proposalSetHash: "fixture-proposal-set-hash",
  reviews: {
    schemaVersion: 1,
    packetHash: "fixture-packet",
    proposalSetHash: "fixture-proposal-set-hash",
    reviewer: { id: completed > 0 ? "operator" : "" },
    reviews: {
      C001:
        completed > 0
          ? {
              status: "reviewed",
              judgment: "correct",
              valence: "positive",
              feedback: "",
            }
          : {
              status: "unanswered",
              judgment: null,
              valence: null,
              feedback: "",
            },
      C002: {
        status: "unanswered",
        judgment: null,
        valence: null,
        feedback: "",
      },
    },
  },
  progress: {
    total: 2,
    completed,
    correct: completed,
    incorrect: 0,
    unsure: 0,
    unanswered: 2 - completed,
  },
  finalized: false,
});
