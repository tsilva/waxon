---
name: deck-dedupe
description: Deduplicate waxon deck questions using saved embeddings plus native Codex judgment. Use when the user asks to find, review, merge, trash, remove, or dedupe duplicate flashcard/deck questions in this project without calling an external LLM judge.
---

# Dedupe Deck

## Workflow

Run from the repo root.

1. Generate close-pair candidates from saved embeddings:

```bash
npm run deck:dedupe -- --json
```

2. Review the candidate pairs directly as Codex. Do not call OpenRouter or any external LLM to judge duplicates.

3. Decide duplicates only when answering one question makes the other redundant. Keep contrast pairs, complementary questions, and different numeric examples unless they are truly redundant.

4. Choose the question to keep by quality using the shared reference at [reference/question-quality.md](../../../reference/question-quality.md).

5. Write a decisions JSON file in `/tmp` or another temporary location:

```json
{
  "decisions": [
    {
      "duplicate": true,
      "keepQuestion": "Question text to keep",
      "discardQuestion": "Question text to move to trash",
      "similarity": 0.9259,
      "rationale": "Kept the version that better follows the shared question-quality reference."
    }
  ]
}
```

6. Apply only after reviewing the proposed decisions:

```bash
npm run deck:dedupe -- --apply --decisions /tmp/waxon-dedupe-decisions.json
```

## Options

- `--deck-id deep-learning`: deck to process. Defaults to `deep-learning`.
- `--embedding-model google/gemini-embedding-2`: embedding model to read. Defaults to `google/gemini-embedding-2`.
- `--embedding-kind dedupe_v1`: embedding kind to read. Defaults to `dedupe_v1`, built from question + concise answer.
- `--source-version 1`: dedupe embedding source format version. Defaults to `1`.
- `--threshold 0.9`: cosine-similarity threshold for candidate pairs.
- `--max-pairs 80`: cap candidate pairs printed for Codex review.
- `--json`: print machine-readable candidates for easier review.
- `--apply --decisions <path>`: move duplicate discards into `questions_trash` and delete them from `questions`.

## Safety Rules

- Always generate candidates first; never apply without reviewing the pairs.
- Do not treat high embedding similarity alone as a duplicate.
- Do not discard both sides of a pair.
- If a question appears in multiple duplicate decisions, keep one canonical question and discard each duplicate at most once.
- If uncertain, keep both.

## Trash Table

The script manages `questions_trash`. It stores every column from `questions` plus:

- `trashed_at`
- `duplicate_of_question`
- `duplicate_similarity`
- `duplicate_embedding_model`
- `duplicate_judge_model` set to `codex-agent-native`
- `duplicate_rationale`

This table is an admin trash collection, not part of the app UI.
