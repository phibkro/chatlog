import { expect, test } from "bun:test";
import { Story } from "foldkit";

import { memoryLabFixture } from "./fixture";
import {
  ChangedReviewer,
  ChangedFeedback,
  ConfirmedFinalize,
  FinalizeLab,
  FocusScenario,
  FocusedScenario,
  LoadedMemoryLab,
  LoadMemoryLab,
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
