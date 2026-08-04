import { Effect, Option, Schema as S, Stream } from "effect";
import { Command, Runtime, Subscription } from "foldkit";
import { type Document, type Html, html } from "foldkit/html";
import { m } from "foldkit/message";
import { ts } from "foldkit/schema";

import { Button, Input, RadioGroup, Textarea } from "@foldkit/ui";

const Judgment = S.Literals(["correct", "incorrect", "unsure"]);
type Judgment = typeof Judgment.Type;
const Valence = S.Literals(["positive", "negative", "neutral"]);
type Valence = typeof Valence.Type;

const Evidence = S.Struct({
  evidenceId: S.String,
  sessionAlias: S.String,
  projectAlias: S.String,
  harnessAlias: S.String,
  snippet: S.String,
});
type Evidence = typeof Evidence.Type;

const Candidate = S.Struct({
  candidateAlias: S.String,
  signatureTheme: S.String,
  evidence: S.Array(Evidence),
});
type Candidate = typeof Candidate.Type;

const Proposal = S.Struct({
  lesson: S.String,
  suggestedValence: Valence,
  rationale: S.String,
});
type Proposal = typeof Proposal.Type;

const ProposalSet = S.Struct({
  schemaVersion: S.Literal(1),
  packetHash: S.String,
  generator: S.Struct({
    provider: S.String,
    model: S.String,
    effort: S.String,
    recipe: S.String,
  }),
  proposals: S.Record(S.String, Proposal),
});

const UnansweredReview = S.Struct({
  status: S.Literal("unanswered"),
  judgment: S.Null,
  valence: S.Null,
  feedback: S.String,
});
const CompletedReview = S.Struct({
  status: S.Literal("reviewed"),
  judgment: Judgment,
  valence: S.NullOr(Valence),
  feedback: S.String,
});
const OperatorReview = S.Union([UnansweredReview, CompletedReview]);
type OperatorReview = typeof OperatorReview.Type;

const MemoryLabView = S.Struct({
  packet: S.Struct({
    packetHash: S.String,
    candidates: S.Array(Candidate),
  }),
  proposalSet: ProposalSet,
  proposalSetHash: S.String,
  reviews: S.Struct({
    schemaVersion: S.Literal(1),
    packetHash: S.String,
    proposalSetHash: S.String,
    reviewer: S.Struct({ id: S.String }),
    reviews: S.Record(S.String, OperatorReview),
  }),
  progress: S.Struct({
    total: S.Number,
    completed: S.Number,
    correct: S.Number,
    incorrect: S.Number,
    unsure: S.Number,
    unanswered: S.Number,
  }),
  finalized: S.Boolean,
});
export type MemoryLabView = typeof MemoryLabView.Type;

export const ReviewLoading = ts("ReviewLoading");
export const ReviewFailed = ts("ReviewFailed", { error: S.String });
export const ReviewReady = ts("ReviewReady", { lab: MemoryLabView });
const ReviewState = S.Union([ReviewLoading, ReviewFailed, ReviewReady]);

export const SaveIdle = ts("SaveIdle");
export const SavePending = ts("SavePending");
export const SaveSucceeded = ts("SaveSucceeded", { message: S.String });
export const SaveFailed = ts("SaveFailed", { error: S.String });
const SaveState = S.Union([SaveIdle, SavePending, SaveSucceeded, SaveFailed]);

const FormState = S.Struct({
  reviewerId: S.String,
  judgment: S.NullOr(Judgment),
  valence: S.NullOr(Valence),
  feedback: S.String,
});
type FormState = typeof FormState.Type;

export const Model = S.Struct({
  review: ReviewState,
  candidateIndex: S.Number,
  form: FormState,
  isDirty: S.Boolean,
  save: SaveState,
  confirmingFinalize: S.Boolean,
});
export type Model = typeof Model.Type;

export const LoadedMemoryLab = m("LoadedMemoryLab", { lab: MemoryLabView });
export const FailedMemoryLab = m("FailedMemoryLab", { error: S.String });
export const ChangedReviewer = m("ChangedReviewer", { value: S.String });
export const SelectedJudgment = m("SelectedJudgment", { value: Judgment });
export const SelectedValence = m("SelectedValence", { value: Valence });
export const ChangedFeedback = m("ChangedFeedback", { value: S.String });
export const RequestedPrevious = m("RequestedPrevious");
export const RequestedNext = m("RequestedNext");
export const RequestedSave = m("RequestedSave");
export const SavedDraft = m("SavedDraft", { lab: MemoryLabView });
export const FailedSave = m("FailedSave", { error: S.String });
export const RequestedFinalize = m("RequestedFinalize");
export const CancelledFinalize = m("CancelledFinalize");
export const ConfirmedFinalize = m("ConfirmedFinalize");
export const FinalizedMemoryLab = m("FinalizedMemoryLab", { lab: MemoryLabView });
export const FailedFinalize = m("FailedFinalize", { error: S.String });
export const FocusedScenario = m("FocusedScenario");
export const AttemptedUnload = m("AttemptedUnload");

export const Message = S.Union([
  LoadedMemoryLab,
  FailedMemoryLab,
  ChangedReviewer,
  SelectedJudgment,
  SelectedValence,
  ChangedFeedback,
  RequestedPrevious,
  RequestedNext,
  RequestedSave,
  SavedDraft,
  FailedSave,
  RequestedFinalize,
  CancelledFinalize,
  ConfirmedFinalize,
  FinalizedMemoryLab,
  FailedFinalize,
  FocusedScenario,
  AttemptedUnload,
]);
export type Message = typeof Message.Type;

const emptyForm = (): FormState => ({
  reviewerId: "",
  judgment: null,
  valence: null,
  feedback: "",
});

const reviewAt = (lab: MemoryLabView, index: number): OperatorReview => {
  const alias = lab.packet.candidates[index]?.candidateAlias;
  return alias === undefined
    ? UnansweredReview.make({
        status: "unanswered",
        judgment: null,
        valence: null,
        feedback: "",
      })
    : (lab.reviews.reviews[alias] ??
        UnansweredReview.make({
          status: "unanswered",
          judgment: null,
          valence: null,
          feedback: "",
        }));
};

const formAt = (lab: MemoryLabView, index: number, reviewerId?: string): FormState => {
  const review = reviewAt(lab, index);
  return {
    reviewerId: reviewerId ?? lab.reviews.reviewer.id,
    judgment: review.judgment,
    valence: review.valence,
    feedback: review.feedback,
  };
};

const responseError = async (response: Response, fallback: string): Promise<never> => {
  const body: unknown = await response.json().catch(() => undefined);
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : fallback;
  return Promise.reject(new Error(message));
};

const fetchLab = (): Effect.Effect<MemoryLabView, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("/api/memory-lab", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return responseError(response, "Memory Lab could not be loaded");
      return S.decodeUnknownPromise(MemoryLabView)(await response.json());
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("Memory Lab request failed")),
  });

export const LoadMemoryLab = Command.define(
  "LoadMemoryLab",
  LoadedMemoryLab,
  FailedMemoryLab,
)(
  fetchLab().pipe(
    Effect.map((lab) => LoadedMemoryLab({ lab })),
    Effect.catch((error) => Effect.succeed(FailedMemoryLab({ error: error.message }))),
  ),
);

export const SaveDraft = Command.define(
  "SaveDraft",
  {
    packetHash: S.String,
    proposalSetHash: S.String,
    candidateAlias: S.String,
    reviewerId: S.String,
    review: OperatorReview,
  },
  SavedDraft,
  FailedSave,
)((payload) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("/api/memory-lab/draft", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return responseError(response, "The label could not be saved");
      return S.decodeUnknownPromise(MemoryLabView)(await response.json());
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("The label could not be saved")),
  }).pipe(
    Effect.map((lab) => SavedDraft({ lab })),
    Effect.catch((error) => Effect.succeed(FailedSave({ error: error.message }))),
  ),
);

export const FinalizeLab = Command.define(
  "FinalizeLab",
  { packetHash: S.String, proposalSetHash: S.String, reviewerId: S.String },
  FinalizedMemoryLab,
  FailedFinalize,
)((payload) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch("/api/memory-lab/finalize", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) return responseError(response, "The review could not be finalized");
      return S.decodeUnknownPromise(MemoryLabView)(await response.json());
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("The review could not be finalized"),
  }).pipe(
    Effect.map((lab) => FinalizedMemoryLab({ lab })),
    Effect.catch((error) => Effect.succeed(FailedFinalize({ error: error.message }))),
  ),
);

export const FocusScenario = Command.define(
  "FocusScenario",
  FocusedScenario,
)(
  Effect.sync(() => {
    const heading = document.getElementById("scenario-heading");
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
    return FocusedScenario();
  }),
);

export const init: Runtime.ApplicationInit<Model, Message> = () => [
  {
    review: ReviewLoading(),
    candidateIndex: 0,
    form: emptyForm(),
    isDirty: false,
    save: SaveIdle(),
    confirmingFinalize: false,
  },
  [LoadMemoryLab()],
];

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  protectUnsavedChanges: entry(
    { isDirty: S.Boolean },
    {
      modelToDependencies: (model) => ({ isDirty: model.isDirty }),
      dependenciesToStream: ({ isDirty }) =>
        Stream.when(
          Subscription.fromEvent<BeforeUnloadEvent, Message>({
            target: window,
            type: "beforeunload",
            toMessage: (event) => {
              event.preventDefault();
              event.returnValue = "";
              return AttemptedUnload();
            },
          }),
          Effect.sync(() => isDirty),
        ),
    },
  ),
}));

type UpdateReturn = readonly [Model, ReadonlyArray<Command.Command<Message, never>>];

const readyLab = (model: Model): MemoryLabView | null =>
  model.review._tag === "ReviewReady" ? model.review.lab : null;

const candidateCount = (model: Model): number => readyLab(model)?.packet.candidates.length ?? 0;

const atIndex = (model: Model, index: number): Model => {
  const lab = readyLab(model);
  if (lab === null) return model;
  const bounded = Math.max(0, Math.min(index, lab.packet.candidates.length - 1));
  return {
    ...model,
    candidateIndex: bounded,
    form: formAt(lab, bounded, model.form.reviewerId),
    isDirty: false,
    save: SaveIdle(),
    confirmingFinalize: false,
  };
};

const reviewFromForm = (
  form: FormState,
): { ok: true; review: OperatorReview } | { ok: false; error: string } => {
  const reviewerId = form.reviewerId.trim();
  if (reviewerId.length === 0) return { ok: false, error: "Enter your name before saving." };
  if (form.judgment === null)
    return { ok: false, error: "Decide whether the AI proposal is correct." };
  if (form.judgment !== "unsure" && form.valence === null)
    return { ok: false, error: "Choose whether the lesson is positive, negative, or neutral." };
  const feedback = form.feedback.trim();
  if (feedback.length > 1500) return { ok: false, error: "Optional feedback must be shorter." };
  return {
    ok: true,
    review: CompletedReview.make({
      status: "reviewed",
      judgment: form.judgment,
      valence: form.judgment === "unsure" ? null : form.valence,
      feedback,
    }),
  };
};

export const update = (model: Model, message: Message): UpdateReturn => {
  switch (message._tag) {
    case "LoadedMemoryLab": {
      const firstUnreviewed = message.lab.packet.candidates.findIndex(
        (candidate) =>
          message.lab.reviews.reviews[candidate.candidateAlias]?.status === "unanswered",
      );
      const candidateIndex = Math.max(0, firstUnreviewed);
      return [
        {
          ...model,
          review: ReviewReady({ lab: message.lab }),
          candidateIndex,
          form: formAt(message.lab, candidateIndex),
          isDirty: false,
          save: SaveIdle(),
        },
        [],
      ];
    }
    case "FailedMemoryLab":
      return [{ ...model, review: ReviewFailed({ error: message.error }) }, []];
    case "ChangedReviewer":
      return [
        {
          ...model,
          form: { ...model.form, reviewerId: message.value },
          isDirty: true,
          save: SaveIdle(),
        },
        [],
      ];
    case "SelectedJudgment":
      return [
        {
          ...model,
          form: {
            ...model.form,
            judgment: message.value,
            valence: message.value === "unsure" ? null : model.form.valence,
          },
          isDirty: true,
          save: SaveIdle(),
        },
        [],
      ];
    case "SelectedValence":
      return [
        {
          ...model,
          form: { ...model.form, valence: message.value },
          isDirty: true,
          save: SaveIdle(),
        },
        [],
      ];
    case "ChangedFeedback":
      return [
        {
          ...model,
          form: { ...model.form, feedback: message.value },
          isDirty: true,
          save: SaveIdle(),
        },
        [],
      ];
    case "RequestedPrevious":
      return [model.isDirty ? model : atIndex(model, model.candidateIndex - 1), []];
    case "RequestedNext":
      return [model.isDirty ? model : atIndex(model, model.candidateIndex + 1), []];
    case "RequestedSave": {
      const lab = readyLab(model);
      const candidate = lab?.packet.candidates[model.candidateIndex];
      if (lab === null || lab.finalized || candidate === undefined) return [model, []];
      const result = reviewFromForm(model.form);
      if (!result.ok) return [{ ...model, save: SaveFailed({ error: result.error }) }, []];
      return [
        { ...model, save: SavePending() },
        [
          SaveDraft({
            packetHash: lab.packet.packetHash,
            proposalSetHash: lab.proposalSetHash,
            candidateAlias: candidate.candidateAlias,
            reviewerId: model.form.reviewerId.trim(),
            review: result.review,
          }),
        ],
      ];
    }
    case "SavedDraft": {
      const nextUnreviewed = message.lab.packet.candidates.findIndex(
        (candidate, index) =>
          index > model.candidateIndex &&
          message.lab.reviews.reviews[candidate.candidateAlias]?.status === "unanswered",
      );
      const candidateIndex = nextUnreviewed >= 0 ? nextUnreviewed : model.candidateIndex;
      return [
        {
          ...model,
          review: ReviewReady({ lab: message.lab }),
          candidateIndex,
          form: formAt(message.lab, candidateIndex, model.form.reviewerId.trim()),
          isDirty: false,
          save: SaveSucceeded({ message: "Label saved locally." }),
        },
        [FocusScenario()],
      ];
    }
    case "FailedSave":
      return [{ ...model, save: SaveFailed({ error: message.error }) }, []];
    case "RequestedFinalize":
      if (model.isDirty)
        return [
          {
            ...model,
            save: SaveFailed({ error: "Save the visible answer before finishing the review." }),
          },
          [],
        ];
      return [{ ...model, confirmingFinalize: true, save: SaveIdle() }, []];
    case "CancelledFinalize":
      return [{ ...model, confirmingFinalize: false }, []];
    case "ConfirmedFinalize": {
      const lab = readyLab(model);
      if (
        lab === null ||
        lab.finalized ||
        model.isDirty ||
        lab.progress.completed !== lab.progress.total ||
        model.form.reviewerId.trim().length === 0
      )
        return [model, []];
      return [
        { ...model, confirmingFinalize: false, save: SavePending() },
        [
          FinalizeLab({
            packetHash: lab.packet.packetHash,
            proposalSetHash: lab.proposalSetHash,
            reviewerId: model.form.reviewerId.trim(),
          }),
        ],
      ];
    }
    case "FinalizedMemoryLab":
      return [
        {
          ...model,
          review: ReviewReady({ lab: message.lab }),
          form: formAt(message.lab, model.candidateIndex),
          isDirty: false,
          save: SaveSucceeded({ message: "Review finalized. No memory was promoted or injected." }),
          confirmingFinalize: false,
        },
        [],
      ];
    case "FailedFinalize":
      return [
        { ...model, save: SaveFailed({ error: message.error }), confirmingFinalize: false },
        [],
      ];
    case "FocusedScenario":
    case "AttemptedUnload":
      return [model, []];
  }
};

const surface =
  "rounded-2xl border border-line bg-surface-container-low/90 shadow-[0_18px_60px_rgb(0_0_0/0.18)]";
const focus =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const primaryButton = `min-h-11 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-on-primary transition hover:brightness-110 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 ${focus}`;
const secondaryButton = `min-h-11 rounded-xl border border-line bg-surface-container px-4 py-2.5 text-sm font-semibold text-primary transition hover:border-primary/50 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 ${focus}`;

const button = (label: string, onClick: Message, style: string, isDisabled = false): Html => {
  const h = html<Message>();
  return Button.view<Message>({
    onClick,
    isDisabled,
    toView: ({ button: attributes }) => h.button([...attributes, h.Class(style)], [label]),
  });
};

const evidenceView = (evidence: Evidence): Html => {
  const h = html<Message>();
  return h.keyed("li")(
    evidence.evidenceId,
    [
      h.Class(
        "list-none rounded-xl border border-line bg-surface-container p-4 text-on-surface-variant",
      ),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-2")],
        [
          h.strong([h.Class("text-xs font-bold text-primary")], [evidence.evidenceId]),
          h.span(
            [h.Class("text-[0.68rem] text-muted")],
            [`${evidence.sessionAlias} · ${evidence.projectAlias} · ${evidence.harnessAlias}`],
          ),
        ],
      ),
      h.p(
        [h.Class("mt-2 whitespace-pre-wrap text-sm leading-6 text-on-surface")],
        [evidence.snippet],
      ),
    ],
  );
};

const radioChoice = <Value extends string>(
  id: string,
  label: string,
  values: ReadonlyArray<Value>,
  labels: Readonly<Record<Value, string>>,
  selected: Value | null,
  onSelect: (value: Value) => Message,
  disabled = false,
): Html => {
  const h = html<Message>();
  return h.fieldset(
    [h.Class("min-w-0")],
    [
      h.legend([h.Class("text-sm font-bold text-on-surface")], [label]),
      RadioGroup.view<Value, Message>({
        id,
        selectedValue: Option.fromNullOr(selected),
        options: values,
        ariaLabel: label,
        onSelect,
        isDisabled: disabled,
        toView: ({ group, options }) =>
          h.div(
            [...group, h.Class("mt-2 grid grid-cols-2 gap-2")],
            options.map((option) =>
              h.keyed("div")(
                option.value,
                [
                  ...option.option,
                  h.Class(
                    `grid min-h-11 cursor-pointer place-items-center rounded-xl border border-line bg-surface-container px-3 py-2 text-center text-xs font-semibold text-muted transition data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-on-primary data-[checked]:shadow-md data-[checked]:ring-2 data-[checked]:ring-primary/35 data-[disabled]:cursor-default data-[disabled]:opacity-45 ${focus}`,
                  ),
                ],
                [labels[option.value]],
              ),
            ),
          ),
      }),
    ],
  );
};

const statusView = (model: Model): Html => {
  const h = html<Message>();
  if (model.save._tag === "SaveIdle") return h.p([h.Class("min-h-5 text-xs text-muted")], [""]);
  if (model.save._tag === "SavePending")
    return h.p([h.Class("min-h-5 text-xs text-muted")], ["Saving…"]);
  if (model.save._tag === "SaveFailed")
    return h.p(
      [h.Class("min-h-5 text-xs font-semibold text-error"), h.Attribute("role", "alert")],
      [model.save.error],
    );
  return h.p(
    [h.Class("min-h-5 text-xs font-semibold text-valid"), h.Attribute("role", "status")],
    [model.save.message],
  );
};

const readyView = (model: Model, lab: MemoryLabView): Document => {
  const h = html<Message>();
  const candidate = lab.packet.candidates[model.candidateIndex];
  if (candidate === undefined)
    return {
      title: "Memory Lab · Chatlog",
      body: h.main([h.Class("p-6 text-on-surface")], ["The packet has no candidates."]),
    };
  const proposal = lab.proposalSet.proposals[candidate.candidateAlias];
  if (proposal === undefined)
    return {
      title: "Memory Lab unavailable · Chatlog",
      body: h.main([h.Class("p-6 text-on-surface")], ["The AI proposal is missing."]),
    };
  const review = reviewAt(lab, model.candidateIndex);
  const progress = lab.progress;
  const percentage = progress.total === 0 ? 0 : (progress.completed / progress.total) * 100;
  const busy = model.save._tag === "SavePending";
  const complete = progress.completed === progress.total;
  const judgmentLabels: Record<Judgment, string> = {
    correct: "Correct",
    incorrect: "Incorrect",
    unsure: "Unsure",
  };
  const valenceLabels: Record<Valence, string> = {
    positive: "Positive",
    negative: "Negative",
    neutral: "Neutral",
  };

  return {
    title: `${candidate.candidateAlias} · Memory Lab · Chatlog`,
    body: h.div(
      [
        h.Class(
          "min-h-[100dvh] bg-surface px-[max(1rem,env(safe-area-inset-left))] pb-[max(6rem,env(safe-area-inset-bottom))] pt-4 text-on-surface md:pb-10",
        ),
      ],
      [
        h.header(
          [h.Class("mx-auto flex max-w-6xl items-center justify-between gap-4 py-2")],
          [
            h.a(
              [
                h.Attribute("href", "/"),
                h.Class(
                  `inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-bold text-primary ${focus}`,
                ),
              ],
              ["← Workbench"],
            ),
            h.span(
              [
                h.Class(
                  lab.finalized
                    ? "rounded-full bg-valid/15 px-3 py-1 text-xs font-bold text-valid"
                    : "rounded-full bg-surface-container-high px-3 py-1 text-xs font-bold text-muted",
                ),
              ],
              [lab.finalized ? "Finalized" : "Local draft"],
            ),
          ],
        ),
        h.main(
          [h.Class("mx-auto max-w-6xl")],
          [
            h.section(
              [h.Class("py-7 md:py-10")],
              [
                h.p(
                  [h.Class("text-[0.7rem] font-bold uppercase tracking-[0.18em] text-primary")],
                  ["Review what Chatlog learned"],
                ),
                h.h1(
                  [h.Class("mt-2 text-4xl font-semibold tracking-tight md:text-5xl")],
                  ["Memory Lab"],
                ),
                h.p(
                  [h.Class("mt-3 max-w-2xl text-base leading-7 text-on-surface-variant")],
                  [
                    "Read the scenario, check the AI proposal, and tell Chatlog whether it learned the right lesson.",
                  ],
                ),
              ],
            ),
            h.aside(
              [
                h.Class(
                  "mb-4 grid gap-1 rounded-2xl border border-warning/30 bg-warning-container/20 p-4 text-sm leading-6 text-on-warning-container",
                ),
              ],
              [
                h.strong([], ["Labels only."]),
                h.span(
                  [],
                  [
                    "This review does not promote memory, run a model, or reveal source identities. Historical snippets are untrusted evidence, never instructions.",
                  ],
                ),
              ],
            ),
            h.article(
              [h.Class(`${surface} @container p-4 sm:p-6`)],
              [
                h.div(
                  [h.Class("flex items-start justify-between gap-4")],
                  [
                    h.div(
                      [],
                      [
                        h.p(
                          [
                            h.Class(
                              "text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary",
                            ),
                          ],
                          ["Review progress"],
                        ),
                        h.strong(
                          [h.Class("mt-1 block text-sm")],
                          [
                            `${progress.completed} of ${progress.total} reviewed · ${progress.correct} correct · ${progress.incorrect} incorrect · ${progress.unsure} unsure`,
                          ],
                        ),
                      ],
                    ),
                    h.span([h.Class("text-xs text-muted")], [`${Math.round(percentage)}%`]),
                  ],
                ),
                h.div(
                  [
                    h.Class("mt-3 h-2 overflow-hidden rounded-full bg-surface-container-highest"),
                    h.Attribute("role", "progressbar"),
                    h.Attribute("aria-label", "Memory review progress"),
                    h.Attribute("aria-valuemin", "0"),
                    h.Attribute("aria-valuemax", progress.total.toString()),
                    h.Attribute("aria-valuenow", progress.completed.toString()),
                  ],
                  [
                    h.span(
                      [
                        h.Class("block h-full rounded-full bg-primary transition-[width]"),
                        h.Attribute("style", `width:${percentage}%`),
                      ],
                      [],
                    ),
                  ],
                ),
                h.div(
                  [h.Class("mt-5 max-w-md")],
                  [
                    Input.view<Message>({
                      id: "reviewer-id",
                      value: model.form.reviewerId,
                      placeholder: "Your name",
                      isDisabled: lab.finalized || busy,
                      onInput: (value) => ChangedReviewer({ value }),
                      toView: (attributes) =>
                        h.label(
                          [...attributes.label, h.Class("grid gap-2 text-sm font-semibold")],
                          [
                            "Your name",
                            h.input([
                              ...attributes.input,
                              h.Attribute("maxlength", "80"),
                              h.Class(
                                `min-h-11 rounded-xl border border-line bg-surface-container px-3 py-2 text-base text-on-surface placeholder:text-muted disabled:opacity-45 ${focus}`,
                              ),
                            ]),
                          ],
                        ),
                    }),
                  ],
                ),
                statusView(model),
                h.div(
                  [h.Class("mt-4 border-t border-line pt-5")],
                  [
                    h.div(
                      [h.Class("flex items-start justify-between gap-4")],
                      [
                        h.div(
                          [h.Class("min-w-0")],
                          [
                            h.p(
                              [
                                h.Class(
                                  "text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary",
                                ),
                              ],
                              [
                                `${candidate.candidateAlias} · ${model.candidateIndex + 1} of ${progress.total}`,
                              ],
                            ),
                            h.h2(
                              [
                                h.Attribute("id", "scenario-heading"),
                                h.Attribute("tabindex", "-1"),
                                h.Class(
                                  `mt-2 scroll-mt-4 text-2xl font-semibold leading-tight ${focus}`,
                                ),
                              ],
                              ["Review this proposed memory"],
                            ),
                          ],
                        ),
                        h.span(
                          [
                            h.Class(
                              "shrink-0 rounded-full bg-surface-container-high px-3 py-1 text-xs text-muted",
                            ),
                          ],
                          [review.status === "unanswered" ? "Not reviewed" : "Reviewed"],
                        ),
                      ],
                    ),
                    h.div(
                      [
                        h.Class(
                          "mt-6 grid gap-6 @min-[48rem]:grid-cols-[minmax(0,1.2fr)_minmax(17rem,0.8fr)]",
                        ),
                      ],
                      [
                        h.section(
                          [h.Class("min-w-0")],
                          [
                            h.h3([h.Class("text-sm font-bold")], ["Scenario"]),
                            h.p(
                              [h.Class("mt-1 text-xs leading-5 text-muted")],
                              [
                                "These blinded excerpts are the situation the AI reviewed. You do not need to classify the language.",
                              ],
                            ),
                            h.ul(
                              [h.Class("mt-3 grid gap-2 p-0")],
                              candidate.evidence.map(evidenceView),
                            ),
                          ],
                        ),
                        h.div(
                          [h.Class("grid content-start gap-5")],
                          [
                            h.section(
                              [
                                h.Class(
                                  "rounded-xl border border-primary/30 bg-primary-container/20 p-4",
                                ),
                              ],
                              [
                                h.p(
                                  [
                                    h.Class(
                                      "text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary",
                                    ),
                                  ],
                                  ["AI proposal"],
                                ),
                                h.blockquote(
                                  [h.Class("mt-2 text-base font-semibold leading-7")],
                                  [`“${proposal.lesson}”`],
                                ),
                                h.p(
                                  [h.Class("mt-3 text-xs leading-5 text-on-surface-variant")],
                                  [proposal.rationale],
                                ),
                                h.p(
                                  [h.Class("mt-3 text-xs font-bold capitalize text-primary")],
                                  [`Suggested outcome: ${proposal.suggestedValence}`],
                                ),
                              ],
                            ),
                            radioChoice(
                              "judgment",
                              "Is the AI proposal correct?",
                              ["correct", "incorrect", "unsure"],
                              judgmentLabels,
                              model.form.judgment,
                              (value) => SelectedJudgment({ value }),
                              lab.finalized || busy,
                            ),
                            radioChoice(
                              "valence",
                              "What was the outcome?",
                              ["positive", "negative", "neutral"],
                              valenceLabels,
                              model.form.valence,
                              (value) => SelectedValence({ value }),
                              lab.finalized || busy || model.form.judgment === "unsure",
                            ),
                            h.p(
                              [h.Class("-mt-3 text-xs leading-5 text-muted")],
                              [
                                model.form.judgment === "unsure"
                                  ? "Outcome is skipped when you are unsure."
                                  : "Positive: repeat it. Negative: avoid it. Neutral: useful context without a good or bad outcome.",
                              ],
                            ),
                            Textarea.view<Message>({
                              id: "feedback",
                              value: model.form.feedback,
                              rows: 5,
                              placeholder:
                                model.form.judgment === "incorrect"
                                  ? "Optionally say what the proposal should have been…"
                                  : model.form.judgment === "unsure"
                                    ? "Optionally say what context is missing…"
                                    : "Optional note…",
                              isDisabled: lab.finalized || busy,
                              onInput: (value) => ChangedFeedback({ value }),
                              toView: (attributes) =>
                                h.label(
                                  [...attributes.label, h.Class("grid gap-2 text-sm font-bold")],
                                  [
                                    model.form.judgment === "incorrect"
                                      ? "Correction or feedback (optional)"
                                      : model.form.judgment === "unsure"
                                        ? "Missing context (optional)"
                                        : "Note (optional)",
                                    h.textarea(
                                      [
                                        ...attributes.textarea,
                                        h.Attribute("maxlength", "1500"),
                                        h.Class(
                                          `min-h-28 resize-y rounded-xl border border-line bg-surface-container px-3 py-2 text-base font-normal leading-6 text-on-surface placeholder:text-muted disabled:opacity-45 ${focus}`,
                                        ),
                                      ],
                                      [],
                                    ),
                                  ],
                                ),
                            }),
                          ],
                        ),
                      ],
                    ),
                    h.div(
                      [
                        h.Class(
                          "mt-6 grid grid-cols-2 gap-2 border-t border-line pt-4 @min-[32rem]:grid-cols-[auto_auto_1fr]",
                        ),
                      ],
                      [
                        button(
                          "← Previous",
                          RequestedPrevious(),
                          secondaryButton,
                          model.candidateIndex === 0 || busy || model.isDirty,
                        ),
                        button(
                          "Next →",
                          RequestedNext(),
                          secondaryButton,
                          model.candidateIndex + 1 >= candidateCount(model) ||
                            busy ||
                            model.isDirty,
                        ),
                        button(
                          model.candidateIndex + 1 >= candidateCount(model)
                            ? "Save answer"
                            : "Save and next",
                          RequestedSave(),
                          `${primaryButton} col-span-2 @min-[32rem]:col-span-1 @min-[32rem]:justify-self-end`,
                          lab.finalized || busy,
                        ),
                      ],
                    ),
                  ],
                ),
                h.section(
                  [
                    h.Class(
                      "mt-6 grid gap-3 border-t border-line pt-5 @min-[32rem]:grid-cols-[1fr_auto] @min-[32rem]:items-center",
                    ),
                  ],
                  [
                    h.p(
                      [h.Class("text-xs leading-5 text-muted")],
                      [
                        "Finishing locks this review. It still does not approve or inject any memory.",
                      ],
                    ),
                    model.confirmingFinalize
                      ? h.div(
                          [
                            h.Class(
                              "col-span-full grid gap-3 rounded-xl border border-warning/30 bg-warning-container/20 p-4 @min-[32rem]:grid-cols-[1fr_auto_auto] @min-[32rem]:items-center",
                            ),
                            h.Attribute("role", "group"),
                            h.Attribute("aria-label", "Confirm final review"),
                            h.Attribute("aria-live", "polite"),
                          ],
                          [
                            h.p(
                              [h.Class("text-sm font-semibold")],
                              ["Lock these labels as the final review?"],
                            ),
                            button("Cancel", CancelledFinalize(), secondaryButton),
                            button("Lock review", ConfirmedFinalize(), primaryButton),
                          ],
                        )
                      : button(
                          lab.finalized ? "Review finalized" : "Finish review",
                          RequestedFinalize(),
                          secondaryButton,
                          lab.finalized || !complete || busy || model.isDirty,
                        ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ],
    ),
  };
};

export const view = (model: Model): Document => {
  const h = html<Message>();
  if (model.review._tag === "ReviewLoading")
    return {
      title: "Memory Lab · Chatlog",
      body: h.main(
        [h.Class("grid min-h-[100dvh] place-items-center bg-surface p-6 text-on-surface")],
        [
          h.p(
            [h.Class("text-sm text-muted"), h.Attribute("role", "status")],
            ["Loading blinded packet…"],
          ),
        ],
      ),
    };
  if (model.review._tag === "ReviewFailed")
    return {
      title: "Memory Lab unavailable · Chatlog",
      body: h.main(
        [h.Class("grid min-h-[100dvh] place-items-center bg-surface p-6 text-on-surface")],
        [
          h.section(
            [h.Class(`${surface} max-w-lg p-6`)],
            [
              h.h1([h.Class("text-2xl font-semibold")], ["Memory Lab is unavailable"]),
              h.p([h.Class("mt-3 text-sm leading-6 text-error")], [model.review.error]),
              h.a(
                [h.Attribute("href", "/"), h.Class(`mt-5 inline-flex ${secondaryButton}`)],
                ["Return to Workbench"],
              ),
            ],
          ),
        ],
      ),
    };
  return readyView(model, model.review.lab);
};
