import type { V2LibraryResponse } from "@/app/lib/v2/types";

export const LIBRARY_ARCHIVE_FADE_MS = 180;

export function removeArchivedQuestionFromView(
  data: V2LibraryResponse,
  questionId: string,
): V2LibraryResponse {
  const question = data.questions.find((candidate) => candidate.id === questionId);

  if (!question || question.lifecycle === "archived") {
    return data;
  }

  const counts = { ...data.counts };
  counts[question.lifecycle] = Math.max(0, counts[question.lifecycle] - 1);
  counts.archived += 1;

  return {
    ...data,
    counts,
    questions: data.questions.filter((candidate) => candidate.id !== questionId),
  };
}
