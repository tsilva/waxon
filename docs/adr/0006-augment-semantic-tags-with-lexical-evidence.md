# Augment semantic Tags with lexical evidence

Status: Accepted on 2026-09-03

## Context

ADR 0005 made Tags semantic queries rather than stored Question properties. Dense similarity handles related concepts but can under-rank an exact acronym or name even after the Tag embedding includes that alias. Lowering one global semantic threshold enough to recover those matches also surfaces unrelated Tags.

## Decision

Waxon combines exact lexical evidence with compatible dense embeddings at read time. Lexical evidence comes only from whole-token or consecutive-phrase matches between a Question Prompt and an active Tag's English label or aliases. Repeated occurrences remain one Boolean signal, and Answer Standard text does not supply lexical evidence.

Semantic-only related Tags require similarity of at least 0.51. An exact lexical match may rescue a Tag when similarity is at least 0.40. Qualifying lexical matches rank ahead of semantic-only matches, followed by cosine distance and stable identity. Questions and Tags without compatible embeddings remain outside related-Tag results.

Waxon continues to calculate exact distances across one Learner's eligible Questions and Tags in PostgreSQL. No Question–Tag assignments, lexical index, approximate-nearest-neighbor index, or read-time model call is added. The semantic-search module keeps its existing interface and owns both signals.

## Consequences

Exact acronyms and names can appear without weakening the semantic-only threshold. Prompt-visible evidence explains every lexical rescue, while the lower embedding floor rejects weak incidental mentions. Exact scans preserve deterministic results and provide the reference behavior for later retrieval experiments.

The work remains linear in one Learner's Question and Tag counts. Waxon will retain exact scans while representative queries meet their latency targets. If large learner-local registries exceed those targets, a tenant-isolated approximate implementation may replace the exact adapter without changing callers; one global approximate index remains excluded.
