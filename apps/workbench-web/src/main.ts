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

const InsightTransitionCommand = S.Literals([
  "accept",
  "accept-with-correction",
  "reject",
  "dispute",
  "resolve-dispute",
  "supersede",
  "expire",
  "retire",
]);
type InsightTransitionCommand = typeof InsightTransitionCommand.Type;
const InsightStatus = S.Literals([
  "candidate",
  "active",
  "rejected",
  "disputed",
  "superseded",
  "expired",
  "retired",
]);
type InsightStatus = typeof InsightStatus.Type;
const InsightCurrentStatus = S.Literals([
  "candidate",
  "active",
  "rejected",
  "disputed",
  "superseded",
  "expired",
  "retired",
  "none",
]);

const InsightScope = S.Struct({
  user: S.NullOr(S.String),
  organization: S.NullOr(S.String),
  project: S.NullOr(S.String),
  repository: S.NullOr(S.String),
  path: S.NullOr(S.String),
  harness: S.NullOr(S.String),
  model: S.NullOr(S.String),
  tool: S.NullOr(S.String),
  domain: S.String,
});
type InsightScope = typeof InsightScope.Type;
const InsightPreview = S.Struct({
  command: S.Struct({
    command: InsightTransitionCommand,
    insightId: S.String,
    revision: S.Struct({
      revisionId: S.String,
      proposition: S.String,
      procedure: S.NullOr(S.String),
      scope: InsightScope,
      supportEvidence: S.Array(S.String),
      status: InsightStatus,
    }),
    priorLedgerHash: S.NullOr(S.String),
    recordedAt: S.String,
  }),
  commandHash: S.String,
  changedStartupContext: S.Boolean,
  currentStatus: InsightCurrentStatus,
});
type InsightPreview = typeof InsightPreview.Type;
const InsightApplicationResult = S.Struct({
  preview: InsightPreview,
  applied: S.Struct({
    transition: S.Struct({
      transitionId: S.String,
      command: InsightTransitionCommand,
      revision: S.Struct({ status: InsightStatus }),
    }),
    ledger: S.Struct({ ledgerHash: S.String }),
  }),
});
type InsightApplicationResult = typeof InsightApplicationResult.Type;

const InsightTransitionRequest = S.Struct({
  packetHash: S.String,
  proposalSetHash: S.String,
  candidateAlias: S.String,
  reviewerId: S.String,
  projectIdentity: S.String,
  correctedProposition: S.String,
  transitionCommand: S.NullOr(S.Literal("retire")),
});
type InsightTransitionRequest = typeof InsightTransitionRequest.Type;
const InsightApplyRequest = S.Struct({
  packetHash: S.String,
  proposalSetHash: S.String,
  candidateAlias: S.String,
  reviewerId: S.String,
  projectIdentity: S.String,
  correctedProposition: S.String,
  transitionCommand: S.NullOr(S.Literal("retire")),
  priorLedgerHash: S.NullOr(S.String),
  recordedAt: S.String,
  previewCommandHash: S.String,
});
type InsightApplyRequest = typeof InsightApplyRequest.Type;

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

const DurableApplication = S.Struct({
  status: InsightStatus,
  transitionId: S.String,
  ledgerHash: S.String,
  command: InsightTransitionCommand,
  projectIdentity: S.String,
});
type DurableApplication = typeof DurableApplication.Type;
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
  applications: S.Record(S.String, DurableApplication),
});
export type MemoryLabView = typeof MemoryLabView.Type;

export const ReviewLoading = ts("ReviewLoading");
export const ReviewFailed = ts("ReviewFailed", { status: S.Number, error: S.String });
export const ReviewReady = ts("ReviewReady", { lab: MemoryLabView });
const ReviewState = S.Union([ReviewLoading, ReviewFailed, ReviewReady]);

export const SaveIdle = ts("SaveIdle");
export const SavePending = ts("SavePending");
export const SaveSucceeded = ts("SaveSucceeded", { message: S.String });
export const SaveFailed = ts("SaveFailed", { error: S.String });
const SaveState = S.Union([SaveIdle, SavePending, SaveSucceeded, SaveFailed]);

const ApplicationIdle = ts("ApplicationIdle");
const ApplicationPreviewPending = ts("ApplicationPreviewPending", {
  request: InsightTransitionRequest,
});
const ApplicationPreviewReady = ts("ApplicationPreviewReady", {
  request: InsightApplyRequest,
  preview: InsightPreview,
});
const ApplicationPreviewFailed = ts("ApplicationPreviewFailed", { error: S.String });
const ApplicationApplyPending = ts("ApplicationApplyPending", {
  request: InsightApplyRequest,
  preview: InsightPreview,
});
const ApplicationApplyFailed = ts("ApplicationApplyFailed", {
  request: InsightApplyRequest,
  preview: InsightPreview,
  error: S.String,
});
const ApplicationRequestState = S.Union([
  ApplicationIdle,
  ApplicationPreviewPending,
  ApplicationPreviewReady,
  ApplicationPreviewFailed,
  ApplicationApplyPending,
  ApplicationApplyFailed,
]);

const CandidateApplication = S.Struct({
  projectIdentity: S.String,
  proposition: S.String,
  request: ApplicationRequestState,
  durable: S.NullOr(DurableApplication),
});
type CandidateApplication = typeof CandidateApplication.Type;

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
  applications: S.Record(S.String, CandidateApplication),
});
export type Model = typeof Model.Type;

export const LoadedMemoryLab = m("LoadedMemoryLab", { lab: MemoryLabView });
export const FailedMemoryLab = m("FailedMemoryLab", { status: S.Number, error: S.String });
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
export const ChangedProjectIdentity = m("ChangedProjectIdentity", { value: S.String });
export const ChangedMemoryText = m("ChangedMemoryText", { value: S.String });
export const RequestedApplicationPreview = m("RequestedApplicationPreview");
export const PreviewedApplication = m("PreviewedApplication", {
  request: InsightTransitionRequest,
  preview: InsightPreview,
});
export const FailedApplicationPreview = m("FailedApplicationPreview", {
  request: InsightTransitionRequest,
  error: S.String,
});
export const RequestedApplicationApply = m("RequestedApplicationApply");
export const AppliedApplication = m("AppliedApplication", {
  request: InsightApplyRequest,
  result: InsightApplicationResult,
});
export const FailedApplicationApply = m("FailedApplicationApply", {
  request: InsightApplyRequest,
  error: S.String,
});
export const RequestedApplicationRemoval = m("RequestedApplicationRemoval");
export const CancelledApplicationPreview = m("CancelledApplicationPreview");

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
  ChangedProjectIdentity,
  ChangedMemoryText,
  RequestedApplicationPreview,
  PreviewedApplication,
  FailedApplicationPreview,
  RequestedApplicationApply,
  AppliedApplication,
  FailedApplicationApply,
  RequestedApplicationRemoval,
  CancelledApplicationPreview,
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

class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpResponseError";
  }
}

const responseError = async (response: Response, fallback: string): Promise<never> => {
  const body: unknown = await response.json().catch(() => undefined);
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : fallback;
  return Promise.reject(new HttpResponseError(response.status, message));
};

const insightPreviewFields = {
  packetHash: S.String,
  proposalSetHash: S.String,
  candidateAlias: S.String,
  reviewerId: S.String,
  projectIdentity: S.String,
  correctedProposition: S.String,
  transitionCommand: S.optionalKey(S.Literal("retire")),
};
const InsightPreviewPayload = S.Struct(insightPreviewFields);
type InsightPreviewPayload = typeof InsightPreviewPayload.Type;
const insightApplyFields = {
  ...insightPreviewFields,
  priorLedgerHash: S.NullOr(S.String),
  recordedAt: S.String,
  previewCommandHash: S.String,
};
const InsightApplyPayload = S.Struct(insightApplyFields);
type InsightApplyPayload = typeof InsightApplyPayload.Type;

const transitionRequestFromPayload = (
  payload: InsightPreviewPayload,
): InsightTransitionRequest => ({
  packetHash: payload.packetHash,
  proposalSetHash: payload.proposalSetHash,
  candidateAlias: payload.candidateAlias,
  reviewerId: payload.reviewerId,
  projectIdentity: payload.projectIdentity,
  correctedProposition: payload.correctedProposition,
  transitionCommand: payload.transitionCommand ?? null,
});

const previewPayloadFromRequest = (request: InsightTransitionRequest): InsightPreviewPayload => ({
  packetHash: request.packetHash,
  proposalSetHash: request.proposalSetHash,
  candidateAlias: request.candidateAlias,
  reviewerId: request.reviewerId,
  projectIdentity: request.projectIdentity,
  correctedProposition: request.correctedProposition,
  ...(request.transitionCommand === null ? {} : { transitionCommand: request.transitionCommand }),
});

const applyRequestFromPayload = (payload: InsightApplyPayload): InsightApplyRequest => ({
  ...transitionRequestFromPayload(payload),
  priorLedgerHash: payload.priorLedgerHash,
  previewCommandHash: payload.previewCommandHash,
  recordedAt: payload.recordedAt,
});

const applyPayloadFromRequest = (request: InsightApplyRequest): InsightApplyPayload => ({
  ...previewPayloadFromRequest(request),
  priorLedgerHash: request.priorLedgerHash,
  recordedAt: request.recordedAt,
  previewCommandHash: request.previewCommandHash,
});

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
    Effect.catch((error) =>
      Effect.succeed(
        FailedMemoryLab({
          status: error instanceof HttpResponseError ? error.status : 0,
          error: error.message,
        }),
      ),
    ),
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

export const PreviewMemoryApplication = Command.define(
  "PreviewMemoryApplication",
  insightPreviewFields,
  PreviewedApplication,
  FailedApplicationPreview,
)((payload) => {
  const request = transitionRequestFromPayload(payload);
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch("/api/memory-lab/insight-preview", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        return responseError(response, "The memory application could not be previewed");
      return S.decodeUnknownPromise(InsightPreview)(await response.json());
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("The memory application could not be previewed"),
  }).pipe(
    Effect.map((preview) => PreviewedApplication({ request, preview })),
    Effect.catch((error) =>
      Effect.succeed(FailedApplicationPreview({ request, error: error.message })),
    ),
  );
});

export const ApplyMemoryApplication = Command.define(
  "ApplyMemoryApplication",
  insightApplyFields,
  AppliedApplication,
  FailedApplicationApply,
)((payload) => {
  const request = applyRequestFromPayload(payload);
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch("/api/memory-lab/insight-apply", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        return responseError(response, "The memory application could not be recorded");
      return S.decodeUnknownPromise(InsightApplicationResult)(await response.json());
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("The memory application could not be recorded"),
  }).pipe(
    Effect.map((result) => AppliedApplication({ request, result })),
    Effect.catch((error) =>
      Effect.succeed(FailedApplicationApply({ request, error: error.message })),
    ),
  );
});

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
    applications: {},
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

const applicationForCandidate = (
  lab: MemoryLabView,
  candidate: Candidate,
  previous?: CandidateApplication,
): CandidateApplication => ({
  projectIdentity:
    previous?.projectIdentity ?? lab.applications[candidate.candidateAlias]?.projectIdentity ?? "",
  proposition:
    previous?.proposition ?? lab.proposalSet.proposals[candidate.candidateAlias]?.lesson ?? "",
  request: ApplicationIdle(),
  durable: lab.applications[candidate.candidateAlias] ?? previous?.durable ?? null,
});

const applicationsFor = (
  lab: MemoryLabView,
  previous: Readonly<Record<string, CandidateApplication>>,
): Readonly<Record<string, CandidateApplication>> => {
  const applications: Record<string, CandidateApplication> = {};
  for (const candidate of lab.packet.candidates)
    applications[candidate.candidateAlias] = applicationForCandidate(
      lab,
      candidate,
      previous[candidate.candidateAlias],
    );
  return applications;
};

const invalidateApplicationRequest = (application: CandidateApplication): CandidateApplication =>
  application.request._tag === "ApplicationIdle"
    ? application
    : { ...application, request: ApplicationIdle() };

const applicationRequestsEqual = (
  left: InsightTransitionRequest,
  right: InsightTransitionRequest,
): boolean =>
  left.packetHash === right.packetHash &&
  left.proposalSetHash === right.proposalSetHash &&
  left.candidateAlias === right.candidateAlias &&
  left.reviewerId === right.reviewerId &&
  left.projectIdentity === right.projectIdentity &&
  left.correctedProposition === right.correctedProposition &&
  left.transitionCommand === right.transitionCommand;

const applyRequestsEqual = (left: InsightApplyRequest, right: InsightApplyRequest): boolean =>
  applicationRequestsEqual(left, right) &&
  left.priorLedgerHash === right.priorLedgerHash &&
  left.previewCommandHash === right.previewCommandHash &&
  left.recordedAt === right.recordedAt;

const candidateCanApplyMemory = (lab: MemoryLabView, candidateIndex: number): boolean => {
  const review = reviewAt(lab, candidateIndex);
  return lab.finalized && review.status === "reviewed" && review.judgment === "correct";
};

type ApplicationPreparation =
  | { readonly _tag: "Unavailable" }
  | {
      readonly _tag: "Invalid";
      readonly alias: string;
      readonly application: CandidateApplication;
      readonly error: string;
    }
  | {
      readonly _tag: "Ready";
      readonly alias: string;
      readonly application: CandidateApplication;
      readonly request: InsightTransitionRequest;
    };

const prepareApplicationRequest = (
  model: Model,
  transitionCommand: "retire" | null,
): ApplicationPreparation => {
  const lab = readyLab(model);
  const candidate = lab?.packet.candidates[model.candidateIndex];
  if (
    lab === null ||
    candidate === undefined ||
    !candidateCanApplyMemory(lab, model.candidateIndex)
  )
    return { _tag: "Unavailable" };
  const application = model.applications[candidate.candidateAlias];
  if (application === undefined) return { _tag: "Unavailable" };
  if (transitionCommand === "retire" && application.durable?.status !== "active")
    return { _tag: "Unavailable" };
  if (transitionCommand === null && application.durable?.status === "active")
    return { _tag: "Unavailable" };
  const projectIdentity = application.projectIdentity.trim();
  if (projectIdentity.length === 0)
    return {
      _tag: "Invalid",
      alias: candidate.candidateAlias,
      application,
      error: "Enter a target context or project identity before previewing.",
    };
  if (application.proposition.trim().length === 0)
    return {
      _tag: "Invalid",
      alias: candidate.candidateAlias,
      application,
      error: "Memory text is required before previewing.",
    };
  const reviewerId = lab.reviews.reviewer.id.trim();
  if (reviewerId.length === 0)
    return {
      _tag: "Invalid",
      alias: candidate.candidateAlias,
      application,
      error: "The finalized reviewer identity is missing.",
    };
  return {
    _tag: "Ready",
    alias: candidate.candidateAlias,
    application,
    request: {
      packetHash: lab.packet.packetHash,
      proposalSetHash: lab.proposalSetHash,
      candidateAlias: candidate.candidateAlias,
      reviewerId,
      projectIdentity,
      correctedProposition: application.proposition,
      transitionCommand,
    },
  };
};

const withApplication = (
  model: Model,
  alias: string,
  application: CandidateApplication,
): Model => ({
  ...model,
  applications: { ...model.applications, [alias]: application },
});

const invalidateApplicationForAlias = (
  applications: Readonly<Record<string, CandidateApplication>>,
  alias: string | undefined,
): Readonly<Record<string, CandidateApplication>> => {
  if (alias === undefined) return applications;
  const application = applications[alias];
  if (application === undefined || application.request._tag === "ApplicationIdle")
    return applications;
  return {
    ...applications,
    [alias]: invalidateApplicationRequest(application),
  };
};

const atIndex = (model: Model, index: number): Model => {
  const lab = readyLab(model);
  if (lab === null) return model;
  const bounded = Math.max(0, Math.min(index, lab.packet.candidates.length - 1));
  const currentAlias = lab.packet.candidates[model.candidateIndex]?.candidateAlias;
  const nextAlias = lab.packet.candidates[bounded]?.candidateAlias;
  const applications = invalidateApplicationForAlias(
    invalidateApplicationForAlias(model.applications, currentAlias),
    nextAlias,
  );
  return {
    ...model,
    candidateIndex: bounded,
    form: formAt(lab, bounded, model.form.reviewerId),
    isDirty: false,
    save: SaveIdle(),
    confirmingFinalize: false,
    applications,
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
          applications: applicationsFor(message.lab, model.applications),
        },
        [],
      ];
    }
    case "FailedMemoryLab":
      return [
        { ...model, review: ReviewFailed({ status: message.status, error: message.error }) },
        [],
      ];
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
          applications: applicationsFor(message.lab, model.applications),
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
          applications: applicationsFor(message.lab, model.applications),
        },
        [],
      ];
    case "FailedFinalize":
      return [
        { ...model, save: SaveFailed({ error: message.error }), confirmingFinalize: false },
        [],
      ];
    case "ChangedProjectIdentity":
    case "ChangedMemoryText": {
      const lab = readyLab(model);
      const alias = lab?.packet.candidates[model.candidateIndex]?.candidateAlias;
      const application = alias === undefined ? undefined : model.applications[alias];
      if (
        alias === undefined ||
        application === undefined ||
        application.durable?.status === "active"
      )
        return [model, []];
      return [
        withApplication(model, alias, {
          ...application,
          projectIdentity:
            message._tag === "ChangedProjectIdentity" ? message.value : application.projectIdentity,
          proposition:
            message._tag === "ChangedMemoryText" ? message.value : application.proposition,
          request: ApplicationIdle(),
        }),
        [],
      ];
    }
    case "RequestedApplicationPreview":
    case "RequestedApplicationRemoval": {
      const transitionCommand =
        message._tag === "RequestedApplicationRemoval" ? ("retire" as const) : null;
      const preparation = prepareApplicationRequest(model, transitionCommand);
      if (preparation._tag === "Unavailable") return [model, []];
      if (preparation._tag === "Invalid")
        return [
          withApplication(model, preparation.alias, {
            ...preparation.application,
            request: ApplicationPreviewFailed({ error: preparation.error }),
          }),
          [],
        ];
      return [
        withApplication(model, preparation.alias, {
          ...preparation.application,
          request: ApplicationPreviewPending({ request: preparation.request }),
        }),
        [PreviewMemoryApplication(previewPayloadFromRequest(preparation.request))],
      ];
    }
    case "PreviewedApplication": {
      const application = model.applications[message.request.candidateAlias];
      if (
        application === undefined ||
        application.request._tag !== "ApplicationPreviewPending" ||
        !applicationRequestsEqual(application.request.request, message.request)
      )
        return [model, []];
      const request: InsightApplyRequest = {
        ...message.request,
        priorLedgerHash: message.preview.command.priorLedgerHash,
        previewCommandHash: message.preview.commandHash,
        recordedAt: message.preview.command.recordedAt,
      };
      return [
        withApplication(model, message.request.candidateAlias, {
          ...application,
          request: ApplicationPreviewReady({ request, preview: message.preview }),
        }),
        [],
      ];
    }
    case "FailedApplicationPreview": {
      const application = model.applications[message.request.candidateAlias];
      if (
        application === undefined ||
        application.request._tag !== "ApplicationPreviewPending" ||
        !applicationRequestsEqual(application.request.request, message.request)
      )
        return [model, []];
      return [
        withApplication(model, message.request.candidateAlias, {
          ...application,
          request: ApplicationPreviewFailed({ error: message.error }),
        }),
        [],
      ];
    }
    case "RequestedApplicationApply": {
      const lab = readyLab(model);
      const alias = lab?.packet.candidates[model.candidateIndex]?.candidateAlias;
      const application = alias === undefined ? undefined : model.applications[alias];
      if (
        lab === null ||
        alias === undefined ||
        application === undefined ||
        !candidateCanApplyMemory(lab, model.candidateIndex) ||
        (application.request._tag !== "ApplicationPreviewReady" &&
          application.request._tag !== "ApplicationApplyFailed")
      )
        return [model, []];
      const { request, preview } = application.request;
      return [
        withApplication(model, alias, {
          ...application,
          request: ApplicationApplyPending({ request, preview }),
        }),
        [ApplyMemoryApplication(applyPayloadFromRequest(request))],
      ];
    }
    case "AppliedApplication": {
      const application = model.applications[message.request.candidateAlias];
      if (
        application === undefined ||
        application.request._tag !== "ApplicationApplyPending" ||
        !applyRequestsEqual(application.request.request, message.request)
      )
        return [model, []];
      return [
        withApplication(model, message.request.candidateAlias, {
          ...application,
          request: ApplicationIdle(),
          durable: {
            status: message.result.applied.transition.revision.status,
            transitionId: message.result.applied.transition.transitionId,
            ledgerHash: message.result.applied.ledger.ledgerHash,
            command: message.result.applied.transition.command,
            projectIdentity: message.request.projectIdentity,
          },
        }),
        [],
      ];
    }
    case "FailedApplicationApply": {
      const application = model.applications[message.request.candidateAlias];
      if (
        application === undefined ||
        application.request._tag !== "ApplicationApplyPending" ||
        !applyRequestsEqual(application.request.request, message.request)
      )
        return [model, []];
      return [
        withApplication(model, message.request.candidateAlias, {
          ...application,
          request: ApplicationApplyFailed({
            request: message.request,
            preview: application.request.preview,
            error: message.error,
          }),
        }),
        [],
      ];
    }
    case "CancelledApplicationPreview": {
      const lab = readyLab(model);
      const alias = lab?.packet.candidates[model.candidateIndex]?.candidateAlias;
      const application = alias === undefined ? undefined : model.applications[alias];
      if (
        alias === undefined ||
        application === undefined ||
        (application.request._tag !== "ApplicationPreviewReady" &&
          application.request._tag !== "ApplicationApplyFailed")
      )
        return [model, []];
      return [withApplication(model, alias, { ...application, request: ApplicationIdle() }), []];
    }
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
const retireButton = `min-h-11 rounded-xl border border-warning/50 bg-warning-container/35 px-4 py-2.5 text-sm font-bold text-on-warning-container transition hover:border-warning data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 ${focus}`;

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

type ApplicationPreviewDisplay = {
  readonly request: InsightApplyRequest;
  readonly preview: InsightPreview;
  readonly applying: boolean;
};

const displayedApplicationPreview = (
  application: CandidateApplication,
): ApplicationPreviewDisplay | null => {
  switch (application.request._tag) {
    case "ApplicationPreviewReady":
    case "ApplicationApplyFailed":
      return {
        request: application.request.request,
        preview: application.request.preview,
        applying: false,
      };
    case "ApplicationApplyPending":
      return {
        request: application.request.request,
        preview: application.request.preview,
        applying: true,
      };
    default:
      return null;
  }
};

const applicationIsBusy = (application: CandidateApplication): boolean =>
  application.request._tag === "ApplicationPreviewPending" ||
  application.request._tag === "ApplicationApplyPending";

const applicationStatusView = (application: CandidateApplication): Html => {
  const h = html<Message>();
  switch (application.request._tag) {
    case "ApplicationPreviewPending":
      return h.p(
        [
          h.Class("mt-3 text-sm font-semibold text-on-surface-variant"),
          h.Attribute("role", "status"),
          h.Attribute("aria-live", "polite"),
        ],
        [
          application.request.request.transitionCommand === "retire"
            ? "Previewing removal…"
            : "Previewing application…",
        ],
      );
    case "ApplicationApplyPending":
      return h.p(
        [
          h.Class("mt-3 text-sm font-semibold text-on-surface-variant"),
          h.Attribute("role", "status"),
          h.Attribute("aria-live", "polite"),
        ],
        [
          application.request.request.transitionCommand === "retire"
            ? "Recording retirement…"
            : "Applying to agent memory…",
        ],
      );
    case "ApplicationPreviewFailed":
    case "ApplicationApplyFailed":
      return h.p(
        [h.Class("mt-3 text-sm font-semibold text-error"), h.Attribute("role", "alert")],
        [application.request.error],
      );
    default:
      return h.empty;
  }
};

const applicationScopeView = (scope: InsightScope): Html => {
  const h = html<Message>();
  const entries: ReadonlyArray<readonly [string, string | null]> = [
    ["User", scope.user],
    ["Organization", scope.organization],
    ["Project", scope.project],
    ["Repository", scope.repository],
    ["Path", scope.path],
    ["Harness", scope.harness],
    ["Model", scope.model],
    ["Tool", scope.tool],
    ["Domain", scope.domain],
  ];
  return h.dl(
    [h.Class("mt-3 grid gap-2 @min-[32rem]:grid-cols-2")],
    entries.map(([label, value]) =>
      h.keyed("div")(
        label,
        [h.Class("min-w-0 border-l-2 border-line pl-3")],
        [
          h.dt([h.Class("text-[0.68rem] font-bold uppercase tracking-wide text-muted")], [label]),
          h.dd([h.Class("mt-1 break-words text-sm text-on-surface")], [value ?? "Not set"]),
        ],
      ),
    ),
  );
};

const durableApplicationView = (durable: DurableApplication): Html => {
  const h = html<Message>();
  const active = durable.status === "active";
  const removed = durable.status === "retired";
  const status = active
    ? "Active in agent memory"
    : removed
      ? "Removed from agent memory"
      : `Recorded status: ${durable.status}`;
  return h.div(
    [
      h.Class(
        `mt-5 border-l-4 p-4 ${
          active ? "border-valid bg-primary-container/20" : "border-warning bg-warning-container/20"
        }`,
      ),
      h.Attribute("role", "status"),
      h.Attribute("aria-live", "polite"),
    ],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-2")],
        [
          h.strong([h.Class(active ? "text-valid" : "text-on-warning-container")], [status]),
          h.span(
            [h.Class("rounded-full bg-surface-container-high px-3 py-1 text-xs text-muted")],
            [`Lifecycle: ${durable.command}`],
          ),
        ],
      ),
      h.p(
        [h.Class("mt-2 text-xs leading-5 text-on-surface-variant")],
        [
          removed
            ? "Removal appended a retirement transition. The ledger history remains intact."
            : "This state was durably recorded after an explicit preview and apply.",
        ],
      ),
      h.dl(
        [h.Class("mt-3 grid gap-2 text-xs @min-[38rem]:grid-cols-2")],
        [
          h.div(
            [h.Class("min-w-0")],
            [
              h.dt([h.Class("font-bold text-muted")], ["Transition identifier"]),
              h.dd([h.Class("mt-1 break-all font-mono text-on-surface")], [durable.transitionId]),
            ],
          ),
          h.div(
            [h.Class("min-w-0")],
            [
              h.dt([h.Class("font-bold text-muted")], ["Ledger identifier"]),
              h.dd([h.Class("mt-1 break-all font-mono text-on-surface")], [durable.ledgerHash]),
            ],
          ),
        ],
      ),
    ],
  );
};

const applicationPreviewView = (display: ApplicationPreviewDisplay): Html => {
  const h = html<Message>();
  const { preview, request } = display;
  const removal = request.transitionCommand === "retire";
  const revision = preview.command.revision;
  const evidenceCount = revision.supportEvidence.length;
  return h.div(
    [
      h.Class("mt-5 border-y border-line bg-surface-container/45 py-5"),
      h.Attribute("aria-live", "polite"),
    ],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-2")],
        [
          h.strong(
            [h.Class("text-sm text-on-surface")],
            [removal ? "Removal preview" : "Application preview"],
          ),
          h.span(
            [h.Class("rounded-full bg-primary-container/30 px-3 py-1 text-xs text-primary")],
            ["No memory changed yet"],
          ),
        ],
      ),
      h.p(
        [h.Class("mt-4 text-[0.68rem] font-bold uppercase tracking-wide text-muted")],
        ["Exact proposition"],
      ),
      h.p(
        [h.Class("mt-1 whitespace-pre-wrap text-base font-semibold leading-7 text-on-surface")],
        [revision.proposition],
      ),
      h.dl(
        [h.Class("mt-4 grid gap-3 @min-[32rem]:grid-cols-2")],
        [
          h.div(
            [],
            [
              h.dt([h.Class("text-xs font-bold text-muted")], ["Lifecycle command"]),
              h.dd([h.Class("mt-1 font-mono text-sm text-on-surface")], [preview.command.command]),
            ],
          ),
          h.div(
            [],
            [
              h.dt([h.Class("text-xs font-bold text-muted")], ["Current status"]),
              h.dd([h.Class("mt-1 font-mono text-sm text-on-surface")], [preview.currentStatus]),
            ],
          ),
          h.div(
            [],
            [
              h.dt([h.Class("text-xs font-bold text-muted")], ["Supporting evidence"]),
              h.dd(
                [h.Class("mt-1 text-sm text-on-surface")],
                [`${evidenceCount} ${evidenceCount === 1 ? "item" : "items"}`],
              ),
            ],
          ),
          h.div(
            [],
            [
              h.dt([h.Class("text-xs font-bold text-muted")], ["Startup context changes"]),
              h.dd(
                [h.Class("mt-1 text-sm text-on-surface")],
                [preview.changedStartupContext ? "Yes" : "No"],
              ),
            ],
          ),
        ],
      ),
      h.p([h.Class("mt-5 text-xs font-bold text-muted")], ["Exact scope"]),
      applicationScopeView(revision.scope),
    ],
  );
};

const memoryApplicationView = (candidateAlias: string, application: CandidateApplication): Html => {
  const h = html<Message>();
  const busy = applicationIsBusy(application);
  const active = application.durable?.status === "active";
  const preview = displayedApplicationPreview(application);
  const removalPreview = preview?.request.transitionCommand === "retire";
  const fieldsDisabled = busy || active;
  const primaryAction =
    preview === null
      ? active
        ? button(
            application.request._tag === "ApplicationPreviewPending"
              ? "Previewing removal…"
              : "Remove from agent memory",
            RequestedApplicationRemoval(),
            retireButton,
            busy,
          )
        : button(
            application.request._tag === "ApplicationPreviewPending"
              ? "Previewing application…"
              : "Preview application",
            RequestedApplicationPreview(),
            secondaryButton,
            busy,
          )
      : button(
          removalPreview ? "Confirm removal" : "Apply to agent memory",
          RequestedApplicationApply(),
          removalPreview ? retireButton : primaryButton,
          preview.applying,
        );
  return h.section(
    [
      h.Class("mt-7 border-t border-line pt-6"),
      h.Attribute("aria-labelledby", "memory-application-heading"),
      h.Attribute("aria-busy", busy ? "true" : "false"),
    ],
    [
      h.div(
        [h.Class("flex flex-wrap items-start justify-between gap-3")],
        [
          h.div(
            [h.Class("min-w-0")],
            [
              h.p(
                [h.Class("text-[0.68rem] font-bold uppercase tracking-[0.16em] text-primary")],
                [`${candidateAlias} · Finalized correct proposal`],
              ),
              h.h3(
                [
                  h.Attribute("id", "memory-application-heading"),
                  h.Class("mt-1 text-xl font-semibold"),
                ],
                ["Agent memory application"],
              ),
            ],
          ),
          h.span(
            [h.Class("rounded-full bg-surface-container-high px-3 py-1 text-xs text-muted")],
            ["Separate write"],
          ),
        ],
      ),
      h.p(
        [h.Class("mt-2 max-w-3xl text-sm leading-6 text-on-surface-variant")],
        [
          "Choose the target context and memory text. Previewing changes nothing; only the separate apply action records a ledger transition.",
        ],
      ),
      h.div(
        [h.Class("mt-5 grid gap-4 @min-[44rem]:grid-cols-[minmax(14rem,0.7fr)_minmax(0,1.3fr)]")],
        [
          h.div(
            [h.Class("min-w-0")],
            [
              Input.view<Message>({
                id: "memory-project-identity",
                value: application.projectIdentity,
                placeholder: "Project or target context",
                isDisabled: fieldsDisabled,
                onInput: (value) => ChangedProjectIdentity({ value }),
                toView: (attributes) =>
                  h.label(
                    [...attributes.label, h.Class("grid gap-2 text-sm font-bold")],
                    [
                      "Target context / project identity",
                      h.input([
                        ...attributes.input,
                        h.Attribute("aria-required", "true"),
                        h.Attribute("aria-describedby", "memory-project-identity-help"),
                        h.Class(
                          `min-h-11 rounded-xl border border-line bg-surface-container px-3 py-2 text-base text-on-surface placeholder:text-muted disabled:opacity-45 ${focus}`,
                        ),
                      ]),
                    ],
                  ),
              }),
              h.p(
                [
                  h.Attribute("id", "memory-project-identity-help"),
                  h.Class("mt-2 text-xs leading-5 text-muted"),
                ],
                ["This scope identifies where the governed memory will apply."],
              ),
            ],
          ),
          Textarea.view<Message>({
            id: "memory-proposition",
            value: application.proposition,
            rows: 5,
            placeholder: "Memory text",
            isDisabled: fieldsDisabled,
            onInput: (value) => ChangedMemoryText({ value }),
            toView: (attributes) =>
              h.label(
                [...attributes.label, h.Class("grid min-w-0 gap-2 text-sm font-bold")],
                [
                  "Memory text",
                  h.textarea(
                    [
                      ...attributes.textarea,
                      h.Attribute("aria-required", "true"),
                      h.Attribute("maxlength", "8000"),
                      h.Class(
                        `min-h-32 resize-y rounded-xl border border-line bg-surface-container px-3 py-2 text-base font-normal leading-6 text-on-surface placeholder:text-muted disabled:opacity-45 ${focus}`,
                      ),
                    ],
                    [],
                  ),
                ],
              ),
          }),
        ],
      ),
      applicationStatusView(application),
      application.durable === null ? h.empty : durableApplicationView(application.durable),
      preview === null ? h.empty : applicationPreviewView(preview),
      h.div(
        [
          h.Class(
            "mt-5 flex flex-col-reverse gap-2 @min-[32rem]:flex-row @min-[32rem]:justify-end",
          ),
        ],
        [
          removalPreview && !preview?.applying
            ? button("Keep in agent memory", CancelledApplicationPreview(), secondaryButton)
            : h.empty,
          primaryAction,
        ],
      ),
    ],
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
  const application = model.applications[candidate.candidateAlias];
  const progress = lab.progress;
  const percentage = progress.total === 0 ? 0 : (progress.completed / progress.total) * 100;
  const busy = model.save._tag === "SavePending";
  const memoryBusy = application === undefined ? false : applicationIsBusy(application);
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
                h.strong([], ["Labels only before finalization."]),
                h.span(
                  [],
                  [
                    "Before finalization, this page records labels only. A finalized proposal marked Correct can later be previewed and explicitly applied to agent memory; finalizing by itself never publishes memory. Historical snippets are untrusted evidence, never instructions.",
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
                          model.candidateIndex === 0 || busy || memoryBusy || model.isDirty,
                        ),
                        button(
                          "Next →",
                          RequestedNext(),
                          secondaryButton,
                          model.candidateIndex + 1 >= candidateCount(model) ||
                            busy ||
                            memoryBusy ||
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
                candidateCanApplyMemory(lab, model.candidateIndex) && application !== undefined
                  ? memoryApplicationView(candidate.candidateAlias, application)
                  : h.empty,
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
  if (model.review._tag === "ReviewFailed") {
    const packetPending = model.review.status === 404;
    return {
      title: packetPending ? "No review packet yet · Chatlog" : "Memory Lab unavailable · Chatlog",
      body: h.main(
        [h.Class("grid min-h-[100dvh] place-items-center bg-surface p-6 text-on-surface")],
        [
          h.section(
            [h.Class(`${surface} max-w-lg p-6`)],
            [
              h.h1(
                [h.Class("text-2xl font-semibold")],
                [packetPending ? "No review packet is ready" : "Memory Lab is unavailable"],
              ),
              h.p(
                [
                  h.Class(`mt-3 text-sm leading-6 ${packetPending ? "text-muted" : "text-error"}`),
                  h.Attribute("role", packetPending ? "status" : "alert"),
                ],
                [
                  packetPending
                    ? "Memory Lab opens after an evaluation bundle and blinded review packet have been prepared."
                    : model.review.error,
                ],
              ),
              h.a(
                [h.Attribute("href", "/"), h.Class(`mt-5 inline-flex ${secondaryButton}`)],
                ["Return to Workbench"],
              ),
            ],
          ),
        ],
      ),
    };
  }
  return readyView(model, model.review.lab);
};
