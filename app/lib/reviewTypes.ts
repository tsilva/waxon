export type ReviewHistoryEntry = {
  ts: number;
  score: number;
};

export type QuestionAttempt = {
  id: number;
  questionId: string;
  question: string;
  rawAnswer: string;
  answerSummary: string;
  correctAnswer: string | null;
  score: number;
  justification: string;
  submittedAt: number;
  resolvedAt: number;
};

export type EvaluationPhase =
  | "queued"
  | "evaluating-answer"
  | "saving-evaluation"
  | "finalizing";

export type EvaluationQueueItem = {
  id: string;
  traceId: string;
  questionId: string | null;
  question: string;
  answer: string | null;
  status: "grading" | "resolved";
  phase: EvaluationPhase | null;
  lastActivityAt: number;
  submittedAt: number;
  score: number | null;
  justification: string | null;
  answerSummary: string | null;
  correctAnswer: string | null;
  resolvedAt: number | null;
  nextDue: number | null;
  cost: number | null;
};

export type ReviewQueueItem = {
  questionId: string;
  question: string;
  nextDue: number;
  createdAt: number;
  msUntilDue: number;
  status: "now" | "scheduled";
  generatedFromQuestion: string | null;
  questionProvenance: string | null;
  reviewHistory: ReviewHistoryEntry[];
  lastScore: number | null;
  lastAnswer: string | null;
  lastAnswerSummary: string | null;
  conciseAnswer: string | null;
  referenceAnswer: string | null;
  lastJustification: string | null;
  attempts: QuestionAttempt[];
  conceptSlugs: string[];
};

export type KnowledgeEmbeddingPlotPoint = {
  question: string;
  lastScore: number | null;
  x: number;
  y: number;
};

export type KnowledgeEmbeddingPlot = {
  model: string | null;
  totalQuestions: number;
  embeddedQuestions: number;
  points: KnowledgeEmbeddingPlotPoint[];
};

export type QueueStatusSnapshot = {
  queueRemaining: number;
  nextScheduledDue: number | null;
  pendingEvaluations: number;
  evaluations: EvaluationQueueItem[];
  recentAttempts: QuestionAttempt[];
  reviewQueue: ReviewQueueItem[];
  reviewQueueTotal: number;
  reviewQueueOffset: number;
  reviewQueueLimit: number;
  reviewQueueHasMore: boolean;
  knowledgeEmbeddingPlot: KnowledgeEmbeddingPlot;
};
