ALTER TABLE "llm_trace_interactions" DROP CONSTRAINT IF EXISTS "llm_trace_interactions_kind_check";
--> statement-breakpoint
TRUNCATE TABLE "llm_trace_interactions";
--> statement-breakpoint
ALTER TABLE "llm_trace_interactions" ADD CONSTRAINT "llm_trace_interactions_kind_check" CHECK ("kind" IN (
  'Answer evaluation',
  'Question generation',
  'Reference answer',
  'Embedding',
  'Deck memory',
  'Quality gate',
  'Summarization',
  'Other'
));
--> statement-breakpoint
INSERT INTO "llm_trace_interactions" (
  "id",
  "title",
  "kind",
  "started_at",
  "status",
  "calls",
  "updated_at"
)
SELECT DISTINCT ON ("answer_evaluations"."trace_id")
  "answer_evaluations"."trace_id",
  'Answer evaluation: ' || left("answer_evaluations"."question", 90),
  'Answer evaluation',
  "answer_evaluations"."submitted_at",
  CASE
    WHEN "answer_evaluations"."status" = 'grading' THEN 'pending'
    WHEN "answer_evaluations"."justification" LIKE 'LLM evaluation failed%' THEN 'error'
    ELSE 'ok'
  END,
  jsonb_build_array(
    jsonb_build_object(
      'id', "answer_evaluations"."trace_id",
      'operation', CASE
        WHEN "answer_evaluations"."justification" = 'Matches the expected answer.' THEN 'evaluate_answer_exact_match'
        WHEN "answer_evaluations"."justification" LIKE 'LLM evaluation failed%' THEN 'evaluate_answer_legacy_failure'
        ELSE 'evaluate_answer_legacy_backfill'
      END,
      'model', 'legacy-backfill',
      'callType', 'answer_eval',
      'inputTokens', 0,
      'outputTokens', 0,
      'cost', 0,
      'latencyMs', greatest(
        0,
        coalesce(
          "answer_evaluations"."resolved_at",
          "answer_evaluations"."updated_at",
          "answer_evaluations"."submitted_at"
        ) - "answer_evaluations"."submitted_at"
      ),
      'status', CASE
        WHEN "answer_evaluations"."status" = 'grading' THEN 'pending'
        WHEN "answer_evaluations"."justification" LIKE 'LLM evaluation failed%' THEN 'error'
        ELSE 'ok'
      END,
      'startedAt', to_char(
        to_timestamp("answer_evaluations"."submitted_at" / 1000.0) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    )
  )::text,
  greatest(
    coalesce(
      "answer_evaluations"."resolved_at",
      "answer_evaluations"."updated_at",
      "answer_evaluations"."submitted_at"
    ),
    "answer_evaluations"."submitted_at"
  )
FROM "answer_evaluations"
ORDER BY "answer_evaluations"."trace_id", "answer_evaluations"."submitted_at" DESC;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_evaluations_trace_id_idx"
ON "answer_evaluations" USING btree ("trace_id");
--> statement-breakpoint
ALTER TABLE "answer_evaluations" ADD CONSTRAINT "answer_evaluations_trace_id_llm_trace_interactions_id_fk"
FOREIGN KEY ("trace_id") REFERENCES "public"."llm_trace_interactions"("id")
ON DELETE restrict ON UPDATE no action;
