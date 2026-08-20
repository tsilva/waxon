# Question-search rollout

Waxon uses deterministic normalized-prompt lookup first, then weighted PostgreSQL full-text search and prompt trigrams. MCP semantic retrieval adds one batched, 512-dimensional `openai/text-embedding-3-small` request through OpenRouter and fuses ranks with unweighted RRF (`k = 60`). It does not use a cross-encoder, generative judge, sparse model, or approximate vector index.

Question adds and edits enqueue `embed_question_batch` work after committing their canonical records. Provider or workflow failures never roll back a valid question. Search reports `lexical_fallback` and conservative `search_incomplete` advice when complete semantic coverage is unavailable. Only normalized exact matches produce `exact_duplicate`.

## Deploy and backfill

1. Apply `drizzle-v2/0012_question_search.sql`. It enables `pg_trgm`, replaces the unused prompt-only FTS index with a weighted current-version prompt/answer index, adds the current-prompt trigram index and all-lifecycle target-key index, and creates the prompt-only `halfvec(512)` table. Vercel production builds apply pending migrations and the idempotent legacy prompt-key repair before compiling, and stop the deployment if either step fails; preview and local builds do not mutate a database.
2. Keep `WAXON_QUESTION_SEARCH_MODE=lexical` (the default) while the migration settles.
3. Inspect the repair scope without inference calls: `keyenv run -- pnpm question-search:backfill`.
4. Run the resumable mutation explicitly: `keyenv run -- pnpm question-search:backfill -- --confirm`. Batches never exceed 50; reruns skip current model/version rows.
5. Set `WAXON_QUESTION_SEARCH_MODE=shadow` to compute semantic candidates without returning them. Shadow logs contain only counts, overlap, latency, and coverage—not prompts, answers, or question IDs.
6. Score held-out retrieval output and choose a threshold. Hybrid results remain disabled until both `WAXON_QUESTION_SEARCH_MODE=hybrid` and `WAXON_QUESTION_SEARCH_SEMANTIC_THRESHOLD=<calibrated -1..1 value>` are set.

`QUESTION_SEARCH_EMBEDDING_MODEL` can override the fixed default for a measured migration experiment. Model and source version are stored with every vector, so switching models requires a separate backfill rather than silently mixing vector spaces.

## Evaluation gate

`pnpm question-search:evaluate` describes the checked-in 120-case fixture. Supply retrieval output as `--results=/path/results.json`, where each item is `{ "caseId": "...", "rank": 1, "advisory": "review_similar" }`. The scorer requires:

- all cases present;
- same-target recall@10 of at least 98% overall;
- recall@10 of at least 95% in every critical same-target stratum;
- 100% precision for `exact_duplicate` advice.

Keep semantic matches advisory even after those gates. Do not enable a semantic “do not add” decision without a separately held-out result showing at least 99% precision.

## Performance gate

Run the read-only benchmark against representative learners at roughly 1k, 10k, and 100k questions:

```bash
keyenv run -- pnpm question-search:benchmark -- --user-id=<id> --iterations=50
keyenv run -- pnpm question-search:benchmark -- --user-id=<id> --iterations=20 --include-hybrid
```

`--include-hybrid` invokes OpenRouter and incurs the reported provider cost. Add `--explain` only when query-plan detail is needed. The initial gates are lexical p95 below 50 ms and hybrid p95 below 750 ms including the network. Target warm hybrid p95 below 300 ms. If exact per-user vector search misses the gate at 100k, keep hybrid off and evaluate HNSW against exact recall before adding an approximate index.
