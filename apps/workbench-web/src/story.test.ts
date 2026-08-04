import { expect, test } from "bun:test";
import { Story } from "foldkit";

import { finalizedMemoryLabFixture, memoryLabFixture } from "./fixture";
import {
  AppliedApplication,
  ApplyMemoryApplication,
  ChangedMemoryText,
  ChangedProjectIdentity,
  ChangedReviewer,
  ChangedFeedback,
  ConfirmedFinalize,
  FinalizeLab,
  FocusScenario,
  FocusedScenario,
  LoadedMemoryLab,
  LoadMemoryLab,
  PreviewedApplication,
  PreviewMemoryApplication,
  RequestedApplicationApply,
  RequestedApplicationPreview,
  RequestedApplicationRemoval,
  RequestedFinalize,
  RequestedNext,
  RequestedSave,
  SaveDraft,
  SavedDraft,
  SelectedJudgment,
  SelectedValence,
  FinalizedMemoryLab,
  init,
  update,
} from "./main";

const correctedMemory =
  "Verify the unusual tool boundary before continuing with the operator's task.";
const applicationRequest = {
  packetHash: "fixture-packet",
  proposalSetHash: "fixture-proposal-set-hash",
  candidateAlias: "C001",
  reviewerId: "operator",
  projectIdentity: "chatlog",
  correctedProposition: correctedMemory,
  transitionCommand: null,
} as const;

const applicationPreview = (
  command: "accept-with-correction" | "retire",
  currentStatus: "none" | "active",
  recordedAt: string,
  priorLedgerHash: string | null,
) => ({
  command: {
    command,
    insightId: "fixture-insight",
    revision: {
      revisionId: command === "retire" ? "fixture-retired-revision" : "fixture-active-revision",
      proposition: correctedMemory,
      procedure: null,
      scope: {
        user: null,
        organization: null,
        project: "chatlog",
        repository: null,
        path: null,
        harness: null,
        model: null,
        tool: null,
        domain: "project",
      },
      supportEvidence: ["event://fixture-evidence"],
      status: command === "retire" ? ("retired" as const) : ("active" as const),
    },
    priorLedgerHash,
    recordedAt,
  },
  commandHash: `${command}-command-hash`,
  changedStartupContext: true,
  currentStatus,
});

const applicationResult = (
  preview: ReturnType<typeof applicationPreview>,
  transitionId: string,
  ledgerHash: string,
) => ({
  preview,
  applied: {
    transition: {
      transitionId,
      command: preview.command.command,
      revision: { status: preview.command.revision.status },
    },
    ledger: { ledgerHash },
  },
});

const readyApplicationModel = () => {
  let model = init()[0];
  model = update(model, LoadedMemoryLab({ lab: finalizedMemoryLabFixture() }))[0];
  model = update(model, ChangedProjectIdentity({ value: "chatlog" }))[0];
  model = update(model, ChangedMemoryText({ value: correctedMemory }))[0];
  return model;
};

const activeApplicationModel = () => {
  const preview = applicationPreview(
    "accept-with-correction",
    "none",
    "2026-08-04T12:00:00.000Z",
    "ledger-before",
  );
  let model = update(readyApplicationModel(), RequestedApplicationPreview())[0];
  model = update(model, PreviewedApplication({ request: applicationRequest, preview }))[0];
  const applyRequest = {
    ...applicationRequest,
    priorLedgerHash: preview.command.priorLedgerHash,
    previewCommandHash: preview.commandHash,
    recordedAt: preview.command.recordedAt,
  };
  model = update(model, RequestedApplicationApply())[0];
  return update(
    model,
    AppliedApplication({
      request: applyRequest,
      result: applicationResult(preview, "transition-active", "ledger-active"),
    }),
  )[0];
};

test("initialization declares one packet load command", () => {
  const [, commands] = init();
  expect(commands.map((command) => command.name)).toEqual([LoadMemoryLab.name]);
});

test("saving requires simple choices but no written explanation", () => {
  const initial = init()[0];
  const fixture = memoryLabFixture();

  Story.story(
    update,
    Story.with(initial),
    Story.message(LoadedMemoryLab({ lab: fixture })),
    Story.message(ChangedReviewer({ value: "operator" })),
    Story.message(SelectedJudgment({ value: "correct" })),
    Story.message(RequestedSave()),
    Story.Command.expectNone(),
    Story.model((model) => {
      expect(model.save).toMatchObject({ _tag: "SaveFailed" });
    }),
    Story.message(SelectedValence({ value: "positive" })),
    Story.message(RequestedSave()),
    Story.Command.expectHas(SaveDraft),
    Story.Command.resolve(SaveDraft, SavedDraft({ lab: memoryLabFixture(1) })),
    Story.Command.expectHas(FocusScenario),
    Story.Command.resolve(FocusScenario, FocusedScenario()),
  );
});

test("simple choices persist without inventing expert adjudication fields", () => {
  let model = init()[0];
  model = update(model, LoadedMemoryLab({ lab: memoryLabFixture() }))[0];
  model = update(model, ChangedReviewer({ value: "operator" }))[0];
  model = update(model, SelectedJudgment({ value: "incorrect" }))[0];
  model = update(model, SelectedValence({ value: "negative" }))[0];

  const [, commands] = update(model, RequestedSave());
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    name: SaveDraft.name,
    args: {
      packetHash: "fixture-packet",
      proposalSetHash: "fixture-proposal-set-hash",
      candidateAlias: "C001",
      reviewerId: "operator",
      review: {
        status: "reviewed",
        judgment: "incorrect",
        valence: "negative",
        feedback: "",
      },
    },
  });
});

test("unsure saves without an outcome or written explanation", () => {
  let model = init()[0];
  model = update(model, LoadedMemoryLab({ lab: memoryLabFixture() }))[0];
  model = update(model, ChangedReviewer({ value: "operator" }))[0];
  model = update(model, SelectedJudgment({ value: "unsure" }))[0];

  const [, commands] = update(model, RequestedSave());
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    name: SaveDraft.name,
    args: {
      proposalSetHash: "fixture-proposal-set-hash",
      reviewerId: "operator",
      review: {
        status: "reviewed",
        judgment: "unsure",
        valence: null,
        feedback: "",
      },
    },
  });
});

test("optional feedback survives changing the judgment", () => {
  let model = init()[0];
  model = update(model, LoadedMemoryLab({ lab: memoryLabFixture() }))[0];
  model = update(model, SelectedJudgment({ value: "incorrect" }))[0];
  model = update(model, ChangedFeedback({ value: "The useful lesson is narrower." }))[0];
  model = update(model, SelectedJudgment({ value: "correct" }))[0];

  expect(model.form.feedback).toBe("The useful lesson is narrower.");
});

test("finalization is a separate confirmable action", () => {
  const initial = init()[0];
  const complete = {
    ...memoryLabFixture(1),
    progress: {
      total: 2,
      completed: 2,
      correct: 1,
      incorrect: 0,
      unsure: 1,
      unanswered: 0,
    },
    reviews: {
      ...memoryLabFixture(1).reviews,
      reviews: {
        ...memoryLabFixture(1).reviews.reviews,
        C002: {
          status: "reviewed" as const,
          judgment: "unsure" as const,
          valence: null,
          feedback: "",
        },
      },
    },
  };

  Story.story(
    update,
    Story.with(initial),
    Story.message(LoadedMemoryLab({ lab: complete })),
    Story.message(RequestedFinalize()),
    Story.model((model) => {
      expect(model.confirmingFinalize).toBe(true);
    }),
    Story.Command.expectNone(),
    Story.message(ConfirmedFinalize()),
    Story.Command.expectHas(FinalizeLab),
    Story.Command.resolve(
      FinalizeLab,
      FinalizedMemoryLab({ lab: { ...complete, finalized: true } }),
    ),
  );
});

test("unsaved visible edits block navigation and finalization", () => {
  const initial = init()[0];
  const complete = {
    ...memoryLabFixture(1),
    progress: {
      total: 2,
      completed: 2,
      correct: 1,
      incorrect: 0,
      unsure: 1,
      unanswered: 0,
    },
    reviews: {
      ...memoryLabFixture(1).reviews,
      reviews: {
        ...memoryLabFixture(1).reviews.reviews,
        C002: {
          status: "reviewed" as const,
          judgment: "unsure" as const,
          valence: null,
          feedback: "",
        },
      },
    },
  };

  Story.story(
    update,
    Story.with(initial),
    Story.message(LoadedMemoryLab({ lab: complete })),
    Story.message(ChangedFeedback({ value: "An unsaved correction." })),
    Story.message(RequestedNext()),
    Story.model((model) => {
      expect(model.candidateIndex).toBe(0);
      expect(model.isDirty).toBe(true);
    }),
    Story.message(RequestedFinalize()),
    Story.model((model) => {
      expect(model.confirmingFinalize).toBe(false);
      expect(model.save).toMatchObject({
        _tag: "SaveFailed",
        error: "Save the visible answer before finishing the review.",
      });
    }),
    Story.Command.expectNone(),
  );
});

test("memory application preview binds the blinded candidate and corrected text", () => {
  const [, commands] = update(readyApplicationModel(), RequestedApplicationPreview());

  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    name: PreviewMemoryApplication.name,
    args: {
      packetHash: "fixture-packet",
      proposalSetHash: "fixture-proposal-set-hash",
      candidateAlias: "C001",
      reviewerId: "operator",
      projectIdentity: "chatlog",
      correctedProposition: correctedMemory,
    },
  });
});

test("memory application cannot apply before a successful preview", () => {
  const [, commands] = update(readyApplicationModel(), RequestedApplicationApply());
  expect(commands).toHaveLength(0);
});

test("editing memory text invalidates the application preview", () => {
  const preview = applicationPreview(
    "accept-with-correction",
    "none",
    "2026-08-04T12:00:00.000Z",
    "ledger-before",
  );
  let model = update(readyApplicationModel(), RequestedApplicationPreview())[0];
  model = update(model, PreviewedApplication({ request: applicationRequest, preview }))[0];
  expect(model.applications.C001?.request._tag).toBe("ApplicationPreviewReady");

  model = update(model, ChangedMemoryText({ value: `${correctedMemory} Narrowly.` }))[0];
  expect(model.applications.C001?.request._tag).toBe("ApplicationIdle");
  const [, commands] = update(model, RequestedApplicationApply());
  expect(commands).toHaveLength(0);
});

test("successful memory application exposes active durable state", () => {
  const preview = applicationPreview(
    "accept-with-correction",
    "none",
    "2026-08-04T12:00:00.000Z",
    "ledger-before",
  );
  let model = update(readyApplicationModel(), RequestedApplicationPreview())[0];
  model = update(model, PreviewedApplication({ request: applicationRequest, preview }))[0];

  const [pending, commands] = update(model, RequestedApplicationApply());
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    name: ApplyMemoryApplication.name,
    args: {
      candidateAlias: "C001",
      correctedProposition: correctedMemory,
      priorLedgerHash: "ledger-before",
      previewCommandHash: preview.commandHash,
      recordedAt: "2026-08-04T12:00:00.000Z",
    },
  });

  const applyRequest = {
    ...applicationRequest,
    priorLedgerHash: preview.command.priorLedgerHash,
    previewCommandHash: preview.commandHash,
    recordedAt: preview.command.recordedAt,
  };
  model = update(
    pending,
    AppliedApplication({
      request: applyRequest,
      result: applicationResult(preview, "transition-active", "ledger-active"),
    }),
  )[0];
  expect(model.applications.C001?.durable).toEqual({
    status: "active",
    transitionId: "transition-active",
    ledgerHash: "ledger-active",
    command: "accept-with-correction",
    projectIdentity: "chatlog",
  });
});

test("loading the Memory Lab rehydrates an active application for removal", () => {
  const base = finalizedMemoryLabFixture();
  const lab = {
    ...base,
    applications: {
      C001: {
        status: "active" as const,
        transitionId: "transition-active",
        ledgerHash: "ledger-active",
        command: "accept-with-correction" as const,
        projectIdentity: "chatlog",
      },
    },
  };
  const model = update(init()[0], LoadedMemoryLab({ lab }))[0];
  const [pending, commands] = update(model, RequestedApplicationRemoval());
  expect(pending.applications.C001?.request._tag).toBe("ApplicationPreviewPending");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    name: PreviewMemoryApplication.name,
    args: { candidateAlias: "C001", projectIdentity: "chatlog", transitionCommand: "retire" },
  });
});

test("removing memory previews and applies an explicit retirement", () => {
  let model = activeApplicationModel();
  const [previewPending, previewCommands] = update(model, RequestedApplicationRemoval());
  expect(previewCommands).toHaveLength(1);
  expect(previewCommands[0]).toMatchObject({
    name: PreviewMemoryApplication.name,
    args: {
      candidateAlias: "C001",
      correctedProposition: correctedMemory,
      transitionCommand: "retire",
    },
  });

  const retireRequest = { ...applicationRequest, transitionCommand: "retire" as const };
  const retirePreview = applicationPreview(
    "retire",
    "active",
    "2026-08-04T12:05:00.000Z",
    "ledger-active",
  );
  model = update(
    previewPending,
    PreviewedApplication({ request: retireRequest, preview: retirePreview }),
  )[0];

  const [applyPending, applyCommands] = update(model, RequestedApplicationApply());
  expect(applyCommands).toHaveLength(1);
  expect(applyCommands[0]).toMatchObject({
    name: ApplyMemoryApplication.name,
    args: {
      candidateAlias: "C001",
      transitionCommand: "retire",
      priorLedgerHash: "ledger-active",
      previewCommandHash: retirePreview.commandHash,
      recordedAt: "2026-08-04T12:05:00.000Z",
    },
  });

  const retireApplyRequest = {
    ...retireRequest,
    priorLedgerHash: retirePreview.command.priorLedgerHash,
    previewCommandHash: retirePreview.commandHash,
    recordedAt: retirePreview.command.recordedAt,
  };
  model = update(
    applyPending,
    AppliedApplication({
      request: retireApplyRequest,
      result: applicationResult(retirePreview, "transition-retired", "ledger-retired"),
    }),
  )[0];
  expect(model.applications.C001?.durable).toMatchObject({
    status: "retired",
    transitionId: "transition-retired",
    ledgerHash: "ledger-retired",
  });
});
