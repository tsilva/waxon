# Question Quality

Use this reference whenever creating, cleaning up, deduplicating, or generating knowledge-base questions and probing questions.

An optimal question is concise, atomic, self-contained within the user's knowledge base, recall-oriented, precise, readable, and complete. Include only context that changes the answer; omit boilerplate, source labels, broad topic labels, and hints. Preserve important terms, constraints, examples, notation, names, dates, places, and expected detail.

Use Markdown formatting when it improves readability. Format mathematical variables, shapes, equations, and formulas as inline math with `$...$`; for example: `If $A$ has shape $m \times n$ and $B$ has shape $n \times p$, what is the shape of $AB$?` Format code, commands, API names, and literal strings with backticks. Do not leave dense technical notation as plain prose when Markdown or formula formatting would make the target clearer.

For probing questions generated after a weak answer, also follow these rules:

Generate only for a gap, misconception, missing step, or confusion directly shown by the user's answer. Do not ask already-covered, prerequisite, adjacent, or boundary-case targets unless the answer shows that exact gap. Do not reveal the correction or turn the question into a hint.

For cleanup or dedupe work, prefer the version that best satisfies this reference while preserving the same answer semantics, scope, and difficulty.
