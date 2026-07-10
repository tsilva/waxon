export type CourseProgressDecision =
  | {
      toolCall: "mark_milestone_done";
      reason: string;
    }
  | {
      toolCall: "continue_current_milestone";
      reason: string;
    };
