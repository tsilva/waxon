export type LearnQuestionEvaluationSnippet = {
  content: string;
  questionId: string | null;
  question: string | null;
  correctAnswer: string | null;
  score: number;
};

const QUESTION_EVALUATION_SNIPPET_PATTERN =
  /^<!--\s*waxon:evaluation-snippet score=(\d{1,2})\s*-->\s*/u;
const QUESTION_EVALUATION_METADATA_COMMENT_PATTERN =
  /<!--\s*waxon:evaluation-(question-id|question|correct-answer)\s+([\s\S]*?)\s*-->\s*/gu;
const QUESTION_EVALUATION_SCORE_LINE_PATTERN =
  /^(?:\*\*)?Score\s+\d{1,2}\s*\/\s*10(?:\*\*)?$/iu;

function decodeEvaluationMetadata(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const encodedValue = value.trim().replace(/\s+/g, "");

  if (!encodedValue) {
    return null;
  }

  try {
    return decodeURIComponent(encodedValue).trim() || null;
  } catch {
    return null;
  }
}

function inferCorrectAnswerFromFeedback(
  feedback: string,
  score: number,
): string | null {
  if (score < 9) {
    return null;
  }

  const normalized = feedback.trim().replace(/\s+/g, " ");

  if (!normalized) {
    return null;
  }

  const withoutCorrectLead = normalized
    .replace(/^(?:correct|right|yes)[.!]?\s+/iu, "")
    .replace(/^that's\s+(?:correct|right)[.!]?\s+/iu, "")
    .trim();

  return withoutCorrectLead && withoutCorrectLead !== normalized
    ? withoutCorrectLead
    : null;
}

export function isQuestionEvaluationSnippet(content: string): boolean {
  return QUESTION_EVALUATION_SNIPPET_PATTERN.test(content);
}

export function parseQuestionEvaluationSnippet(
  content: string,
): LearnQuestionEvaluationSnippet | null {
  const match = content.match(QUESTION_EVALUATION_SNIPPET_PATTERN);

  if (!match) {
    return null;
  }

  const score = Number.parseInt(match[1] ?? "", 10);

  if (!Number.isFinite(score)) {
    return null;
  }

  const normalizedScore = Math.max(0, Math.min(10, score));
  const metadata = {
    questionId: null as string | null,
    question: null as string | null,
    correctAnswer: null as string | null,
  };
  const withoutScoreComment = content.replace(
    QUESTION_EVALUATION_SNIPPET_PATTERN,
    "",
  );
  const withoutMetadataComments = withoutScoreComment.replace(
    QUESTION_EVALUATION_METADATA_COMMENT_PATTERN,
    (_comment, kind: string, value: string) => {
      const decoded = decodeEvaluationMetadata(value);

      if (kind === "question-id" && !metadata.questionId) {
        metadata.questionId = decoded;
      }

      if (kind === "question" && !metadata.question) {
        metadata.question = decoded;
      }

      if (kind === "correct-answer" && !metadata.correctAnswer) {
        metadata.correctAnswer = decoded;
      }

      return "";
    },
  );

  const bodyBlocks = withoutMetadataComments
    .trim()
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(
      (block) => block && !QUESTION_EVALUATION_SCORE_LINE_PATTERN.test(block),
    );
  const [firstBlock = "", ...remainingBlocks] = bodyBlocks;
  const firstLine = firstBlock.replace(/^#{1,6}\s+/u, "").trim();
  const firstLineIsTitle =
    firstLine.length > 0 &&
    firstLine.length <= 80 &&
    remainingBlocks.length > 0 &&
    !/[.!?]\s*$/u.test(firstLine);
  const question = metadata.question ?? (firstLineIsTitle ? firstLine : null);
  const body = bodyBlocks.join("\n\n").trim();
  const feedback = firstLineIsTitle ? remainingBlocks.join("\n\n").trim() : body;
  const visibleFeedback = feedback || body || "Evaluation recorded.";

  return {
    content: visibleFeedback,
    questionId: metadata.questionId,
    question,
    correctAnswer:
      metadata.correctAnswer ??
      inferCorrectAnswerFromFeedback(visibleFeedback, normalizedScore),
    score: normalizedScore,
  };
}
