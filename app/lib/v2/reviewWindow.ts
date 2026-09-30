import type { V2Evaluation, V2ReviewQueueResponse } from "./types.ts";

/** Advance only within the server's eligible window. Submission still validates eligibility. */
export function advanceReviewWindow(current: V2ReviewQueueResponse, input: {
  removeCurrent?: boolean; evaluation?: V2Evaluation; answer?: string; now?: Date;
} = {}): V2ReviewQueueResponse | null {
  const now = input.now ?? new Date();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: current.timezone ?? "UTC",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value;
  if (`${value("year")}-${value("month")}-${value("day")}` !== current.localDay) return null;
  const next = current.upcomingQuestions?.[0];
  if (!next || !current.question) return null;
  const remaining = current.upcomingQuestions!.slice(1);
  if (!input.removeCurrent && current.upcomingQuestions!.length === current.summary.queueRemaining - 1) {
    remaining.push(current.question);
  }
  const total = current.summary.queueRemaining - (input.removeCurrent ? 1 : 0);
  return { ...current, question: { ...next, total },
    upcomingQuestions: remaining.map((question) => ({ ...question, total })),
    summary: { ...current.summary, queueRemaining: total },
    waitingOnEvaluation: Boolean(input.removeCurrent) || current.waitingOnEvaluation,
    recentAnswers: input.evaluation ? [{ prompt: current.question.prompt, answer: input.answer ?? "",
      submittedAt: now.toISOString(), evaluation: input.evaluation }, ...current.recentAnswers].slice(0, 20) : current.recentAnswers };
}
