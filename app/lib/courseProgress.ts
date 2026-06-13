export type CourseProgressDecision =
  | {
      toolCall: "mark_milestone_done";
      reason: string;
    }
  | {
      toolCall: "continue_current_milestone";
      reason: string;
    };

export const COURSE_MILESTONE_MASTERY_SCORE = 9;

export function requireCourseMilestoneMastery(input: {
  progressDecision: CourseProgressDecision;
  evaluationScore: number | null;
}): CourseProgressDecision {
  if (input.progressDecision.toolCall !== "mark_milestone_done") {
    return input.progressDecision;
  }

  if (
    typeof input.evaluationScore === "number" &&
    Number.isFinite(input.evaluationScore) &&
    input.evaluationScore >= COURSE_MILESTONE_MASTERY_SCORE
  ) {
    return input.progressDecision;
  }

  return {
    toolCall: "continue_current_milestone",
    reason:
      input.evaluationScore === null
        ? "The learner has not yet produced a recorded high-confidence answer for this milestone."
        : `The learner's latest answer scored ${input.evaluationScore}/10, so keep practicing this milestone before advancing.`,
  };
}
