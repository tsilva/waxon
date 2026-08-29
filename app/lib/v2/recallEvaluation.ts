import type { V2Grade, V2RecallResult } from "./types.ts";

export type RecallEvaluationResult = {
  recallResult: V2RecallResult;
  coveredPoints: string[];
  scoringIssues: string[];
  clarifications: string[];
  confidence: number;
};

export type NormalizedRecallEvaluation = RecallEvaluationResult & {
  feedback: string;
};

export const RECALL_EVALUATION_SYSTEM_PROMPT =
  "Evaluate free recall directly from the Prompt, stored Answer Standard, and Learner Answer. Classify the Learner Answer as incorrect, partial, or correct. Treat every distinct substantive claim in the Answer Standard as required unless the Answer Standard explicitly marks it optional. Before choosing a Recall Result, decompose the Answer Standard into its required claims and account for each required claim in exactly one of coveredPoints or scoringIssues. Do not accept recovery of only the primary, main, or most important claims as complete recovery. An omitted required claim is a scoring issue, not a clarification. Correct means the Learner Answer satisfies every required claim in the Recall Target with no scoring issues. Partial means it recovers meaningful required knowledge but still has at least one scoring issue. Incorrect means it does not recover meaningful required knowledge or is materially wrong. Prefer a failed result over a false correct result when the evidence is ambiguous. Judge knowledge rather than surface representation: accurate prose, mathematical notation, pseudocode, and executable code are equivalent when they express the same required knowledge. Representation is required only when the Prompt explicitly requires exact syntax, notation, spelling, quotation, executable code, or an identifier whose characters determine correctness. Put satisfied required knowledge in coveredPoints. Put only omissions or errors that prevent a correct result in scoringIssues. Put non-scoring precision, terminology, notation, and representation differences in clarifications. Clarifications must never lower the recallResult and must not contain substantive knowledge required by the Answer Standard. Return JSON only with recallResult (incorrect|partial|correct), coveredPoints, scoringIssues, clarifications, and confidence. Keep the fields consistent: correct has no scoringIssues; partial has at least one coveredPoint and at least one scoringIssue; incorrect has at least one scoringIssue.";

const EXPLICIT_REPRESENTATION_PATTERNS = [
  /\b(?:in|using|with)\s+(?:exact\s+)?(?:mathematical|symbolic)\s+notation\b/u,
  /\b(?:mathematical|symbolic)\s+notation\s+for\b/u,
  /\b(?:write|provide|give|return|show)\b[^.!?]{0,80}\b(?:executable|source)?\s*code\b/u,
  /\bimplement(?:s|ed|ing|ation)?\b/u,
  /\b(?:(?:in|using)\s+|(?:write|provide|give|show)\b[^.!?]{0,80})pseudocode\b/u,
  /\b(?:answer|respond|explain)\b[^.!?]{0,80}\bin prose\b/u,
  /\b(?:write|provide|give)\s+(?:the|an?)?\s*(?:equation|formula|expression)\b/u,
  /\bexact\s+(?:syntax|notation|spelling|quotation|wording|identifier|code)\b/u,
  /\b(?:quote|reproduce)\b[^.!?]{0,40}\b(?:exactly|verbatim)\b/u,
];

const PRESENTATION_POINT_PATTERNS = [
  /^(?:use\s+of\s+)?(?:mathematical|symbolic|equation)\s+notation(?:\s*\([^)]*\))?$/u,
  /^(?:an?\s+)?(?:executable|source|computer|python|pytorch|jax|javascript|typescript)\s+code(?:\s+(?:implementation|form|syntax))?(?:\s*\([^)]*\))?$/u,
  /^code\s+(?:implementation|form|syntax)(?:\s*\([^)]*\))?$/u,
  /^pseudocode(?:\s+(?:implementation|form))?(?:\s*\([^)]*\))?$/u,
  /^prose\s+(?:answer|explanation|form|description)(?:\s*\([^)]*\))?$/u,
  /^(?:answer|response|presentation)\s+(?:format|formatting|representation)(?:\s*\([^)]*\))?$/u,
];

function uniquePoints(points: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of points) {
    const point = value.trim();
    const key = point.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

function promptRequiresRepresentation(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return EXPLICIT_REPRESENTATION_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

function isPresentationOnlyPoint(point: string): boolean {
  const normalized = point.toLowerCase();
  return PRESENTATION_POINT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function asSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function composeRecallFeedback(input: {
  recallResult: V2RecallResult;
  scoringIssues: string[];
  clarifications: string[];
}): string {
  const scoring = input.scoringIssues.map(asSentence).join(" ");
  const clarification = input.clarifications.map(asSentence).join(" ");
  const core =
    input.recallResult === "correct"
      ? "Correct. You recovered the Recall Target."
      : input.recallResult === "partial"
        ? `Partial. You recovered part of the Recall Target, but ${scoring}`
        : `Incorrect. Your answer did not recover the Recall Target. ${scoring}`;
  return clarification
    ? `${core} For precision only, this does not affect your Recall Result: ${clarification}`
    : core;
}

export function reconcileRecallEvaluation(input: {
  prompt: string;
  result: RecallEvaluationResult;
}): NormalizedRecallEvaluation {
  const coveredPoints = uniquePoints(input.result.coveredPoints);
  const originalScoringIssues = uniquePoints(input.result.scoringIssues);
  const originalClarifications = uniquePoints(input.result.clarifications);
  if (
    input.result.recallResult !== "correct" &&
    originalScoringIssues.length === 0
  ) {
    throw new Error(
      "Evaluation returned a failed Recall Result without a scoring issue.",
    );
  }
  const representationIsRequired = promptRequiresRepresentation(input.prompt);
  const presentationOnlyIssues = representationIsRequired
    ? []
    : originalScoringIssues.filter(isPresentationOnlyPoint);
  const scoringIssues = representationIsRequired
    ? originalScoringIssues
    : originalScoringIssues.filter((point) => !isPresentationOnlyPoint(point));
  const clarifications = uniquePoints([
    ...originalClarifications,
    ...presentationOnlyIssues,
  ]);

  let recallResult = input.result.recallResult;
  if (scoringIssues.length === 0) {
    recallResult = "correct";
  } else if (recallResult === "correct") {
    recallResult = coveredPoints.length > 0 ? "partial" : "incorrect";
  } else if (recallResult === "partial" && coveredPoints.length === 0) {
    recallResult = "incorrect";
  }

  const normalized = {
    recallResult,
    coveredPoints,
    scoringIssues,
    clarifications,
    confidence: input.result.confidence,
  };
  return {
    ...normalized,
    feedback: composeRecallFeedback(normalized),
  };
}

export async function evaluateRecallWithRetries(input: {
  prompt: string;
  evaluate(): Promise<RecallEvaluationResult>;
  attempts?: number;
  minimumConfidence?: number;
}): Promise<NormalizedRecallEvaluation> {
  const attempts = Math.max(1, input.attempts ?? 3);
  const minimumConfidence = input.minimumConfidence ?? 0.55;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = reconcileRecallEvaluation({
        prompt: input.prompt,
        result: await input.evaluate(),
      });
      if (result.confidence < minimumConfidence) {
        throw new Error(
          "The evaluator was not confident enough to classify recall.",
        );
      }
      return result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Evaluation failed after automatic retries.");
}

export function deriveAnswerGrades(results: V2RecallResult[]): V2Grade[] {
  let correctStreak = 0;
  let previousWasFailed = false;
  return results.map((result) => {
    if (result !== "correct") {
      correctStreak = 0;
      previousWasFailed = true;
      return "again";
    }

    correctStreak += 1;
    const grade = previousWasFailed
      ? "hard"
      : correctStreak >= 3
        ? "easy"
        : "good";
    previousWasFailed = false;
    return grade;
  });
}

export function legacyGradeToRecallResult(grade: V2Grade): V2RecallResult {
  if (grade === "again") return "incorrect";
  if (grade === "hard") return "partial";
  return "correct";
}
