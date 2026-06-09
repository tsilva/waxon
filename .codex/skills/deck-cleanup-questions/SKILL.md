---
name: deck-cleanup-questions
description: Conservatively audit waxon deck questions against the shared question-quality guide, propose exact-meaning improvements for notation formatting, concision, atomicity, precision, readability, and self-containedness, then atomically update their OpenRouter google/gemini-embedding-2 embeddings. Use when the user asks to run /deck-cleanup-questions, clean up, format, shorten, make concise, compress, simplify, or maintain deck question wording without changing meaning.
---

# Deck Cleanup Questions

## Workflow

Run from the repo root.

1. Confirm the exact deck before reviewing.

   If the user provided a deck id, use it explicitly in every command. If the user gave a deck name, card count, screenshot, or other ambiguous reference, do a read-only deck/count check first and identify the intended deck id before listing questions. Do not rely on the default `deep-learning` deck when another deck could match the user's request.

2. List the exact deck questions and confirm the count matches the intended deck. Save the raw output to `/tmp` for local parsing so command truncation does not hide rows.

```bash
npm run deck:cleanup-questions -- --json
```

   For a non-default deck:

```bash
npm run deck:cleanup-questions -- --deck-id <deck-id> --json
```

3. Review questions directly as Codex. Do not use another LLM to decide cleanups.

   Review every listed question against the shared reference at [reference/question-quality.md](../../../reference/question-quality.md), not just long or obviously repetitive questions. The quality guide is the discovery standard; the validator is only a final safety check.

   For fastest throughput and lowest token usage:

   - Parse the saved JSON locally and review compact rows containing `index`, `roughTokens`, and `question`; avoid pasting full JSON back into context.
   - Make one full pass over all questions, but split discovery into deterministic queues so short formatting problems are not skipped:
     - **Notation formatting queue:** all questions with dense technical notation that is not already Markdown-formatted, including shapes such as `B×n`, `m×n`, `n×p`, `Wx`, `AB`, bare variables in formulas, derivatives, Greek letters, subscripts/superscripts, dimensions, probability expressions, and named API/code literals.
     - **Quality queue:** questions that may violate concision, atomicity, precision, readability, or self-containedness even if they are short.
     - **Concision queue:** longer or repetitive questions where exact-meaning shortening may save more than `5` rough content tokens.
   - For decks of a few hundred questions, inspect all questions in one local parse and keep only candidate rows in model context. For larger decks, page in stable chunks with `--limit` and `--offset`, tracking reviewed index ranges.
   - Do not let `roughTokens` thresholds decide which questions receive a quality review. Use token counts only after a candidate is identified.

4. Propose a rewrite only when the cleaned question means exactly the same thing and is at least as easy to understand under the shared reference. Bias strongly toward no change unless the question is made more compliant with the guide.

   Consider all compliant improvement types before filtering:

   - **Notation formatting:** format unformatted mathematical variables, shapes, equations, formulas, and dense notation with inline math, and code/API/literal expressions with backticks. Preserve visible notation when possible; for example, prefer `$B×n$` over `B×n` when the goal is Markdown formatting only.
   - **Concision:** remove redundant wording only when the recall target, answer semantics, examples, scope, and expected detail stay exactly the same.
   - **Atomicity:** keep the question focused on the same single recall target. Do not split or merge questions during cleanup.
   - **Precision:** clarify wording only when it removes ambiguity without changing the expected answer.
   - **Readability:** improve structure, punctuation, or Markdown when it makes the same question easier to parse.
   - **Self-containedness:** add or preserve needed context only when it is already implicit in the original question and does not broaden the answer.

5. Write a changes JSON file in `/tmp`:

```json
{
  "changes": [
    {
      "oldQuestion": "Original question text",
      "newQuestion": "Shorter equivalent question text",
      "rationale": "Removed redundant wording without changing scope."
    }
  ]
}
```

6. Before applying, locally validate that every proposed cleanup either changes Markdown formatting while not increasing rough content tokens, or saves more than `5` rough content tokens. Discard cleanups that do not change formatting and save `5` or fewer rough content tokens. The count ignores Markdown syntax, so adding formatting markers is allowed when content tokens do not increase. Fix or remove any candidate that fails this check.

```bash
npm run deck:cleanup-questions -- --validate-changes --changes /tmp/waxon-cleanup-question-changes.json
```

   Include `--deck-id <deck-id>` whenever the deck is not the default.

7. Always show the user a Markdown approval table before applying. Include at least: old question, new question, old rough content tokens, new rough content tokens, and content tokens saved. Do not run `--apply` until the user explicitly approves the displayed changes.

```bash
npm run deck:cleanup-questions -- --approval-table --changes /tmp/waxon-cleanup-question-changes.json
```

8. After approval, apply in one atomic pass:

```bash
npm run deck:cleanup-questions -- --apply --changes /tmp/waxon-cleanup-question-changes.json
```

The apply step bulk-fetches embeddings for all new question texts with OpenRouter `google/gemini-embedding-2`, then updates question rows, references, attempts, and embeddings in one transaction. If embedding generation or validation fails, no database rows are changed.

## Options

- `--deck-id deep-learning`: deck to process. Defaults to `deep-learning`.
- `--embedding-model google/gemini-embedding-2`: OpenRouter embedding model. Defaults to `google/gemini-embedding-2`.
- `--batch-size 32`: embedding request batch size.
- `--limit <n>` and `--offset <n>`: page through questions during review.
- `--json`: print machine-readable questions for review.
- `--apply --changes <path>`: apply approved cleanups.
- `--validate-changes --changes <path>`: validate proposed cleanups against active deck questions without applying.
- `--approval-table --changes <path>`: print the approval table after validating proposed cleanups.

## Rewrite Rules

- Preserve exact answer semantics, scope, constraints, examples, and expected level of detail.
- Preserve existing Markdown formatting unless the underlying text genuinely needs to change. Do not remove Markdown formatting merely to reduce raw token count.
- Follow the shared question-quality reference. Formatting markers are not part of the concision target; concision applies to the visible question text.
- Check all questions for quality-guide compliance before deciding candidates. Do not skip short questions; short questions can still need notation formatting or precision cleanup.
- Do not merge multiple questions, split questions, add new requirements, or change recall target.
- Formatting cleanup is allowed when Markdown improves readability and rough content tokens do not increase.
- Otherwise, the new question must save more than `5` rough content tokens. Discard wording-only cleanups that save `5` or fewer tokens.
- If uncertain, omit the question from the changes file.

## Required Environment

- `DATABASE_URL_UNPOOLED` or `DATABASE_URL`
- `OPENROUTER_API_KEY` or `LLM_API_KEY` for `--apply`
