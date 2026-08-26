export type V2Grade = "again" | "hard" | "good" | "easy";
export type V2Lifecycle =
  | "new"
  | "learning"
  | "review"
  | "flagged"
  | "paused"
  | "archived"
  | "trash";

export type V2QuestionLifecycle = "active" | "flagged" | "archived";

export type V2QuestionFlagOrigin = "waxon_validation" | "learner";

export type V2QuestionFlag = {
  origin: V2QuestionFlagOrigin;
  reasons: string[];
  detail: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type V2Question = {
  id: string;
  versionId: string;
  prompt: string;
  referenceAnswer: string;
  lifecycle: V2QuestionLifecycle;
  flags: V2QuestionFlag[];
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type V2LibraryResponse = {
  questions: V2Question[];
  counts: Record<V2QuestionLifecycle, number>;
  waitingNew: number;
};

export type V2ReviewQuestion = {
  questionId: string;
  questionVersionId: string;
  prompt: string;
  total: number;
  scheduledFor: string | null;
};

export type V2ReviewAnswer = {
  prompt: string;
  answer: string;
  submittedAt: string;
  evaluation: V2Evaluation;
};

export type V2ReviewQueueResponse = {
  question: V2ReviewQuestion | null;
  recentAnswers: V2ReviewAnswer[];
  waitingOnEvaluation: boolean;
  timezone: string | null;
  localDay: string;
  summary: V2ReviewSummary;
};

export type V2LearnerSettings = {
  timezone: string | null;
};

export type V2Evaluation = {
  submissionId: string;
  evaluationId: string | null;
  status: "pending" | "complete" | "failed";
  grade: V2Grade | null;
  nextDueOn: string | null;
  feedback: string | null;
  expectedAnswer: string | null;
  coveredPoints: string[];
  missingPoints: string[];
  demonstratedGap: string | null;
  confidence: number | null;
  canSelfGrade: boolean;
  canCorrectGrade: boolean;
};

export type V2ReviewSummary = {
  queueRemaining: number;
  nextScheduledOn: string | null;
};
