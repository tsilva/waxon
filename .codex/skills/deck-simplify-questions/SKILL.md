---
name: deck-simplify-questions
description: Conservatively simplify waxon deck questions to shorter equivalent wording and atomically update their OpenRouter google/gemini-embedding-2 embeddings. Use when the user asks to run /deck-simplify-questions, shorten, make concise, compress, simplify, or maintain deck question wording without changing meaning.
---

# Deck Simplify Questions

## Workflow

Run from the repo root.

1. List deck questions:

```bash
npm run deck:simplify-questions -- --json
```

2. Review questions directly as Codex. Do not use another LLM to decide rewrites.

3. Rewrite only when the shorter question means exactly the same thing and is at least as easy to understand. Bias strongly toward no change.

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

5. Before applying, locally validate that every proposed rewrite is shorter by the same rough token-count rule used by the script. Fix or remove any candidate that fails this check.

```bash
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync("/tmp/waxon-simplify-question-changes.json","utf8")); const changes=Array.isArray(data)?data:data.changes; const count=s=>(s.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g)||[]).length; let ok=true; for (const c of changes){ const old=count(c.oldQuestion), neu=count(c.newQuestion); if (neu>=old){ ok=false; console.log(`${old}->${neu} NOT SHORTER: ${c.oldQuestion}\n  => ${c.newQuestion}`); } } console.log(`${changes.length} changes checked; ${ok ? "all shorter" : "some not shorter"}`); process.exit(ok?0:1)'
```

6. Always show the user a Markdown approval table before applying. Include at least: old question, new question, old rough tokens, new rough tokens, and tokens saved. Do not run `--apply` until the user explicitly approves the displayed changes.

7. After approval, apply in one atomic pass:

```bash
npm run deck:simplify-questions -- --apply --changes /tmp/waxon-simplify-question-changes.json
```

The apply step bulk-fetches embeddings for all new question texts with OpenRouter `google/gemini-embedding-2`, then updates question rows, references, attempts, and embeddings in one transaction. If embedding generation or validation fails, no database rows are changed.

## Options

- `--deck-id deep-learning`: deck to process. Defaults to `deep-learning`.
- `--embedding-model google/gemini-embedding-2`: OpenRouter embedding model. Defaults to `google/gemini-embedding-2`.
- `--batch-size 32`: embedding request batch size.
- `--limit <n>` and `--offset <n>`: page through questions during review.
- `--json`: print machine-readable questions for review.
- `--apply --changes <path>`: apply approved rewrites.

## Rewrite Rules

- Preserve exact answer semantics, scope, constraints, examples, and expected level of detail.
- Keep technical terms when removing them would make the question broader or ambiguous.
- Do not merge multiple questions, split questions, add new requirements, or change recall target.
- Do not rewrite just for style. The new question must be shorter by the script's rough token count.
- If uncertain, omit the question from the changes file.

## Required Environment

- `DATABASE_URL_UNPOOLED` or `DATABASE_URL`
- `OPENROUTER_API_KEY` or `LLM_API_KEY` for `--apply`
