import type { V2Lifecycle } from "./types";

export type PlanCandidate = {
  questionId: string;
  questionVersionId: string;
  lifecycle: V2Lifecycle;
  dueAt: Date | null;
  retrievability: number | null;
  importance: number;
  createdAt: Date;
};

export type PlannedCandidate = PlanCandidate & {
  position: number;
  estimatedSeconds: number;
};

const ESTIMATED_ANSWER_SECONDS = 60;

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
  desiredRetention: number;
  scheduledBefore: Date;
  now?: Date;
}): PlannedCandidate[] {
  const now = input.now ?? new Date();
  const due = input.candidates
    .filter((candidate) => candidate.lifecycle === "learning" || candidate.lifecycle === "review")
    .filter(
      (candidate) =>
        candidate.dueAt !== null && candidate.dueAt < input.scheduledBefore,
    )
    .sort((left, right) => {
      const riskDifference = risk(right, input.desiredRetention, now) - risk(left, input.desiredRetention, now);
      return (
        riskDifference ||
        (left.dueAt?.getTime() ?? 0) - (right.dueAt?.getTime() ?? 0) ||
        left.questionId.localeCompare(right.questionId)
      );
    });
  const waiting = input.candidates
    .filter((candidate) => candidate.dueAt === null)
    .sort(
      (left, right) =>
        right.importance - left.importance ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.questionId.localeCompare(right.questionId),
    );
  const selected: PlannedCandidate[] = [];

  function admit(candidate: PlanCandidate): void {
    selected.push({
      ...candidate,
      position: selected.length,
      estimatedSeconds: ESTIMATED_ANSWER_SECONDS,
    });
  }

  for (const candidate of due) admit(candidate);
  for (const candidate of waiting) admit(candidate);
  return selected;
}
