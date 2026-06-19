---
status: verified
updated: 2026-06-18
source:
  - data/questions.csv
  - app/lib/postgresStore.ts
---

# Legacy Question Seed

The user knowledge base can be seeded from `data/questions.csv` through `ensureSeedData()` in `app/lib/postgresStore.ts` when a user has zero questions. The seed import inserts only `question`, `questionSlug`, `reviews`, and `nextDue`; `generated_from_question`, `question_provenance`, and `concise_answer` are not populated from the CSV.

When investigating bad or flagged seeded cards, check `data/questions.csv` and Git history before assuming they came from current LLM generation. In one verified case, 156 cards shared the same live `created_at` timestamp because they were imported from the legacy CSV seed in one batch.
