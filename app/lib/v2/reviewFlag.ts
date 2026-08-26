export const REVIEW_FLAG_REASONS = [
  { id: "prompt_unclear", label: "Prompt is unclear" },
  { id: "answer_standard_incorrect", label: "Answer standard is wrong" },
  { id: "question_too_broad", label: "Question is too broad" },
  { id: "duplicate_question", label: "Possible duplicate" },
  { id: "formatting_issue", label: "Formatting issue" },
] as const;

export type ReviewFlagReason = (typeof REVIEW_FLAG_REASONS)[number]["id"];

export const REVIEW_FLAG_REASON_LABELS: Readonly<
  Record<ReviewFlagReason, string>
> = Object.fromEntries(
  REVIEW_FLAG_REASONS.map((reason) => [reason.id, reason.label]),
) as Record<ReviewFlagReason, string>;

const REVIEW_FLAG_REASON_IDS = new Set<string>(
  REVIEW_FLAG_REASONS.map((reason) => reason.id),
);
export const MAX_REVIEW_FLAG_DETAIL_LENGTH = 4_000;

export function normalizeReviewFlagInput(input: {
  reasons?: unknown;
  detail?: unknown;
}): { reasons: ReviewFlagReason[]; detail: string | null } {
  const suppliedReasons = input.reasons ?? [];
  if (!Array.isArray(suppliedReasons)) {
    throw new Error("Flag Reasons must be a list.");
  }

  const reasons: ReviewFlagReason[] = [];
  for (const reason of suppliedReasons) {
    if (typeof reason !== "string" || !REVIEW_FLAG_REASON_IDS.has(reason)) {
      throw new Error("Choose a recognized Flag Reason.");
    }
    if (!reasons.includes(reason as ReviewFlagReason)) {
      reasons.push(reason as ReviewFlagReason);
    }
  }

  if (input.detail !== undefined && input.detail !== null && typeof input.detail !== "string") {
    throw new Error("Flag detail must be text.");
  }
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  if (detail.length > MAX_REVIEW_FLAG_DETAIL_LENGTH) {
    throw new Error(
      `Flag detail must be at most ${MAX_REVIEW_FLAG_DETAIL_LENGTH} characters.`,
    );
  }

  return { reasons, detail: detail || null };
}
