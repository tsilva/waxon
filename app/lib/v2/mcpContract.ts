import type { QuestionSearchMatch } from "./questionSearch.ts";
import type { AddQuestionResult } from "./service.ts";
import type { V2Question, V2QuestionLifecycle } from "./types.ts";

export function canonicalMcpLifecycle(
  value: string | null,
): V2QuestionLifecycle | null {
  if (value === null) return null;
  if (["new", "learning", "review", "active"].includes(value)) {
    return "active";
  }
  return value === "flagged" ? "flagged" : "archived";
}

export function toMcpStoredQuestion(question: V2Question) {
  return {
    id: question.id,
    prompt: question.prompt,
    referenceAnswer: question.referenceAnswer,
    lifecycle: question.lifecycle,
    flags: question.flags,
    updatedAt: question.updatedAt,
  };
}

export function toMcpRankedQuestion(match: QuestionSearchMatch) {
  return {
    id: match.id,
    prompt: match.prompt,
    referenceAnswer: match.referenceAnswer,
    lifecycle: canonicalMcpLifecycle(match.lifecycle) ?? "archived",
    flags: match.flags,
    updatedAt: match.updatedAt ?? new Date(0).toISOString(),
    matchTypes: match.matchTypes,
    exactPrompt: match.exactPrompt,
    lexicalRank: match.lexicalRank,
    semanticRank: match.semanticRank,
    combinedRank: match.combinedRank,
    trigramSimilarity: match.trigramSimilarity,
    semanticSimilarity: match.semanticSimilarity,
  };
}

export function toMcpCheckMatch(match: QuestionSearchMatch) {
  return {
    ...match,
    lifecycle: canonicalMcpLifecycle(match.lifecycle),
  };
}

export function toMcpAddResponse(input: { results: AddQuestionResult[] }) {
  return {
    results: input.results.map((result) => ({
      id: result.id,
      status: result.status,
      outcome: result.outcome,
      lifecycle: result.lifecycle,
      flags: result.flags,
      answerStandardConflict: result.answerStandardConflict,
    })),
  };
}
