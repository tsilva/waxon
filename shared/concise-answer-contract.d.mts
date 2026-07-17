export const MAX_CONCISE_ANSWER_CHARS: number;

export type ConciseAnswerQuestion = {
  id: string;
  question: string;
};

export type ConciseAnswerResult = ConciseAnswerQuestion & {
  conciseAnswer: string;
};

export function buildConciseAnswerRequest(input: {
  model: string;
  questions: ConciseAnswerQuestion[];
}): {
  model: string;
  response_format: { type: "json_object" };
  temperature: number;
  max_tokens: number;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
};

export function parseConciseAnswerResults(
  questions: ConciseAnswerQuestion[],
  responseText: string,
): ConciseAnswerResult[];
