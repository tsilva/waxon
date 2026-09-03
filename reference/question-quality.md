# Question Quality Standard

This is the authoritative scoped specification for Question quality. Its normative requirements are stakeholder intent and may change only with explicit stakeholder approval. Root [SPECS.md](../SPECS.md) owns the project-wide quality invariant and the lifecycle consequences of passing or failing it.

Use this standard whenever a learner or authorized MCP client creates, cleans up, deduplicates, or submits a Question candidate, and whenever Waxon assesses whether a Question may be Active.

## Active eligibility

An Active Question must:

- be atomic by testing one Recall Target;
- be self-contained, with the Prompt providing the context required to identify the Recall Target;
- be recall-oriented without leading the learner or revealing the answer; and
- be answerable from its stored Answer Standard.

A candidate that lacks a usable Prompt, Answer Standard, or Recall Target is structurally unusable. Root [SPECS.md](../SPECS.md) defines whether structurally valid quality failures are Flagged and structurally unusable candidates are rejected.

## Authoring guidance

An optimal Question is concise, precise, readable, and complete. Include only context that changes the answer; omit boilerplate, source labels, broad topic labels, and hints. Preserve important terms, constraints, examples, notation, names, dates, places, and expected detail.

Use Markdown formatting when it improves readability. Format mathematical variables, shapes, equations, and formulas as inline math with `$...$`; for example: `If $A$ has shape $m \times n$ and $B$ has shape $n \times p$, what is the shape of $AB$?` Format code, commands, API names, and literal strings with backticks. Do not leave dense technical notation as plain prose when Markdown or formula formatting would make the target clearer.

## Gap-targeted candidates

When a learner or authorized MCP client explicitly submits a candidate intended to target a known gap, keep it limited to that gap, misconception, missing step, or confusion. Do not broaden it to already-covered, prerequisite, adjacent, or boundary-case targets, and do not reveal the correction or turn the Question into a hint.

## Cleanup and deduplication

Prefer the version that best satisfies this standard while preserving the same answer semantics, scope, and difficulty.
