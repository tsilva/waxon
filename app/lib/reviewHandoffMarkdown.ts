import type { V2RecallResult, V2ReviewAnswer } from "@/app/lib/v2/types";

const RECALL_RESULT_LABELS: Record<V2RecallResult, string> = {
  incorrect: "Incorrect",
  partial: "Partial",
  correct: "Correct",
};

function valueOrUnavailable(value: string | null): string {
  return value?.trim() || "Unavailable";
}

function markdownList(items: string[]): string {
  return items.length > 0
    ? items
        .map((item) => `- ${item.trim().replaceAll("\n", "\n  ")}`)
        .join("\n")
    : "- None";
}

export function reviewHandoffMarkdown(turn: V2ReviewAnswer): string {
  const { evaluation } = turn;
  const status =
    evaluation.status === "pending"
      ? "Evaluating"
      : evaluation.status === "failed"
        ? "Retry needed"
        : "Complete";
  const recallResult = evaluation.recallResult
    ? RECALL_RESULT_LABELS[evaluation.recallResult]
    : "Unavailable";

  return [
    "# Waxon review",
    "",
    "## Question",
    "",
    turn.prompt.trim(),
    "",
    "## Your answer",
    "",
    turn.answer.trim(),
    "",
    "## Answer standard",
    "",
    valueOrUnavailable(evaluation.expectedAnswer),
    "",
    "## Evaluation feedback",
    "",
    valueOrUnavailable(evaluation.feedback),
    "",
    "## What you got right",
    "",
    markdownList(evaluation.coveredPoints),
    "",
    "## What to improve",
    "",
    markdownList(evaluation.scoringIssues),
    "",
    "## Clarifications",
    "",
    markdownList(evaluation.clarifications),
    "",
    "## Review metadata",
    "",
    `- Status: ${status}`,
    `- Result: ${recallResult}`,
    `- Submitted: ${turn.submittedAt}`,
    `- Next review: ${evaluation.nextDueOn ?? "Unavailable"}`,
  ].join("\n");
}
