export type V2Grade = "again" | "hard" | "good" | "easy";
export type V2Lifecycle =
  | "new"
  | "learning"
  | "review"
  | "flagged"
  | "paused"
  | "archived"
  | "trash";

export type V2Question = {
  id: string;
  versionId: string;
  prompt: string;
  referenceAnswer: string;
  lifecycle: V2Lifecycle;
  importance: number;
  dueAt: string | null;
  retrievability: number | null;
  createdAt: string;
  updatedAt: string;
};

export type V2LibraryResponse = {
  questions: V2Question[];
  counts: Record<V2Lifecycle, number>;
  waitingNew: number;
};

export type V2ReviewItem = {
  sessionId: string;
  itemId: string;
  questionId: string;
  questionVersionId: string;
  prompt: string;
  position: number;
  total: number;
  estimatedMinutes: number;
  isRetry: boolean;
};

export type V2ReviewSessionResponse = {
  session: {
    id: string;
    plannedCount: number;
    estimatedMinutes: number;
    completedCount: number;
  } | null;
  item: V2ReviewItem | null;
  retryAvailableAt: string | null;
  waitingOnEvaluation: boolean;
  blockedReason: string | null;
  summary: V2ReviewSummary;
  capacity: {
    targetFeasible: boolean;
    sustainableRetention: number;
    minutesNeeded: number;
    atRiskCount: number;
    waitingNew: number;
    oldestNewAt: string | null;
  };
};

export type V2Evaluation = {
  submissionId: string;
  evaluationId: string | null;
  status: "pending" | "complete" | "failed";
  grade: V2Grade | null;
  feedback: string | null;
  expectedAnswer: string | null;
  coveredPoints: string[];
  missingPoints: string[];
  demonstratedGap: string | null;
  confidence: number | null;
  canSelfGrade: boolean;
};

export type V2ReviewSummary = {
  queueRemaining: number;
  nextScheduledDue: number | null;
};
