# Embedding model selection for question-and-answer relatedness

## Decision summary

`openai/text-embedding-3-small` is a good conservative baseline, but there is not enough evidence to call it the best cost-effective model for Waxon. If a model had to be trialled first today, use `qwen/qwen3-embedding-8b` at 512 dimensions as the price/performance challenger, keep the current OpenAI model as the baseline, and use `google/gemini-embedding-2` as the quality-oriented challenger. Do not switch production or backfill millions of rows until all three have been evaluated on Waxon-labelled pairs at the actual 512 dimensions and with the exact input formatting that production will use.

The embedding-generation bill should not decide this choice. At an illustrative 100 tokens for a labelled Prompt plus Answer Standard, one million records cost about $1 with Qwen, $2 with OpenAI, or $20 with Gemini Embedding 2 at standard rates. A small gain in duplicate/related-question recall or a reduction in false positives is worth much more than that difference. Storage, indexing, re-embedding, latency, and evaluation are the material costs.

## Waxon constraints found in the repository

- `shared/question-search.mts` fixes question-search output to 512 dimensions, L2-normalizes every vector, and sends `dimensions: 512` to OpenRouter.
- The current stored input is only `Question:\n<normalized prompt>`. The Answer Standard is not embedded, and the prompt hash therefore does not invalidate when only an answer representation changes.
- `app/db/v2/schema.ts` stores one `halfvec(512)` per learner/question/model/version. The model and embedding version are part of the primary key, so a migration can coexist with old vectors, but every row must be regenerated for a new embedding space.
- `app/lib/v2/questionSearch.ts` uses negative inner product over normalized vectors, which is equivalent to cosine ranking. Hybrid mode fuses lexical and semantic ranks and requires complete embedding coverage.
- The semantic SQL has no HNSW or IVFFlat vector index; the only embedding index is a B-tree on learner, model, and version. A bank containing millions of questions would therefore perform an exact similarity scan and sort after filtering. This is likely to become a larger scaling issue than model inference price. If “millions” means total rows spread across many small learner banks, the learner filter changes that assessment and should be benchmarked with the expected per-learner distribution.
- The product specification requires semantic similarity to remain advisory and never automatically merge questions. Model selection and thresholding must preserve that boundary.

## Current model comparison

Pricing is a snapshot from 2026-08-31. Benchmark numbers below come from different model owners, suites, dates, dimensions, and evaluation protocols; they are evidence for choosing challengers, not a valid head-to-head ranking.

| Model | Current price per 1M input tokens | Context and dimensions | Task handling and multilingual evidence | First-party quality evidence | Waxon assessment |
| --- | ---: | --- | --- | --- | --- |
| `openai/text-embedding-3-small` | $0.02 on OpenRouter and from OpenAI | 8,192 tokens; 1,536 default; supports shortening with `dimensions`, including Waxon's 512 | OpenAI does not expose separate query/document task types for this model. Its launch evaluation reported MIRACL 44.0 and English MTEB 62.3. | OpenAI's launch post reports the scores and states that the v3 models were trained for dimension shortening. | Lowest migration risk because it already satisfies the API and schema contract. It is inexpensive and predictable, but old relative to the current alternatives and its published score is not specifically for 512 dimensions or Waxon's duplicate-detection task. |
| `google/gemini-embedding-001` | $0.15 standard or $0.075 batch from Google | 2,048 tokens; 128–3,072 dimensions | Explicit `SEMANTIC_SIMILARITY`, `RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`, question-answering, clustering, and other task types. Google reports broad multilingual capability. | Google reports multilingual MTEB 68.4 at full size and publishes a dimensionality ablation: 67.55 at 512 versus 68.16 at 2,048. | Strong evidence that 512 preserves most reported quality, but it is now the legacy text-only Gemini option and costs more than Embedding 2 batch. Do not begin a new large migration to it. |
| `google/gemini-embedding-2` | $0.20 standard or $0.10 batch from Google; $0.20 standard on OpenRouter | 8,192 tokens; 128–3,072 dimensions | Google strongly recommends task prefixes. It documents distinct asymmetric query/document formats and a symmetric sentence-similarity format, and reports support for over 100 languages. | Google reports multilingual MTEB 69.9 versus 68.4 for `gemini-embedding-001`. It does not publish the same 512-dimensional ablation for Embedding 2. | Best quality-oriented challenger and still cheap in absolute terms. Waxon's current `Question:` prefix does not follow Google's recommended task formatting, so a model-only environment-variable change would be an invalid trial. Multimodality offers no present value because Waxon intentionally stores only questions and answers. |
| `qwen/qwen3-embedding-8b` | $0.01 on OpenRouter | 32K tokens; user-defined 32–4,096 dimensions | Instruction-aware; Qwen documents retrieval instructions and more than 100 languages. Retrieval queries receive an instruction while stored documents need not. | Qwen's model card reports multilingual MTEB mean 70.58 and retrieval 70.88 for the 8B model, but not a Waxon-specific or 512-dimensional score. | Strongest apparent price/performance challenger: half the current price, 512-compatible by design, multilingual, and available through the existing gateway. Before adoption, verify OpenRouter returns exactly 512 values and evaluate the correct instruction/query-document treatment; the published full-size score does not prove 512 performance. |
| `voyageai/voyage-4-lite` | $0.02 on OpenRouter and from Voyage | 32K tokens; native 256, 512, 1,024, or 2,048 dimensions | Explicit `query` and `document` input types; general-purpose and multilingual. | Voyage's first-party Retrieval Embedding Benchmark evaluation says the lite model approaches `voyage-3.5`; the family is designed so a stronger document model and cheaper query model can share an embedding space. No directly comparable Waxon or MTEB score is published in the cited summary. | Worth including if operationally clean asymmetric retrieval matters. It has unusually clear 512 and query/document documentation, but Qwen is cheaper and Gemini offers stronger current first-party benchmark evidence. |

Primary sources:

- [OpenAI embedding guide: dimensions, MTEB, and 8,192-token input](https://developers.openai.com/api/docs/guides/embeddings)
- [OpenAI v3 launch: MTEB/MIRACL results, price, and dimension shortening](https://openai.com/index/new-embedding-models-and-api-updates/)
- [OpenRouter `text-embedding-3-small`: current price and availability](https://openrouter.ai/openai/text-embedding-3-small)
- [Google Gemini embedding guide: task formats, dimensions, limits, and the 512-dimensional Embedding 001 ablation](https://ai.google.dev/gemini-api/docs/embeddings)
- [Google Gemini pricing: Embedding 2 and Embedding 001 standard/batch rates](https://ai.google.dev/gemini-api/docs/pricing)
- [Google DeepMind Gemini Embedding 2: multilingual benchmark and model information](https://deepmind.google/models/gemini/embedding/)
- [OpenRouter Gemini Embedding 2: current gateway price and model contract](https://openrouter.ai/google/gemini-embedding-2)
- [Qwen3 Embedding 8B model card: dimensions, instructions, languages, and owner-reported benchmarks](https://huggingface.co/Qwen/Qwen3-Embedding-8B)
- [OpenRouter Qwen3 Embedding 8B: current price and gateway availability](https://openrouter.ai/qwen/qwen3-embedding-8b)
- [Voyage text embedding documentation: dimensions, context, and query/document input types](https://docs.voyageai.com/docs/embeddings)
- [Voyage 4 family evaluation and shared embedding space](https://blog.voyageai.com/2026/01/15/voyage-4/)
- [OpenRouter Voyage 4 Lite: current price and gateway availability](https://openrouter.ai/voyageai/voyage-4-lite)
- [OpenRouter embedding API: `dimensions` and `input_type` request fields](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings)
- [pgvector: `halfvec` storage and indexing guidance](https://github.com/pgvector/pgvector#halfvec-type)

## Cost at one million questions

These estimates deliberately expose the assumptions instead of pretending Waxon's token distribution is known:

- Prompt-only case: 30 billable tokens per record, including labels/instructions, or 30 million tokens total.
- Prompt-plus-answer case: 100 billable tokens per record, including labels/instructions, or 100 million tokens total.
- Prices exclude retries, provider fees not included in list price, re-embeddings, and online query embeddings.

| Model | 1M prompt-only records (30 tokens each) | 1M Prompt + Answer Standard records (100 tokens each) |
| --- | ---: | ---: |
| Qwen3 Embedding 8B via OpenRouter | $0.30 | $1.00 |
| OpenAI `text-embedding-3-small` via OpenRouter | $0.60 | $2.00 |
| Voyage 4 Lite via OpenRouter | $0.60 | $2.00 |
| Voyage 4 via OpenRouter | $1.80 | $6.00 |
| Gemini Embedding 001, Google batch / standard | $2.25 / $4.50 | $7.50 / $15.00 |
| Gemini Embedding 2, Google batch / standard | $3.00 / $6.00 | $10.00 / $20.00 |

At 512 dimensions, pgvector documents `halfvec` storage as `2 * dimensions + 8` bytes: 1,032 bytes per vector, or about 1.03 GB (0.96 GiB) for one million raw vectors before tuple, key, index, WAL, backup, and replication overhead. Two separate 512-dimensional vectors roughly double that raw vector payload. For comparison, a 768-dimensional `halfvec` is about 1.54 GB per million and a 3,072-dimensional vector about 6.15 GB per million. This is why testing at the production 512 dimensions matters.

## What should be embedded

A labelled composite is a better first production candidate than the current prompt-only string:

```text
Question:
<prompt>

Answer standard:
<reference answer>
```

The Answer Standard can disambiguate prompts that use similar wording but test different facts, and field labels prevent the model from treating the two parts as undifferentiated prose. This is suitable when the desired relation is “these records test the same or closely related recall target.” It is not automatically optimal:

- Long answers can dominate a single vector.
- Different questions can share the same short answer, creating hard false positives.
- Prompt-only free-form search and whole-record duplicate detection are distinct tasks.

Therefore evaluate three representations: prompt only, the labelled composite above, and separate prompt/answer vectors with a weighted late fusion. Prefer the labelled composite if it matches or beats the two-vector design because it preserves the current one-vector storage and query shape. Use separate vectors only if the measured reduction in hard false positives justifies roughly twice the vector storage and search work.

Task formatting must match the operation:

- For symmetric record-to-record relatedness or duplicate detection, use the provider's semantic-similarity instruction consistently on every record.
- For asymmetric free-form search, embed stored questions as documents and runtime search text as queries using the provider's documented roles or prefixes.
- If Waxon needs both, version them as distinct embedding purposes or prove one representation works for both. Changing only the model slug while retaining the current `Question:` input would give Gemini, Qwen, and Voyage an unfair and potentially broken evaluation.

Any input change requires a new embedding version and complete re-embedding because vectors from different models, tasks, dimensions, or input formats are not comparable.

## Required Waxon-specific evaluation

Build a small labelled set before a bulk backfill. Include:

- Same recall target expressed with different wording.
- Closely related but independently useful questions that must not be treated as duplicates.
- Same topic, different fact.
- Same answer, different question.
- Negated, inverse, and scope-shifted questions.
- Short prompts with long standards and long prompts with short standards.
- Cross-language and same-language pairs for the languages Waxon actually expects.

For each model and representation, generate actual 512-dimensional vectors and measure recall@k for true related/duplicate pairs, precision@k, false-positive rate at candidate thresholds, and especially performance on the hard negatives. Also measure p50/p95 latency, failure rate, batch throughput, and actual billed tokens through OpenRouter. Keep lexical retrieval in the hybrid because exact names, acronyms, numbers, and negation are common embedding failure modes.

Use shadow mode first. Select a threshold on held-out examples, then manually review disagreements between lexical and semantic results. The acceptance criterion is not the highest generic MTEB score; it is the best recall of same-target questions at an acceptable advisory false-positive rate on Waxon's data.

## Recommendation

1. Keep `text-embedding-3-small` as the production baseline until the representation and evaluation set exist.
2. Change the evaluation input to include a labelled Answer Standard and increment the embedding version; do not silently reuse prompt-only vectors.
3. Trial `qwen/qwen3-embedding-8b`, `text-embedding-3-small`, and `gemini-embedding-2` at 512 dimensions with correct task formatting. Add `voyage-4-lite` if query/document ergonomics or latency make it attractive.
4. If Qwen matches Gemini on the Waxon test, choose Qwen: it has the strongest apparent cost/performance and fits the existing OpenRouter boundary. If Gemini materially reduces false positives or improves recall, choose Gemini; even $20 per million 100-token records is negligible. If neither clearly beats OpenAI, retain the current model to avoid migration risk.
5. Before a million-row bank, design and benchmark an ANN/partitioning strategy with learner filtering. The current exact scan is not a million-row retrieval architecture.
