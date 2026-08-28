import type { V2Grade } from "./types.ts";

export type RecallEvaluationResult = {
  grade: V2Grade;
  feedback: string;
  expectedAnswer: string;
  coveredPoints: string[];
  missingPoints: string[];
  demonstratedGap: string | null;
  confidence: number;
  presentationDifferences?: string[];
};

export const RECALL_EVALUATION_SYSTEM_PROMPT =
  "Evaluate free recall directly from the Prompt, stored Answer Standard, and Learner Answer without classifying the Question by answer mode. Judge the recovered knowledge, not its surface representation. A Learner Answer can use accurate prose, mathematical notation, pseudocode, or executable code. Treat these representations as equivalent when they express the same required knowledge. Infer the required knowledge from the Prompt and Answer Standard. Put only missing knowledge in missingPoints. Put non-scoring differences in notation, format, or representation in presentationDifferences, never in missingPoints. Representation itself is required only when the Prompt explicitly requires that representation, such as exact syntax, mathematical notation, spelling, quotation, executable code, or an identifier whose characters determine correctness. Keep the result internally consistent: demonstratedGap must be null when missingPoints is empty, and it must describe the missing knowledge when missingPoints is not empty. Return JSON only with grade (again|hard|good|easy), feedback, expectedAnswer, coveredPoints, missingPoints, presentationDifferences, demonstratedGap, confidence. Use again for forgotten or substantially wrong, hard for fragile or partial recall, good for correct recall with minor omissions, and easy only for complete effortless recall. Never reward fluent unsupported claims.";

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

function saysThereIsNoGap(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\bno\s+(?:demonstrated\s+|knowledge\s+|meaningful\s+)?gap\b/u.test(
    normalized,
  );
}

function gapFromMissingPoints(missingPoints: string[]): string {
  return `The Learner Answer did not demonstrate: ${missingPoints.join("; ")}.`;
}

export function reconcileRecallEvaluation(input: {
  prompt: string;
  result: RecallEvaluationResult;
}): RecallEvaluationResult {
  const coveredPoints = uniquePoints(input.result.coveredPoints);
  const originalMissingPoints = uniquePoints(input.result.missingPoints);
  const representationIsRequired = promptRequiresRepresentation(input.prompt);
  const missingPoints = representationIsRequired
    ? originalMissingPoints
    : originalMissingPoints.filter(
        (point) => !isPresentationOnlyPoint(point),
      );
  const removedOnlyPresentationDifferences =
    originalMissingPoints.length > 0 &&
    missingPoints.length === 0 &&
    originalMissingPoints.every(isPresentationOnlyPoint);
  const grade =
    removedOnlyPresentationDifferences &&
    coveredPoints.length > 0 &&
    (input.result.grade === "again" || input.result.grade === "hard")
      ? "good"
      : input.result.grade;
  const statedGap = input.result.demonstratedGap?.trim() || null;
  const demonstratedGap =
    missingPoints.length === 0
      ? null
      : !statedGap || saysThereIsNoGap(statedGap)
        ? gapFromMissingPoints(missingPoints)
        : statedGap;

  return {
    ...input.result,
    grade,
    coveredPoints,
    missingPoints,
    demonstratedGap,
    presentationDifferences: uniquePoints(
      input.result.presentationDifferences ?? [],
    ),
  };
}
