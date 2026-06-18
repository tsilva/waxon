---
name: fix-flagged-questions
description: Find, audit, fix, and unflag Waxon deck questions that have flagged_at set. Use when the user says /fix-flagged-questions, asks to fix flagged questions, patch flagged cards, clean up flagged deck questions, or investigate why flagged questions are bad. This skill reads live flagged rows, classifies question-quality violations, proposes exact-meaning fixes for approval, then applies approved DB updates with refreshed OpenRouter embeddings.
---

# Fix Flagged Questions

Run from the Waxon repo root.

## Required References

Read these before deciding fixes:

- `.agents/knowledge/index.md`
- `reference/question-quality.md`
- `.agents/knowledge/data/legacy-question-seed.md` when flagged rows have empty provenance or shared seed timestamps.

## Workflow

1. Identify flagged rows in the live database.

   Use the repo-local `.env` / `.env.local` database settings. Query active, unarchived decks and include:

   - question id
   - deck id and name
   - question text
   - concise answer
   - `generated_from_question`
   - `question_provenance`
   - `created_at`, `updated_at`, `flagged_at`
   - current concept tags when useful

   If network sandboxing blocks the read-only DB query, rerun with approval.

2. Determine origin before rewriting.

   - If `generated_from_question` is set, inspect the parent row and related attempts/traces.
   - If `question_provenance` is set, treat it as generator rationale, not a source citation.
   - If provenance is empty and many rows share one `created_at`, check `data/questions.csv` and `git blame` before assuming an LLM generated them.
   - For seed rows, report the CSV line and commit when relevant.

3. Audit directly as Codex.

   Apply `reference/question-quality.md`. Common violations to look for:

   - backward references such as "therefore", "same", or "above"
   - labels or hints such as "sign check", "directed recall", "fill in"
   - dense math/code notation not formatted as Markdown
   - ambiguous contrasts where both options are true
   - scaffolded wording that reveals too much of the solution
   - multi-part questions that should be one recall target

4. Show the user a table before applying.

   Include original question, fixed question, rule violated, and rationale. Do not update the DB until the user explicitly approves the displayed fixes.

5. Apply approved fixes atomically.

   Prefer `scripts/fix-flagged-questions.mjs` for the update. The apply step must:

   - fetch fresh `google/gemini-embedding-2` question-only embeddings from OpenRouter before opening the DB transaction
   - insert replacement question rows with `flagged_at = NULL`
   - preserve reviews, due time, concise/reference answers, provenance, concept tags, course page links, attempts, generated-from links, and old non-current embeddings
   - add one current `question_only` embedding for each replacement row
   - delete the old flagged rows only after dependent rows point to replacements
   - rollback on any error

   This sends question text to OpenRouter. If the user has not already explicitly approved that for this run, request approval before applying.

6. Verify after applying.

   Report:

   - old question rows remaining
   - new question rows present
   - any still flagged
   - current embedding count per new row

## Safety Rules

- Never infer the deck id from the default `deep-learning` slug when live rows show a user-scoped deck id.
- Never use an external LLM to decide the rewrites.
- Preserve answer semantics, scope, examples, and expected difficulty.
- If a fix changes meaning materially, do not apply it as cleanup; ask the user whether they want a replacement card.
- If the repo cleanup validator rejects a legitimate precision/self-containedness fix only because it does not save tokens, explain that and use the transactional script after explicit approval.
