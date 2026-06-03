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

3. Rewrite only when the cleaned question means exactly the same thing and is at least as easy to understand. Prefer shorter wording when possible. Also add useful Markdown formatting such as bold, italic, inline code, or math delimiters when it improves readability, even if the visible content-token count stays the same. Bias strongly toward no change.

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
node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync("/tmp/waxon-cleanup-question-changes.json","utf8")); const changes=Array.isArray(data)?data:data.changes; const raw=s=>(s.match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g)||[]).length; const md=s=>s.replace(/!\[([^\]]*)\]\([^)]+\)/g,"$1").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/`{1,3}([^`]+?)`{1,3}/g,"$1").replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,"$2").replace(/(^|[^\w])\*(?=\S)([\s\S]*?\S)\*(?=[^\w]|$)/g,"$1$2").replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?=[^\w]|$)/g,"$1$2").replace(/~~(?=\S)([\s\S]*?\S)~~/g,"$1").replace(/\$\$(?=\S)([\s\S]*?\S)\$\$/g,"$1").replace(/\$(?=\S)([^$\n]*?\S)\$/g,"$1"); const mdSig=s=>(s.match(/!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|`{1,3}[^`]+?`{1,3}|(\*\*|__)(?=\S)[\s\S]*?\S\1|(^|[^\w])\*(?=\S)[\s\S]*?\S\*(?=[^\w]|$)|(^|[^\w])_(?=\S)[\s\S]*?\S_(?=[^\w]|$)|~~(?=\S)[\s\S]*?\S~~|\$\$(?=\S)[\s\S]*?\S\$\$|\$(?=\S)[^$\n]*?\S\$/g)||[]).join("\n"); const hasMd=s=>mdSig(s).length>0; const count=s=>raw(md(s)); let ok=true; for (const c of changes){ const old=count(c.oldQuestion), neu=count(c.newQuestion), changedMd=mdSig(c.oldQuestion)!==mdSig(c.newQuestion), saved=old-neu; if (hasMd(c.oldQuestion)&&!hasMd(c.newQuestion)){ ok=false; console.log(`REMOVES MARKDOWN: ${c.oldQuestion}\n  => ${c.newQuestion}`); } if ((!changedMd && saved<=5) || (changedMd && neu>old) || (changedMd && neu===old && md(c.oldQuestion)!==md(c.newQuestion))){ ok=false; console.log(`${old}->${neu} INVALID LOW-VALUE CLEANUP: ${c.oldQuestion}\n  => ${c.newQuestion}`); } } console.log(`${changes.length} changes checked; ${ok ? "all valid" : "some invalid"}`); process.exit(ok?0:1)'
```

6. Always show the user a Markdown approval table before applying. Include at least: old question, new question, old rough content tokens, new rough content tokens, and content tokens saved. Do not run `--apply` until the user explicitly approves the displayed changes.

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

## Rewrite Rules

- Preserve exact answer semantics, scope, constraints, examples, and expected level of detail.
- Preserve existing Markdown formatting unless the underlying text genuinely needs to change. Do not remove Markdown formatting merely to reduce raw token count.
- Use Markdown formatting for readability when helpful. Formatting markers are not part of the concision target; concision applies to the visible question text.
- Keep technical terms when removing them would make the question broader or ambiguous.
- Do not merge multiple questions, split questions, add new requirements, or change recall target.
- Formatting cleanup is allowed when Markdown improves readability and rough content tokens do not increase.
- Otherwise, the new question must save more than `5` rough content tokens. Discard wording-only cleanups that save `5` or fewer tokens.
- If uncertain, omit the question from the changes file.

## Required Environment

- `DATABASE_URL_UNPOOLED` or `DATABASE_URL`
- `OPENROUTER_API_KEY` or `LLM_API_KEY` for `--apply`
