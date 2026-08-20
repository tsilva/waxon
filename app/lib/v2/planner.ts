import type { V2AnswerMode, V2Lifecycle } from "./types";

export type PlanCandidate = {
  questionId: string;
  questionVersionId: string;
  lifecycle: V2Lifecycle;
  answerMode: V2AnswerMode;
  dueAt: Date | null;
  retrievability: number | null;
  importance: number;
  createdAt: Date;
};

export type PlannedCandidate = PlanCandidate & {
  position: number;
  estimatedSeconds: number;
};

const MODE_SECONDS: Record<V2AnswerMode, number> = {
  exact: 30,
  semantic: 60,
  rubric: 90,
};

function risk(candidate: PlanCandidate, retention: number, now: Date): number {
  const retrievability = candidate.retrievability ?? 0;
  const shortfall = Math.max(0, retention - retrievability);
  const overdueDays = candidate.dueAt
    ? Math.max(0, (now.getTime() - candidate.dueAt.getTime()) / 86_400_000)
    : 0;

  return candidate.importance * (shortfall * 10 + Math.min(3, overdueDays / 7));
}

export function buildReviewPlan(input: {
  candidates: PlanCandidate[];
  timeBudgetMinutes: number;
  desiredRetention: number;
  newItemsPerDay: number;
  now?: Date;
  maxPresentations?: number;
}): PlannedCandidate[] {
  const now = input.now ?? new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60_000);
  const maxPresentations = Math.min(200, input.maxPresentations ?? 200);
  let remainingSeconds = Math.max(60, input.timeBudgetMinutes * 60);
  let remainingBaseSlots = Math.floor(maxPresentations / 2);
  const due = input.candidates
    .filter((candidate) => candidate.lifecycle === "learning" || candidate.lifecycle === "review")
    .filter((candidate) => candidate.dueAt !== null && candidate.dueAt <= horizon)
    .sort((left, right) => {
      const riskDifference = risk(right, input.desiredRetention, now) - risk(left, input.desiredRetention, now);
      return (
        riskDifference ||
        (left.dueAt?.getTime() ?? 0) - (right.dueAt?.getTime() ?? 0) ||
        left.questionId.localeCompare(right.questionId)
      );
    });
  const waiting = input.candidates
    .filter((candidate) => candidate.lifecycle === "new")
    .sort(
      (left, right) =>
        right.importance - left.importance ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.questionId.localeCompare(right.questionId),
    );
  const selected: PlannedCandidate[] = [];

  function admit(candidate: PlanCandidate): boolean {
    const estimate = MODE_SECONDS[candidate.answerMode];
    const reservedSeconds = estimate * 2;
    if (remainingBaseSlots <= 0 || reservedSeconds > remainingSeconds) return false;
    selected.push({ ...candidate, position: selected.length, estimatedSeconds: estimate });
    remainingBaseSlots -= 1;
    remainingSeconds -= reservedSeconds;
    return true;
  }

  for (const candidate of due) admit(candidate);
  let admittedNew = 0;
  for (const candidate of waiting) {
    if (admittedNew >= input.newItemsPerDay) break;
    if (admit(candidate)) admittedNew += 1;
  }
  return selected;
}
