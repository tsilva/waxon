# Waxon Question Quality

Use this reference whenever creating, cleaning up, deduplicating, or generating deck questions and probing questions.

An optimal waxon question is:

- **Concise:** uses the shortest wording that preserves the full recall target.
- **Single-target:** asks one question instead of combining multiple prompts.
- **Self-describing:** includes enough context to answer without relying on surrounding cards or the original source text.
- **Standalone:** specifies the operation, object, convention, or scenario needed to answer; a learner should not need to infer missing context from the deck, title, answer, or neighboring questions. For example, "For input shape `(batch, in_features)` and weight shape `(in_features, out_features)`, what is the output shape?" is incomplete unless it names the operation, such as matrix multiplication or a linear layer.
- **Recall-oriented:** asks for the learner to retrieve knowledge from memory rather than recognize a hint.
- **Precise:** preserves important technical terms, constraints, examples, notation, and expected detail.
- **Readable:** uses Markdown, code formatting, or math notation when that makes the question easier to parse.
- **Non-fragmentary:** is a complete question, not a title, topic label, or vague fragment.

For probing questions generated after a weak answer, also follow these rules:

- Generate a probing question only for a gap, misconception, missing step, or confusion that the user's answer directly demonstrates.
- Do not generate a probing question for a recall target already covered by the current deck.
- Do not add prerequisite, adjacent, or boundary-case questions unless the user's answer specifically shows that uncovered gap.
- Test the specific misconception, missing step, or confusion shown in the answer.
- Do not reveal the corrected answer.
- Do not turn the question into a hint.

For cleanup or dedupe work, prefer the version that best satisfies this reference while preserving the same answer semantics, scope, and difficulty.
