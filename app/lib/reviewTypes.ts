export type ReviewHistoryEntry = {
  ts: number;
  score: number;
};

export type QuestionAttempt = {
  id: number;
  deckId: string;
  question: string;
  rawAnswer: string;
  answerSummary: string;
  score: number;
  justification: string;
  submittedAt: number;
  resolvedAt: number;
};

export type EvaluationPhase =
  | "queued"
  | "evaluating-answer"
  | "saving-evaluation"
  | "gating-probes"
  | "saving-probes"
  | "finalizing";

export type EvaluationQueueItem = {
  id: string;
  traceId: string;
  deckId: string | null;
  question: string;
  answer: string | null;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  lastActivityAt: number;
  submittedAt: number;
  score: number | null;
  justification: string | null;
  answerSummary: string | null;
  resolvedAt: number | null;
  nextDue: number | null;
};

export type ReviewQueueItem = {
  deckId: string;
  deckName: string;
  question: string;
  nextDue: number;
  createdAt: number;
  msUntilDue: number;
  status: "now" | "scheduled";
  generatedFromQuestion: string | null;
  reviewHistory: ReviewHistoryEntry[];
  lastScore: number | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
  attempts: QuestionAttempt[];
};

export type DeckEmbeddingPlotPoint = {
  question: string;
  lastScore: number | null;
  x: number;
  y: number;
};

export type DeckEmbeddingPlot = {
  model: string | null;
  totalQuestions: number;
  embeddedQuestions: number;
  points: DeckEmbeddingPlotPoint[];
};

export type QueueStatusSnapshot = {
  queueRemaining: number;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts: QuestionAttempt[];
  reviewQueue: ReviewQueueItem[];
  reviewQueueTotal: number;
  reviewQueueOffset: number;
  reviewQueueLimit: number;
  reviewQueueHasMore: boolean;
  deckEmbeddingPlot: DeckEmbeddingPlot;
};
