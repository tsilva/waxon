---
type: Runbook
title: Admin trace purge
description: Clear Waxon's persisted admin trace data from Neon without deleting durable learning history.
resource: app/db/schema.ts
tags: [admin, traces, postgres, neon, operations]
timestamp: 2026-06-24T00:00:00Z
status: verified
confidence: high
source:
  - file:app/db/schema.ts
  - file:app/lib/llmTraceStore.ts
  - command:Neon transaction on 2026-06-24
---

# Admin Trace Purge

Persisted admin traces are stored in `llm_trace_interactions`. The transient evaluation-status table `answer_evaluations` references `llm_trace_interactions.id` through `trace_id` with `ON DELETE restrict`, so a purge must delete `answer_evaluations` before deleting trace interactions.

Use a transaction and verify counts before and after:

```sql
begin;

select
  (select count(*) from llm_trace_interactions) as trace_count,
  (select count(*) from answer_evaluations) as evaluation_count,
  (select count(*) from question_attempts) as question_attempt_count;

delete from answer_evaluations;
delete from llm_trace_interactions;

select
  (select count(*) from llm_trace_interactions) as trace_count,
  (select count(*) from answer_evaluations) as evaluation_count,
  (select count(*) from question_attempts) as question_attempt_count;

commit;
```

`question_attempts` is durable learning history and should not be deleted as part of an admin trace purge.
