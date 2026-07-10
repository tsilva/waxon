export const BROWSER_SMOKE_CORRECT_TOKEN = "browser-smoke-correct-token";

export const BROWSER_SMOKE_QUESTIONS = [
  {
    question:
      "Browser smoke correct card: what exact token proves this answer is correct?",
    conciseAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
  {
    question:
      "Browser smoke incorrect card: what exact token is intentionally omitted?",
    conciseAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
] as const;

export function isBrowserSmokeQuestion(question: string): boolean {
  return BROWSER_SMOKE_QUESTIONS.some(
    (fixture) => fixture.question === question,
  );
}
