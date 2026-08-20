# Waxon MCP question-search research

Date: 2026-08-20

## Decision in one paragraph

Use a **deterministic exact check followed by hybrid lexical and dense retrieval, fused without a model call**. Keep exact normalized-prompt detection authoritative. Retrieve lexical candidates with PostgreSQL full-text search plus `pg_trgm`, retrieve semantic candidates from a small prompt embedding, and merge the ranked lists with reciprocal rank fusion (RRF). Return the top 5–10 full question/answer pairs, lifecycle, match signals, and a conservative `exact_duplicate | review_similar | no_close_match` advisory to the MCP caller. Do not put a cross-encoder or generative LLM in the default search path: the calling agent is already able to compare the small candidate set. Add one only if a Waxon-specific evaluation set proves that it materially improves duplicate-decision precision or recall within the latency budget.

This is a recommendation, not a claim that one embedding model or threshold is universally best. The model, dimension, fusion weights, and advisory thresholds must be selected on Waxon-labeled question pairs.

## What Waxon has now (repository evidence)

- `search_questions` accepts one query string, delegates to `listLibrary`, and returns only question data; it exposes no relevance, match type, or pre-add advice ([MCP route](../../app/api/mcp/route.ts)).
- `listLibrary` filters with `prompt ILIKE '%query%' OR reference_answer ILIKE '%query%'`, orders by update time rather than relevance, and caps results. There is no fuzzy, semantic, or ranked retrieval in this path ([service](../../app/lib/v2/service.ts)).
- A GIN index on `to_tsvector('simple', prompt)` exists, but the current `ILIKE` query does not use that expression and it does not search the answer ([schema](../../app/db/v2/schema.ts)).
- Exact add deduplication already canonicalizes a prompt with NFKC, locale-independent lowercase, whitespace folding, and SHA-256, and returns `existing` for a matching prompt ([normalization](../../app/lib/v2/questionInput.ts), [add path](../../app/lib/v2/service.ts)). This is the correct hard gate to retain.
- The add path nevertheless reads every question/version in the learner's bank and recomputes prompt hashes in JavaScript, even though `questions.target_key` is already stored and indexed for active questions ([add path](../../app/lib/v2/service.ts), [schema](../../app/db/v2/schema.ts)). At the 100k cap, an exact preflight and add should query target keys directly rather than materialize the whole bank. The index/semantics for inactive lifecycles need to be designed deliberately because the current unique index is partial to active states.
- A learner bank may contain up to 100,000 questions ([service](../../app/lib/v2/service.ts)). Search must therefore be tested at 1k, 10k, and 100k rows per learner, not only on a small development bank.
- An older 3,072-dimensional `question_embeddings` table was intentionally removed during lean-core cleanup ([Stage Two SQL](../lean-core-stage-two.sql)). Reintroducing semantic search should be narrow: current question versions and a single search purpose, with no return to concepts, enrichment, or generated content.
- The prior semantic-dedupe design did considerably more work: surviving prompt artifacts ask one LLM to generate concise answers for embedding and another LLM to judge whether close neighbors share the same atomic recall target ([concise-answer prompt](../../prompts/concise-answer-system.md), [judge prompt](../../prompts/semantic-dedupe-judge-system.md)); migrations show a 3,072-dimensional HNSW dedupe index ([migration](../../drizzle/0005_semantic_dedupe_gate.sql)). This is useful historical evidence about the desired definition, but the lean-core removal is a reason to prove that a simpler retrieval aid is insufficient before restoring that multi-model pipeline.
- The app already calls OpenRouter for answer evaluation ([model adapter](../../app/lib/v2/model.ts)); OpenRouter now exposes an OpenAI-compatible embeddings endpoint, so an embedding experiment need not introduce a second inference vendor integration ([OpenRouter embeddings API](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings)).

The request is consistent with `SPECS.md`: authorized MCP clients must be able to search the learner's isolated bank, exact duplicates must not create entries, and adding a valid question must not depend on embeddings or model generation. The last rule means semantic enrichment must be best-effort and search must retain a lexical fallback.

## Evidence from primary sources

### Lexical search is necessary but insufficient

PostgreSQL recommends GIN for full-text indexes. It can construct a weighted document from separate fields, and `ts_rank_cd` uses term frequency and proximity, but PostgreSQL explicitly says relevance is application-specific and ranking matched rows can be expensive ([PostgreSQL text-search indexes](https://www.postgresql.org/docs/current/textsearch-indexes.html), [text-search controls](https://www.postgresql.org/docs/current/textsearch-controls.html)). `websearch_to_tsquery` safely accepts raw input, but unquoted words are joined with `AND`; feeding it an entire paraphrased question can therefore be too restrictive as the only retriever.

`pg_trgm` provides case-insensitive string-similarity operators and GiST/GIN operator classes for fast similarity, `LIKE`, and `ILIKE` search. Its documentation specifically says GiST can efficiently return a small top-K ordered by trigram distance, while GIN cannot perform that K-nearest form as efficiently; trigram search is also described as useful alongside full-text search for misspellings ([PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html)). This makes it a strong cheap signal for punctuation changes, typos, reordered words, and lightly rewritten prompts.

Lexical retrieval still cannot reliably recover synonym-heavy paraphrases. Sentence Transformers' first-party retrieval documentation states that lexical retrieval does not recognize synonyms, acronyms, or spelling variants, while dense retrieval can; its duplicate-question tooling uses sentence embeddings for paraphrase mining over millions of questions ([retrieve and re-rank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html), [applications](https://sbert.net/examples/sentence_transformer/applications/README.html)).

### Dense embeddings are the right semantic candidate generator

Sentence-BERT was designed to avoid pairwise comparison over a whole corpus: its paper reports that semantic similarity over 10,000 sentences dropped from about 65 hours with a BERT cross-encoder to about 5 seconds with precomputable sentence embeddings while maintaining BERT accuracy on its evaluated tasks ([Reimers and Gurevych, 2019](https://aclanthology.org/D19-1410/)). The exact historical hardware timings do not predict Waxon latency, but the architecture result is directly relevant: encode each stored prompt once, encode one query, and do vector similarity search.

Duplicate-question research also favors combining complementary signals. On CQADupStack and additional Stack Exchange forums, a multi-view embedding ensemble significantly outperformed BM25 and every single-view system ([Poerner and Schütze, 2019](https://aclanthology.org/D19-1173/)). That is evidence for hybrid or ensemble retrieval, not proof that Waxon should reproduce that paper's heavier model stack.

OpenAI's current small embedding model costs $0.02 per million input tokens, defaults to 1,536 dimensions, accepts up to 8,192 tokens, and supports a `dimensions` parameter to trade some quality for less compute and storage ([model page](https://developers.openai.com/api/docs/models/text-embedding-3-small), [embedding guide](https://developers.openai.com/api/docs/guides/embeddings)). OpenAI embeddings are unit-normalized, so dot product gives the same ordering as cosine with less work. This model is a sensible low-cost baseline, not a conclusion that it is the most accurate Waxon model.

OpenRouter lists the same model at $0.02/M tokens and exposes several cheaper or newer embedding models through the same API. Provider benchmark claims and generic MTEB scores do not establish duplicate detection on a learner's question bank, so model choice should come from the evaluation below rather than leaderboard position ([OpenRouter model page](https://openrouter.ai/openai/text-embedding-3-small), [embedding catalog](https://openrouter.ai/collections/embedding-models)).

The first bake-off should stay within that existing gateway and compare three deliberately different points:

| Candidate | Current input price | Vector shape to test | Why it belongs | Main reservation |
| --- | ---: | ---: | --- | --- |
| `openai/text-embedding-3-small` | $0.02/M tokens | 256 and 512 | Cheapest compact baseline with an API `dimensions` control; about 52 MB or 103 MB of raw `halfvec` data per 100k questions | Generic benchmark quality is not a Waxon duplicate-recall result. |
| `google/gemini-embedding-2` | $0.20/M tokens | 512 | Already Waxon's configured embedding default; supports Matryoshka truncation and more than 100 languages, so it is the quality-oriented compact challenger ([Google embedding guide](https://ai.google.dev/gemini-api/docs/embeddings), [Google pricing](https://ai.google.dev/gemini-api/docs/pricing), [OpenRouter model page](https://openrouter.ai/google/gemini-embedding-2)) | Ten times the input price of the OpenAI baseline, though still only about $6 per million 30-token checks. |
| `baai/bge-m3` | $0.01/M tokens | 1,024 | Lowest-priced multilingual challenger through OpenRouter; its model card covers 100+ languages ([BGE-M3 model card](https://huggingface.co/BAAI/bge-m3), [OpenRouter model page](https://openrouter.ai/baai/bge-m3)) | Fixed 1,024-dimensional output makes exact scans and storage roughly 2–4 times larger than the compact baselines. |

These prices make quality and latency, not token spend, the deciding factors. At an assumed 30 tokens per prompt, one million query embeddings cost about $0.30, $0.60, and $6.00 for BGE-M3, OpenAI small, and Gemini 2 respectively. The provisional implementation baseline should be `text-embedding-3-small` at 512 dimensions because it is compact, cheap, and requires no new provider; switch only if the held-out Waxon set shows that Gemini or BGE materially improves hard-negative recall or end-to-end latency.

### PostgreSQL/pgvector is sufficient; a separate search service is not justified yet

pgvector supports exact and approximate nearest-neighbor search in PostgreSQL. Exact search has perfect recall. HNSW improves the speed/recall trade-off over IVFFlat but uses more memory, builds and updates more slowly, and approximate search necessarily trades recall for speed ([pgvector](https://github.com/pgvector/pgvector)).

Per-user isolation is an important wrinkle. pgvector documents that an ordinary filter is applied after an approximate HNSW scan; at the default search breadth, a filter matching 10% of rows yields only about four matching rows on average. It recommends a B-tree filter and exact search when the filter is selective, and iterative HNSW scans, partitioning, or partial indexes when approximate filtered search is necessary. A Waxon `user_id` can be far more selective than 10%, so a global HNSW index must not be assumed to work well without recall tests.

pgvector stores a `vector(d)` in `4d + 8` bytes and a `halfvec(d)` in `2d + 8` bytes. It explicitly recommends `halfvec` for a smaller working set and offers HNSW half-precision indexing. At 512 dimensions, 100,000 raw half-vectors are about 103.2 MB before row and index overhead; at 256 dimensions they are about 52 MB. The old 3,072-dimensional shape would be about 615 MB in raw half-vectors for one full 100k bank, which is disproportionate for this task ([pgvector storage and half precision](https://github.com/pgvector/pgvector/blob/master/README.md)).

### Fusion is almost free; model reranking is not

RRF combines ranked lists using only ranks, so it does not require calibrated score scales or training data. The original SIGIR paper found that it consistently beat individual systems and other tested fusion methods across its TREC/LETOR experiments ([Cormack, Clarke, and Büttcher, 2009](https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)). That evidence is not Waxon-specific, but RRF is an appropriate default because trigram, full-text, and vector scores are not naturally comparable.

Do not add a learned sparse-embedding model initially. PostgreSQL FTS and trigrams already provide complementary model-free lexical signals. pgvector's `sparsevec` is a storage/search type for externally produced sparse weights, so using it would add another inference and versioning pipeline without evidence that it beats the built-in lexical channels for Waxon ([pgvector sparse vectors](https://github.com/pgvector/pgvector#sparse-vectors)).

Cross-encoders generally improve pair scoring because they attend jointly over the query and candidate, but must run once per pair and are therefore slower; first-party Sentence Transformers guidance uses them only to rerank a small retrieved set ([cross-encoder guidance](https://www.sbert.net/docs/quickstart.html), [retrieve and re-rank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)). A generative LLM judge has the same pairwise hot-path problem plus network and output-token cost.

For MCP, a server-side LLM is especially redundant: the tool's consumer is already a language model. MCP's schema allows structured output, and its tool description is specifically intended to improve the LLM's understanding of when and how to use the tool ([MCP schema](https://modelcontextprotocol.io/specification/2025-11-25/schema)). Supplying well-ranked full pairs and explicit match signals lets that existing agent make the nuanced same-recall-target judgment.

## Option assessment (inference from the evidence and repository)

| Option | Duplicate recall | Hot-path latency/cost | Storage/update cost | Verdict |
| --- | --- | --- | --- | --- |
| Current substring scan | Low beyond literal substrings | No API cost, but unindexed scans and no relevance order | None | Replace. It gives the agent weak evidence and degrades with bank size. |
| Full-text only | Better term matching; poor paraphrase recall | Very fast and local with GIN | Small index, synchronous DB update | Keep as one retriever, not the whole solution. |
| Trigram only | Strong for typos and light rewrites; poor synonym-heavy paraphrases | Very fast and local with a tuned index | Moderate text index | Keep as one retriever, especially for near-exact questions. |
| Dense only | Strong paraphrase recall; can confuse same-topic questions, negation, numbers, or different requested relations | One cheap remote query embedding plus local vector search | One vector per current version and repair/backfill logic | Insufficient alone; use for semantic candidates. |
| Lexical + dense + RRF | Complementary recall without pairwise model inference | One embedding call; local parallel retrieval/fusion | Text indexes plus one compact vector | **Recommended default.** |
| Hybrid + cross-encoder | Potentially higher top-rank precision | Pairwise inference over top-K; model runtime or API | Model hosting/integration and versioning | Evaluate later only if hybrid misses the target. |
| Hybrid + generative LLM judge | Can explain nuanced decisions | Slowest, variable, and duplicates the calling agent's reasoning | Prompt/model/version/trace machinery | Do not use by default. Consider only an explicit opt-in for non-agent clients or a proven ambiguous band. |

## Recommended design

### 1. Separate lookup from a batch pre-add intent

Preserve general lookup, but make the pre-add path unmistakable to an agent. Add a focused read-only **`check_questions`** tool accepting the same maximum batch size and question/answer shape as `add_questions`. This is easier for tool selection than overloading normal library-search semantics and lets an agent preflight a generated batch in one MCP/network round trip.

For pre-add, the input should be the candidate prompt and, when available, reference answer. The tool description should tell the caller:

> Call before `add_questions`. A duplicate asks for the same recall target, not merely the same topic. Reuse/edit/restore an exact or clearly equivalent existing question. A related question that asks for a different fact, direction, condition, or explanation is distinct.

Return a compact structured result such as:

```json
{
  "results": [
    {
      "candidateId": "client-stable-id",
      "advisory": "review_similar",
      "searchMode": "hybrid",
      "coverage": { "exact": true, "lexical": true, "semantic": true },
      "matches": [
        {
          "id": "...",
          "prompt": "...",
          "referenceAnswer": "...",
          "lifecycle": "archived",
          "matchTypes": ["trigram", "semantic"],
          "exactPrompt": false,
          "lexicalRank": 2,
          "semanticRank": 1
        }
      ]
    }
  ]
}
```

Do not expose an uncalibrated pseudo-probability. Raw cosine and trigram values may be returned for diagnostics, but rank and interpretable match types are safer for the agent. Only `exact_duplicate` should initially produce a definitive “do not add” advisory; all semantic cases should say `review_similar` until thresholds are validated.

Always include paused, archived, and trashed questions. Lifecycle changes what the agent should do (restore or edit instead of add), not whether the prior recall target exists.

### 2. Run cheap retrieval stages in parallel

1. **Exact:** reuse `questionPromptKey`, but query the stored `target_key` directly. Exact match always ranks first and remains the only hard duplicate guarantee. Short-circuit that candidate before any embedding call.
2. **Trigram:** retrieve top 25–50 current prompts by similarity. Benchmark GiST K-nearest search against a thresholded GIN query with the `user_id` filter; PostgreSQL's docs favor GiST for small top-K, but Waxon's per-user filter can change the plan.
3. **Full-text:** store/index a combined, weighted current-version question+answer search vector (`prompt` weight A, reference answer or bounded display answer weight B), retrieve top 25–50 with GIN and `ts_rank_cd`. Keep the query parser forgiving. For a whole candidate question, consider an OR/prefix term query or use FTS primarily for normal lookup; `websearch_to_tsquery`'s implicit AND can be too strict.
4. **Dense:** batch all non-exact candidate prompts into one embedding request, then retrieve top 25–50 current versions for each candidate/user by dot product/cosine.
5. **Fuse:** use RRF over the lexical and dense ranks, with exact match pinned first. Start unweighted with the paper's `k = 60` baseline, then tune `k` or weights only from labeled results. Return at most 5–10 pairs to control agent context.

For semantic duplicate retrieval, start with **prompt-only embeddings**. Answers are crucial for final judgment but can swamp the relation being asked and turn “same topic” into a false duplicate. Include answers in the returned candidates. Evaluate a structured `Question: ...\nAnswer: ...` embedding as a separate experiment rather than assuming it is better.

### 3. Make semantic indexing optional and repairable

Create a narrow current-version embedding table keyed by `(user_id, question_version_id, model_version)` with a source hash and a fixed compact dimension. Embedding generation must happen after the question transaction or through the existing jobs mechanism. Add/edit succeeds even if the provider is unavailable; lexical search covers the gap, and an idempotent repair job fills missing/stale embeddings. Lifecycle changes do not require re-embedding; content edits create a new version/source hash.

Start with exact vector search after a B-tree `user_id`/model filter because it preserves recall and pgvector recommends it for selective filters. Add HNSW only when production-like 100k-bank measurements exceed the latency target. If HNSW is needed, enable and test iterative scans and compare its top-K against exact search; do not ship a globally filtered HNSW plan on query latency alone.

Benchmark `text-embedding-3-small` at 256, 512, and 1,536 dimensions through the already-used OpenRouter provider, plus at least one current low-cost multilingual/open model available through the same endpoint. Store model and dimension explicitly so a candidate can be dual-written and backfilled before switching. `halfvec(512)` is a reasonable storage baseline, but only the labeled evaluation should make it the default.

### 4. Keep advice conservative and degrade visibly

- `exact_duplicate`: deterministic normalized-prompt match; recommend reuse/edit/restore.
- `review_similar`: at least one calibrated close candidate; ask the calling agent to compare recall targets using prompt and answer.
- `no_close_match`: retrieval ran successfully and found no candidate above the evaluation-derived review threshold; adding is likely appropriate.
- If the embedding service is down or an embedding is missing, return `searchMode: "lexical_fallback"`. Do not claim `no_close_match` with hybrid confidence.
- Report coverage per batch item, not only for the call. One exact candidate can be complete while another falls back because its semantic query failed.

The add endpoint must still enforce exact idempotency independently. Search guidance is advisory and can race with another add.

## Cost and latency expectations (explicit inference)

These are order-of-magnitude calculations, not measured Waxon results:

- At 30 prompt tokens, embedding 100,000 questions with `text-embedding-3-small` is 3 million tokens, or about **$0.06** at the cited $0.02/M price. One million 30-token searches would cost about **$0.60** in query embeddings. API round-trip latency, not token price, is the main semantic hot-path cost.
- A 512-dimensional `halfvec` is 1,032 bytes from pgvector's `2d + 8` formula, about **103.2 MB** for 100,000 vectors before tuple and index overhead. A 256-dimensional value is 520 bytes, about **52 MB**.
- Exact normalized lookup, trigram, and FTS are local DB operations and should normally be much faster than remote embedding. Run lexical and query embedding concurrently so semantic latency does not serialize the full request.
- A server LLM/cross-encoder would add at least one additional inference stage per search. Since the MCP caller already performs language reasoning, it should have to earn its place through a measured error reduction.

## Evaluation plan and acceptance gates

### Dataset

Build a private, user-isolated evaluation set from opt-in or synthetic/hand-authored question pairs. Label each pair `same recall target`, `related but distinct`, or `unrelated`; adjudicate disagreements. Include at least these strata:

- exact after normalization;
- punctuation, whitespace, typo, and word-order variations;
- genuine paraphrases with little word overlap;
- same subject but different fact/relation/direction;
- negation, quantities, dates, entity substitutions, acronyms, code, and formulas;
- multilingual and cross-language pairs if Waxon usage contains them;
- different lifecycle states;
- no-match queries;
- prompt-only versus prompt-plus-answer ambiguity.

Do not tune on Quora/CQADupStack alone: Waxon's definition is “same recall target,” not merely general paraphrase, and its stored answers provide important disambiguation.

### Offline retrieval experiment

Compare, with the same candidate pool and labels:

1. current substring baseline;
2. FTS;
3. trigram;
4. FTS + trigram RRF;
5. each candidate embedding model/dimension with exact vector search;
6. lexical + each dense candidate via RRF;
7. winning hybrid plus a small cross-encoder on top 10–20;
8. winning hybrid plus an LLM judge only as an upper-bound experiment.

Primary retrieval metric: **recall@10 for same-recall-target matches**. Secondary: MRR/nDCG, recall by stratum, and number of candidates shown. For the advisory, separately measure precision/recall and false `exact/no-add` versus false `no-close-match`. Favor high recall in retrieval and very high precision for any automatic no-add advice.

Initial gates to validate or revise with product risk tolerance:

- exact duplicate precision: 100% under the canonicalization rule;
- same-target recall@10: at least 98% overall, with no critical stratum below 95%;
- definitive “do not add” beyond exact: do not enable until at least 99% precision on a held-out set;
- no material loss versus the best candidate system for multilingual, negation/number, and hard-negative strata.

### Online performance experiment

Benchmark warm and cold p50/p95/p99 at 1k, 10k, and 100k current questions per learner, plus many-user tables where one learner is a tiny fraction of all rows. Capture `EXPLAIN (ANALYZE, BUFFERS)` for FTS, trigram, exact vector, and any HNSW plan. Measure:

- end-to-end MCP latency and separate embedding/DB timings;
- index sizes, rows missing embeddings, and backfill throughput;
- query and indexing token cost;
- HNSW recall against exact search if HNSW is tested;
- add/edit latency with the provider healthy and unavailable;
- percentage of searches using lexical fallback.

Suggested service gates: local lexical p95 below 50 ms on a warm production-like database; hybrid p95 below 300 ms warm and below 750 ms including realistic provider/network variance; no dependency of successful add/edit on embedding availability. These are proposed budgets, not existing stakeholder requirements.

### Shadow rollout

1. Ship relevance-ranked lexical search and structured match signals first; this immediately removes the full substring/recency behavior without external inference.
2. Backfill candidate embeddings, run dense retrieval in shadow, and log only ranks/timing/cost with user isolation and normal data-retention controls.
3. Evaluate hybrid output and thresholds on held-out labels.
4. Enable hybrid results with lexical fallback, still advisory.
5. Reconsider cross-encoder/LLM reranking only after reviewing real error clusters. Prefer tuning retrieval, embedding text, or an inexpensive pair classifier before a generative judge.

## Bottom line

The best cost/latency/quality balance is not “semantic instead of text” and not “ask an LLM whether this is a duplicate.” It is **exact canonicalization + trigram/FTS + one compact embedding + rank fusion**, with the MCP response designed so the already-present agent can make the final same-recall-target judgment. PostgreSQL can do every retrieval and fusion step; the only remote work on a hybrid search is one tiny query embedding. Waxon should select the embedding and thresholds by its own hard-negative evaluation, start with exact per-user vector search, and add ANN or reranking only after measurements show they are necessary.
