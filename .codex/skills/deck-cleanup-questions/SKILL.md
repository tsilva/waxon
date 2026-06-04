---
name: deck-cleanup-questions
description: Conservatively clean up waxon deck questions with shorter equivalent wording and useful Markdown formatting, then atomically update their OpenRouter google/gemini-embedding-2 embeddings. Use when the user asks to run /deck-cleanup-questions, clean up, format, shorten, make concise, compress, simplify, or maintain deck question wording without changing meaning.
---

# Deck Cleanup Questions

## Workflow

Run from the repo root.

1. List deck questions:

```bash
npm run deck:cleanup-questions -- --json
```

2. Review questions directly as Codex. Do not use another LLM to decide cleanups.

3. Rewrite only when the cleaned question means exactly the same thing and is at least as easy to understand under the shared reference at [reference/question-quality.md](../../../reference/question-quality.md). Prefer shorter wording when possible. Bias strongly toward no change.

   Format unformatted technical expressions when doing so improves readability. For this deck, bare math/code expressions such as `exp(x)`, `exp(1)`, and `e` should be formatted consistently instead of left as plain prose.

4. Write a changes JSON file in `/tmp`:

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

5. Before applying, locally validate that every proposed cleanup either changes Markdown formatting while not increasing rough content tokens, or saves more than `5` rough content tokens. Discard cleanups that do not change formatting and save `5` or fewer rough content tokens. The count ignores Markdown syntax, so adding formatting markers is allowed even when it increases the raw token count. Fix or remove any candidate that fails this check.

```bash
npm run deck:cleanup-questions -- --validate-changes --changes /tmp/waxon-cleanup-question-changes.json
```

6. Always show the user a Markdown approval table before applying. Include at least: old question, new question, old rough content tokens, new rough content tokens, and content tokens saved. Do not run `--apply` until the user explicitly approves the displayed changes.

```bash
npm run deck:cleanup-questions -- --approval-table --changes /tmp/waxon-cleanup-question-changes.json
```

7. After approval, apply in one atomic pass:

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
- Do not merge multiple questions, split questions, add new requirements, or change recall target.
- Formatting cleanup is allowed when Markdown improves readability and rough content tokens do not increase.
- Otherwise, the new question must save more than `5` rough content tokens. Discard wording-only cleanups that save `5` or fewer tokens.
- If uncertain, omit the question from the changes file.

## Required Environment

- `DATABASE_URL_UNPOOLED` or `DATABASE_URL`
- `OPENROUTER_API_KEY` or `LLM_API_KEY` for `--apply`
