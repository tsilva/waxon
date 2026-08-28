import type { V2Grade, V2ReviewAnswer } from "@/app/lib/v2/types";

const GRADE_LABELS: Record<V2Grade, string> = {
  again: "Again (0)",
  hard: "Hard (2)",
  good: "Good (3)",
  easy: "Easy (4)",
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
        ? "Self-grade needed"
        : "Complete";
  const grade = evaluation.grade
    ? GRADE_LABELS[evaluation.grade]
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
    "## Demonstrated gap",
    "",
    valueOrUnavailable(evaluation.demonstratedGap),
    "",
    "## Recovered",
    "",
    markdownList(evaluation.coveredPoints),
    "",
    "## Missing",
    "",
    markdownList(evaluation.missingPoints),
    "",
    "## Review metadata",
    "",
    `- Status: ${status}`,
    `- Grade: ${grade}`,
    `- Submitted: ${turn.submittedAt}`,
    `- Next review: ${evaluation.nextDueOn ?? "Unavailable"}`,
  ].join("\n");
}
