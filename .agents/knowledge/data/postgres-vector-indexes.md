---
type: Data Note
title: Postgres vector index constraints
description: Waxon's 3072-dimensional pgvector columns need halfvec expression indexes for HNSW similarity search.
resource: drizzle/0005_semantic_dedupe_gate.sql
tags: [postgres, pgvector, indexes, embeddings]
timestamp: 2026-06-13T00:00:00Z
status: verified
confidence: high
source:
  - file:drizzle/0005_semantic_dedupe_gate.sql
  - file:drizzle/0024_query_performance_indexes.sql
---

# Postgres Vector Index Constraints

Waxon stores OpenRouter embedding vectors with 3072 dimensions. HNSW indexes for these values should follow the existing `question_embeddings` migration pattern and cast to `halfvec(3072)`:

```sql
CREATE INDEX ... USING hnsw (("embedding"::halfvec(3072)) halfvec_cosine_ops)
```

Queries intended to use those indexes should also cast both sides to `halfvec(3072)` in the distance expression.
