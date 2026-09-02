# Retrieve Questions through semantic Tags

Status: Accepted on 2026-08-31

## Context

Questions often cross subject boundaries. Stored Tag assignments force Waxon or the Learner to decide which concepts count, maintain those decisions, and reconcile synonyms. A hierarchy adds parentage and restructuring problems without improving recall practice.

## Decision

Each Learner has a private, flat registry of English Tags. A Tag embedding represents its aliases, canonical label, and semantic description. Tags and Questions have embeddings in explicitly declared Embedding Spaces. Waxon calculates their relatedness at read time and compares only embeddings from the same space.

Questions have no stored Tag membership, assignment provenance, learner override, or Untagged state. Synonymous and overlapping Tags may coexist. Selecting several Tags ranks each Question by its strongest similarity to any selected Tag.

Tags organize the Library only. They do not change a Question's Recall Target, identity, Learning Evidence, or Review behavior. The first active space uses 512-dimensional `halfvec` embeddings from OpenAI `text-embedding-3-small` and exact cosine distance within one Learner's Library.

## Consequences

Waxon avoids assignment and ontology maintenance. A Question can be close to several Tags without storing relationships. Missing or incompatible embeddings produce no semantic result but never block Question creation or ordinary Library access.

Exact tenant-local scans fit Libraries containing thousands of Questions and Tags. The retrieval module hides data access so Waxon can later route Learners to shards without changing callers. Global approximate indexes are deliberately excluded because they would mix tenant scale with per-Learner retrieval.
