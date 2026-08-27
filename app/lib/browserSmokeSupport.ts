import {
  browserAcceptanceTestLearner,
} from "@/app/lib/localTestAuth";

export const BROWSER_SMOKE_CORRECT_TOKEN = "browser-smoke-correct-token";

export const BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT =
  "Issue 20 Question Bank journey: what makes a Question replacement immutable?";

export const BROWSER_SMOKE_TIMEZONE_QUESTION = {
  prompt:
    "Issue 20 Local Day boundary: which token proves timezone queue recomputation?",
  referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
} as const;

export const BROWSER_SMOKE_QUESTIONS = [
  {
    prompt:
      "Issue 20 Review 1: which token proves same-day Again re-queueing?",
    referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
  {
    prompt:
      "Issue 20 Review 2: which token proves generic evaluation feedback?",
    referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
  {
    prompt:
      "Issue 20 Review 3: which token proves Answer Grade correction?",
    referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
  {
    prompt:
      "Issue 20 Review 4: which token identifies the detailed Flag modal fixture?",
    referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
  {
    prompt:
      "Issue 20 Review 5: which token identifies the empty Flag modal fixture?",
    referenceAnswer: BROWSER_SMOKE_CORRECT_TOKEN,
  },
] as const;

export const BROWSER_SMOKE_ISOLATION_LEARNER = {
  id: "issue-20-browser-isolation-learner",
  displayName: "Issue 20 isolation learner",
  email: "issue-20-isolation@waxon.invalid",
} as const;

export const BROWSER_SMOKE_ISOLATION_QUESTION = {
  prompt:
    "Issue 20 isolation probe: which Question belongs only to the other Learner?",
  referenceAnswer:
    "This Question must never appear in the local Learner's Question Bank.",
} as const;

export function isBrowserSmokeQuestion(prompt: string): boolean {
  return (
    prompt === BROWSER_SMOKE_QUESTION_BANK_QUESTION_PROMPT ||
    prompt === BROWSER_SMOKE_TIMEZONE_QUESTION.prompt ||
    BROWSER_SMOKE_QUESTIONS.some((fixture) => fixture.prompt === prompt)
  );
}

export function shouldUseBrowserAcceptanceEvaluator(input: {
  learnerId: string;
  prompt: string;
}): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.WAXON_ENABLE_BROWSER_SMOKE_SUPPORT === "1" &&
    process.env.WAXON_BROWSER_SMOKE_EVALUATOR === "1" &&
    input.learnerId === browserAcceptanceTestLearner.id &&
    isBrowserSmokeQuestion(input.prompt)
  );
}
