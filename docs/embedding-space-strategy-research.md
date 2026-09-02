# Embedding-space strategy for semantic Tags

## Recommendation

Use `text-embedding-3-small` at 512 dimensions as Waxon's first production space, but treat 512 as a measured default rather than a permanent optimum. Evaluate 256, 512, and the model's full 1,536 dimensions on Waxon relevance judgments before storing a second dimension globally. Add 1,024 only if the first experiment shows that quality is still improving enough between 512 and 1,536 to justify another point on the curve.

Provider plus dimension is **not** a sufficient compatibility key. `text-embedding-3-small` and `text-embedding-3-large` can both emit 512 numbers, but those coordinates were produced by different learned transformations. Dimension equality makes a dot product computable; it does not make the score meaningful. Search should therefore compare only records with the same immutable `embedding_space_id`.

OpenAI documents 1,536 as the default size for `text-embedding-3-small`, supports shortening through the `dimensions` parameter, and describes shortening as an accuracy-versus-storage/compute tradeoff. It does not publish an authoritative 256/512/1,024/1,536 ablation for `text-embedding-3-small`. The launch evidence that a 256-dimensional shortened `text-embedding-3-large` beats full-size `text-embedding-ada-002` supports the technique, not the conclusion that 256 or 512 is optimal for Waxon. ([OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings), [OpenAI v3 launch](https://openai.com/index/new-embedding-models-and-api-updates/), [Matryoshka Representation Learning](https://arxiv.org/abs/2205.13147))

At thousands of Questions per learner, exact search work is modest and grows linearly with dimensions. Global storage is the stronger reason not to default immediately to 1,536 dimensions. This makes 512 a sensible midpoint: twice the arithmetic and raw vector storage of 256, half of 1,024, and one third of 1,536. A larger default should require a material Waxon-specific retrieval gain.

## Storage and database constraints

pgvector stores a `halfvec` in `2 * dimensions + 8` bytes and a full-precision `vector` in `4 * dimensions + 8` bytes. These are raw vector payload figures; rows, keys, indexes, write-ahead logs, replicas, and backups add overhead. ([pgvector type reference](https://github.com/pgvector/pgvector#halfvec-type))

| Dimensions | `halfvec` bytes/vector | 10,000 vectors | 1 billion vectors |
| ---: | ---: | ---: | ---: |
| 256 | 520 | 5.20 MB | 0.520 TB / 0.473 TiB |
| 512 | 1,032 | 10.32 MB | 1.032 TB / 0.939 TiB |
| 1,024 | 2,056 | 20.56 MB | 2.056 TB / 1.870 TiB |
| 1,536 | 3,080 | 30.80 MB | 3.080 TB / 2.801 TiB |

Each additional globally populated embedding space adds roughly another copy of its row count, so experimental spaces should initially cover a sample/cohort rather than all Questions. Tag vectors are negligible compared with Question vectors.

pgvector's HNSW and IVFFlat indexes support at most 2,000 dimensions for `vector` and 4,000 for `halfvec`; therefore 1,536-dimensional `text-embedding-3-small` and even 3,072-dimensional `text-embedding-3-large` fit a `halfvec` index, while full-size `text-embedding-3-large` does not fit a `vector` HNSW/IVFFlat index. pgvector can store mixed dimensions in an unconstrained vector column, but indexes must cover rows with one dimension, using casts and partial/expression indexes. ([pgvector indexing limits](https://github.com/pgvector/pgvector#indexing), [pgvector mixed-dimension guidance](https://github.com/pgvector/pgvector#can-i-store-vectors-with-different-dimensions-in-the-same-column))

OpenAI says its embeddings are unit-normalized, so cosine similarity and Euclidean distance produce identical rankings and cosine can be calculated with a dot product. For this OpenAI space, use inner product consistently; pgvector also recommends inner product for normalized vectors. ([OpenAI embedding FAQ](https://developers.openai.com/api/docs/guides/embeddings#which-distance-function-should-i-use), [pgvector exact-search guidance](https://github.com/pgvector/pgvector#exact-search))

## What defines one compatible space

Create an immutable registry row for every searchable space. Its identity should fix:

- Provider/endpoint implementation and exact model ID, not merely a friendly family name.
- Output dimensions and how they are produced: provider `dimensions` parameter versus any local truncation/post-processing.
- Semantic purpose, initially `question-tag-relevance`; duplicate detection or free-text search may prove to need different spaces.
- Question input recipe version and Tag input recipe version. For example, changing from Prompt-only to labelled Prompt plus Answer Standard changes the experiment even though the model coordinates remain mathematically computable.
- Role mode: symmetric, or asymmetric query/document roles and their provider-required prefixes/instructions. This allows future dual-encoder models without pretending their query and document inputs are interchangeable.
- Normalization/post-processing policy and distance metric.
- Model revision or provider deployment identifier when one exists, plus the creation time when the provider exposes only an unversioned model ID.

The physical storage precision (`halfvec` versus full `vector`) and search algorithm can be recorded as execution metadata rather than semantic compatibility, because a float query can validly search half-precision copies of the same space. They still belong in evaluation results because they can change ranking at close score boundaries.

A suitable logical shape is:

```text
embedding_spaces(
  id, provider, model, dimensions, purpose,
  question_recipe_version, tag_recipe_version, role_mode,
  normalization, distance_metric, model_revision, status
)

question_embeddings(learner_id, question_id, embedding_space_id, input_hash, embedding, ...)
tag_embeddings(learner_id, tag_id, embedding_space_id, input_hash, embedding, ...)
```

Use `(learner_id, entity_id, embedding_space_id)` as the entity-embedding uniqueness boundary. Validate the stored vector length against the registry. A search selects one `embedding_space_id`; it must never merge raw scores or nearest-neighbor lists from different spaces as though the values shared a calibration.

## Model-support decisions to make before the abstraction hardens

1. **Start with one model family.** Support single-vector dense text embeddings first. Sparse, late-interaction/multivector, image, and hybrid models have different storage and retrieval contracts and should be new strategies, not squeezed into this row shape.
2. **Use a capability registry, not scattered model conditionals.** For every allowed model record native and allowed dimensions, maximum input tokens, whether server-side shortening exists, normalization behavior, role mode, required prefixes/instructions, and supported encoding formats. OpenAI currently documents 8,192 maximum input tokens for both v3 models and `dimensions` only for v3-and-later models. ([OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings), [OpenAI API client contract](https://github.com/openai/openai-node/blob/master/src/resources/embeddings.ts))
3. **Allowlist exact configurations.** Do not accept arbitrary provider/model/dimension combinations from product requests. Register, validate, and migrate a space before it becomes selectable.
4. **Define input recipes now.** Decide Question content (Prompt only versus Prompt plus Answer Standard), Tag content (label plus scope note), labels/separators, Unicode normalization, empty-input behavior, and deterministic token-limit/truncation behavior. Store an input hash so stale embeddings are detectable.
5. **Choose one space per request.** An active production space can coexist with shadow evaluation spaces, but a request must search exactly one. A/B test by learner or request assignment, not by blending incomparable scores.
6. **Define incomplete-coverage behavior.** A Question and Tag can be compared only if both have the selected space. The API should either omit missing entities with explicit coverage metadata or switch the whole request to another mutually covered space; it must not fall back per row and mix spaces.
7. **Calibrate per space.** Similarity thresholds and confidence labels are model-, dimension-, recipe-, and precision-specific. Store them against `embedding_space_id`; never reuse a 512-dimensional threshold for 256 or 1,536.
8. **Define retirement and reproducibility.** Spaces need `shadow`, `active`, and `retired` lifecycle states. Keep the exact configuration and evaluation record after retiring vectors so old experiment results remain interpretable.

## Dimension experiment

The decision should come from Waxon's two actual rankings, not aggregate MTEB alone. MTEB itself spans distinct task families and uses nDCG@10 for retrieval, which is useful external context but not a substitute for a product dataset. ([MTEB project](https://github.com/embeddings-benchmark/mteb), [MTEB metric definitions](https://github.com/embeddings-benchmark/leaderboard/blob/main/config.yaml))

Generate 256-, 512-, and 1,536-dimensional `text-embedding-3-small` spaces from identical source text and recipes. Evaluate on held-out learner-private judgments containing obvious positives, cross-boundary Questions, acronyms/synonyms, same-topic hard negatives, and incidental mentions. Measure:

- Question → Tags: precision@10, nDCG@10, and the rate of irrelevant displayed Tags.
- Tag → Questions: precision/recall/nDCG@50 and quality near the drill cutoff.
- Ranking disagreement and threshold stability across dimensions.
- Exact-search p50/p95 latency, memory/read volume, and database storage at realistic learner sizes.

Use the existing static assignments only as weak seed labels; manually judge a stratified sample and hold out a final test set. Choose 512 unless 1,536 produces a material improvement on hard cases, or 256 matches 512 closely enough that halving storage is more valuable. This recommendation is deliberately falsifiable because OpenAI's published evidence does not establish Waxon's optimum dimension.
