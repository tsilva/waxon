---
type: Decision
title: User-scoped question dedupe
description: Duplicate detection runs across a user's full question knowledge base.
resource: app/lib/semanticDedupe.ts
tags: [dedupe, questions, embeddings, users]
timestamp: 2026-06-19T00:00:00Z
status: verified
confidence: high
source:
  - file:app/lib/semanticDedupe.ts
  - file:app/lib/reviewQueue.ts
---

# User-Scoped Question Dedupe

Waxon duplicate detection should treat the user's full question knowledge base as the comparison scope. The physical schema stores questions and embeddings directly under `user_id`, and semantic neighbor retrieval searches all questions owned by that user.

Runtime generation inserts accepted questions into the user's knowledge base, and exact slug checks, semantic neighbor retrieval, and judge decisions compare against all existing user questions.
