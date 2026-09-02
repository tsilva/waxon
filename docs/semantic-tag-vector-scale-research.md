# Semantic Tag Retrieval at One Billion Questions

Date: 2026-09-02

Scope: one billion Questions in total, but only thousands of Questions and thousands of Tags per learner. All searches are learner-private.

## Conclusion

Waxon should route by learner before comparing vectors and should initially use exact vector search inside that learner's small candidate set. It should not build one global approximate-nearest-neighbor (ANN) graph and then apply a learner filter. At this workload shape, one billion Questions is a horizontal storage and tenant-routing problem; each read still compares only a few thousand vectors.

This yields two deliberately asymmetric paths:

- Question to Tags: load or cache one learner's Tag matrix and compute exact top 10.
- Tag to Questions: route to one learner's Question partition, apply lifecycle/model/version predicates, and compute exact top 50.

Exact search avoids ANN recall loss, filter starvation, index-build cost, and unstable results. pgvector itself states that exact nearest-neighbor search has perfect recall, while ANN trades recall for speed; it also warns that a shared approximate index lets tenants affect one another's recall and speed because filtering happens after the index scan ([pgvector indexing and multitenancy](https://github.com/pgvector/pgvector#filtering)).

Do not select a vector backend merely because it advertises billion-vector scale. Keep the retrieval API backend-neutral, benchmark Waxon's tenant-size and concurrency distribution, and introduce tenant-local ANN only if an individual learner outgrows the exact-search latency budget.

## Recommended architecture

### Canonical and derived data

- PostgreSQL remains the canonical store for Questions, Tags, lifecycle, ownership, and embedding job state.
- The vector index is a rebuildable projection containing only stable object ID, learner ID or physical tenant route, lifecycle, embedding model/version, and vector. Question text need not be copied into it.
- An idempotent transactional outbox publishes Question/Tag creates, replacements, lifecycle changes, deletes, and embedding completions to the projection. Reads never call the embedding provider.
- Every query supplies an authenticated learner ID and one compatible embedding model/version. Vectors from different embedding spaces must never be compared.

### Question to 10 Tags

For one learner with `T` Tags and 512-dimensional normalized vectors, compute a dense matrix-vector product over `T x 512`, retain the top 10, and apply a relevance threshold. A few thousand Tags means only a few million multiply-adds.

For a Library page, batch the work: multiply the matrix of visible Question embeddings by the learner's Tag matrix once, rather than issuing one database or network request per Question. Cache only hot learners' immutable Tag matrices, keyed by learner and embedding version; invalidate by advancing a per-learner Tag epoch.

### Tag to 50 Questions

Route to the learner's physical shard or namespace first. Within it:

1. Narrow by learner, current embedding model/version, and requested lifecycle.
2. Compute exact cosine similarity or inner product over that learner's few thousand Question vectors.
3. Sort by score and stable Question ID and return the top 50 IDs.
4. Fetch the Question records from PostgreSQL in one batch while preserving rank order.

With normalized vectors, dot product and cosine produce the same ordering. The important property is that storage routing occurs before vector comparison; a global HNSW search followed by a learner predicate is the wrong query shape.

### Physical routing

Maintain a small tenant-placement directory mapping learner ID to shard/namespace and placement generation. Consistent-hash or range shards may hold many small learners; unusually large or hot learners can be promoted to dedicated placement without changing the retrieval API.

On PostgreSQL/Citus, distribute by learner ID. Citus routes a query that constrains the distribution column to the worker holding that tenant's rows ([Citus distributed-table routing](https://github.com/citusdata/citus#creating-distributed-tables)). On each worker, a B-tree beginning with `(learner_id, embedding_model, embedding_version, lifecycle)` narrows the exact scan before the vector sort. This is materially different from asking HNSW to search a multi-tenant graph.

Tenant placement improves performance but is not authorization. The service must still derive learner identity from authentication, bind it into every query, reject caller-provided ownership, and test cross-tenant isolation.

### Capacity

At Waxon's current 512 dimensions, one billion raw vectors occupy approximately:

| Representation | Raw vector bytes | Size for 1B vectors |
|---|---:|---:|
| FP32 | 2,048 | 1.86 TiB |
| FP16 / `halfvec` | 1,024 | 0.93 TiB |
| INT8 | 512 | 0.47 TiB |
| 1-bit binary | 64 | 59.6 GiB |

These figures exclude row/ID overhead, indexes, WAL, replicas, backups, and operational headroom. pgvector supports `halfvec` and binary-quantized expression indexes ([pgvector half precision and binary quantization](https://github.com/pgvector/pgvector#half-precision-vectors)). For the exact tenant-local path, start with `halfvec(512)` and measure quality against FP32; lossy quantization is not needed merely to make a few-thousand-vector scan fast.

## When ANN and two-stage reranking become justified

Define a per-tenant promotion threshold from measurements, not global row count. If a learner's filtered candidate set becomes large enough to miss the latency SLO, move that learner to a dedicated ANN partition and use:

1. A quantized tenant-local ANN index to retrieve an oversampled candidate set (for example, 5-20 times the requested 50).
2. Exact full-precision scoring of those candidates.
3. A final relevance threshold and stable ID tie-break.

This preserves most storage/speed benefits while recovering precision. Qdrant documents exactly this in-RAM quantized prefetch followed by full-vector disk rescoring ([Qdrant large-scale two-stage search](https://qdrant.tech/documentation/tutorials-operations/large-scale-search/#search)); Milvus exposes the same pattern through HNSW scalar quantization plus `refine` and `refine_k` ([Milvus HNSW-SQ refinement](https://milvus.io/docs/hnsw-sq.md)). Quantization parameters must be selected against Waxon's own recall@10/50 ground truth; vendor examples are not proof for Waxon's embeddings.

## Backend and pattern comparison

| Option | Tenant routing and filtering | Scaling/retrieval evidence | Rebuild characteristics | Principal concern for Waxon |
|---|---|---|---|---|
| PostgreSQL + pgvector, sharded by learner (for example Citus or application shards) | Distribution on learner ID routes reads to one shard; B-tree predicates produce a small exact vector scan. Large tenants may receive their own partition/table. | pgvector provides exact search, HNSW/IVFFlat, half precision, quantization, and recommends horizontal scaling through replicas or a sharding layer ([pgvector scaling](https://github.com/pgvector/pgvector#scaling)); Citus routes tenant-constrained queries to one worker ([Citus](https://github.com/citusdata/citus#creating-distributed-tables)). | PostgreSQL supports concurrent index rebuilds, but they require extra work and I/O; partitioned indexes must be built concurrently on each leaf and attached ([PostgreSQL partitioned-index operations](https://www.postgresql.org/docs/current/ddl-partitioning.html)). | Lowest application complexity and best exactness, but operating and rebalancing a billion-row PostgreSQL fleet is substantial. A shared HNSW graph is specifically unsuitable for narrow tenant filters. |
| Qdrant distributed | A tenant payload index can partition shared collections; user-defined shards and tiered multitenancy can promote a large tenant from a shared fallback shard to a dedicated shard ([Qdrant multitenancy](https://qdrant.tech/documentation/manage-data/multitenancy/)). | Distributed collections shard and replicate data; quantization, on-disk vectors, oversampling, and exact rescoring are first-class ([Qdrant distributed deployment](https://qdrant.tech/documentation/scaling/distributed_deployment/), [quantization](https://qdrant.tech/documentation/quantization/)). | Build a new collection and atomically switch an alias; aliases are documented specifically for embedding-model upgrades ([Qdrant collection aliases](https://qdrant.tech/documentation/manage-data/collections/#collection-aliases)). Self-hosted resharding may require a new collection, and some shard-transfer modes rebuild index/quantization data. | Strong operational fit if tenant-local ANN becomes necessary, but it adds a second datastore and consistency pipeline when exact PostgreSQL scans may already meet the SLO. |
| Milvus Distributed | A learner field can be a partition key; partition-key isolation builds a separate index for each key group and requires a single partition-key value in the search predicate. That isolation currently applies only to HNSW ([Milvus partition-key isolation](https://milvus.io/docs/use-partition-key.md#use-partition-key-isolation)). | Milvus separates stateless access, streaming, query, data/index, WAL, and object-storage layers so compute can scale horizontally ([Milvus architecture](https://milvus.io/docs/architecture_overview.md)). It supports quantized HNSW and higher-precision refinement. | Collection aliases support preparing a new indexed collection and switching the application without downtime ([Milvus aliases](https://milvus.io/docs/manage-aliases.md)). | Designed for very large vector workloads, but its distributed control plane is the highest self-hosting burden here; validate tenant isolation and filtered recall independently. |
| Pinecone serverless | One namespace per learner; every data operation targets exactly one namespace, and Pinecone documents namespaces as physically isolated in serverless ([Pinecone multitenancy](https://docs.pinecone.io/guides/index-data/implement-multitenancy)). | On-demand capacity scales automatically. Dedicated read nodes target predictable, large workloads but currently support only a single namespace, making them a poor fit for this many-tenant shape today ([Pinecone dedicated read nodes](https://docs.pinecone.io/guides/index-data/dedicated-read-nodes)). | Backups restore into a new index, but schema migration is not supported; schema changes require a new index ([Pinecone restore](https://docs.pinecone.io/guides/manage-data/restore-an-index), [index schema limitation](https://docs.pinecone.io/guides/index-data/create-an-index)). Cutover is application-managed rather than a documented collection alias. | Lowest infrastructure burden and clearest namespace isolation, but less control over exact-vs-ANN execution, quantization, and multi-namespace dedicated capacity; cost and p95/p99 latency require a workload benchmark. |

None of these official sources provides an apples-to-apples Waxon benchmark, so the table is a capability comparison, not a vendor verdict.

## Safe embedding and index rebuilds

Treat an embedding model, dimension, input format, or normalization change as a new physical generation:

1. Create generation `N+1` alongside `N`; never mix their vectors.
2. Bulk-embed a consistent snapshot from canonical Question/Tag data.
3. Dual-write new mutations through the outbox, then replay the catch-up offset until lag is zero.
4. Validate ownership isolation, counts/checksums, missing vectors, recall@10 and recall@50 against exact ground truth, p50/p95/p99 latency, and stale-read age.
5. Atomically change the retrieval pointer/alias to `N+1`.
6. Retain `N` for a bounded rollback window, then delete it only after backup and audit checks pass.

Qdrant and Milvus provide collection aliases for this blue-green switch. With pgvector, prefer a new versioned table or partition and an application pointer over rebuilding a billion-row live index in place. PostgreSQL warns that even `REINDEX CONCURRENTLY` performs more work, takes longer, and adds CPU/memory/I/O load ([PostgreSQL concurrent reindex](https://www.postgresql.org/docs/current/sql-reindex.html#SQL-REINDEX-CONCURRENTLY)).

## Required benchmark before committing to a backend

Replay a production-shaped corpus with the actual 512-dimensional model and skewed tenant sizes. Measure separately:

- exact top 10 Tags for one Question and batched Tags for 50 visible Questions;
- exact top 50 Questions for one Tag with each lifecycle predicate;
- p50/p95/p99 latency and throughput under expected concurrency;
- index/storage/WAL/replication footprint and re-embedding throughput;
- freshness after create, replace, archive, and restore;
- recall@10/50 if any ANN or quantization is enabled;
- behavior during shard movement, node loss, and blue-green generation cutover;
- explicit attempts to retrieve another learner's IDs.

The first decision gate should be whether sharded exact pgvector meets the SLO. Only if it fails for an individual learner's candidate-set size should Waxon benchmark Qdrant, Milvus, or Pinecone for that path.
