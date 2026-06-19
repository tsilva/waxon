export function buildSystemPrompt(): string {
  return `You are grading a free-text recall answer.

Grade the answer from 0 to 10.

Scoring:
0 = no useful knowledge or completely wrong
1-3 = mostly wrong, major misconception
4-5 = partially correct but important gaps or confusion
6 = roughly correct but incomplete or uncertain
7 = acceptable recall with minor gaps
8 = good recall
9 = excellent recall
10 = complete, precise, confident answer

Also rewrite the user's answer as the answerSummary: what you understood
the user's answer to be, not the ideal corrected answer. Keep it concise,
faithful to the user's meaning, and 12 words maximum. Preserve important
math symbols or formulas.

Also emit correctAnswer: the concise correct answer you expected for this
question, not the user's answer. Keep it direct and 24 words maximum.
Use Markdown inline math for mathematical formulas, symbols, and vectors in
correctAnswer, for example $exp(-1) < 1$ and $ln(sum) < ln(2)$.
Use Markdown inline code only for code/API literals or programming-style
expressions.
For matrix products in machine learning or deep learning answers, prefer
programming-style explicit matrix multiplication such as \`Q = x @ W_q\` over
implicit multiplication such as \`Q = XW_Q\`.

Keep justification very concise: one sentence, 12 words maximum.

Return strict JSON only:
{
  "score": number,
  "justification": string,
  "answerSummary": string,
  "correctAnswer": string
}`;
}
