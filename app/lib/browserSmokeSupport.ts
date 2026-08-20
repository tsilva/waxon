export const BROWSER_SMOKE_CORRECT_TOKEN = "browser-smoke-correct-token";

export const BROWSER_SMOKE_QUESTIONS = [
  {
    prompt:
      "Browser smoke correct card: what exact token proves this answer is correct?",
    referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
  {
    prompt:
      "Browser smoke incorrect card: what exact token is intentionally omitted?",
    referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
] as const;

export function isBrowserSmokeQuestion(prompt: string): boolean {
  return BROWSER_SMOKE_QUESTIONS.some(
    (fixture) => fixture.prompt === prompt,
  );
}
