export type V2AnswerMode = "exact" | "semantic" | "rubric";
export type V2Grade = "again" | "hard" | "good" | "easy";
export type V2Lifecycle =
  | "draft"
  | "new"
  | "learning"
  | "review"
  | "paused"
  | "archived"
  | "suspended"
  | "trash"
  | "superseded";

export type V2Question = {
  id: string;
  versionId: string;
  prompt: string;
  referenceAnswer: string;
  displayAnswer: string;
  answerMode: V2AnswerMode;
  target: string;
  lifecycle: V2Lifecycle;
  quality: "pending" | "distinct" | "duplicate" | "uncertain" | "rejected";
  qualityReasons: string[];
  duplicateOfQuestionId: string | null;
  importance: number;
  dueAt: string | null;
  retrievability: number | null;
  concepts: string[];
  sourceTitles: string[];
  createdAt: string;
  updatedAt: string;
};

export type V2Source = {
  id: string;
  kind: "direct" | "paste" | "url" | "pdf" | "text" | "topic";
  status:
    | "captured"
    | "processing"
    | "ready"
    | "failed"
    | "rejected_limit"
    | "disabled"
    | "erasing"
    | "erased";
  title: string;
  originalUrl: string | null;
  progress: number;
  error: string | null;
  hasMoreAnalysis: boolean;
  coverage: {
    covered: number;
    weak: number;
    missing: number;
    ignored: number;
    unresolved: number;
  };
  createdAt: string;
};

export type V2LibraryResponse = {
  questions: V2Question[];
  sources: V2Source[];
  counts: Record<V2Lifecycle, number>;
  concepts: Array<{ id: string; name: string; slug: string; count: number }>;
  savedViews: Array<{
    id: string;
    name: string;
    query: {
      search?: string;
      lifecycle?: V2Lifecycle | "all";
    };
  }>;
  waitingNew: number;
  healthCount: number;
};

export type V2ReviewItem = {
  sessionId: string;
  itemId: string;
  questionId: string;
  questionVersionId: string;
  prompt: string;
  answerMode: V2AnswerMode;
  concepts: string[];
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
