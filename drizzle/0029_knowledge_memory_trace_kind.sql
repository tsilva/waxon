ALTER TABLE "llm_trace_interactions" ADD CONSTRAINT "llm_trace_interactions_kind_transition_check" CHECK ("kind" IN (
  'Answer evaluation',
  'Question generation',
  'Reference answer',
  'Embedding',
  'Deck memory',
  'Knowledge memory',
  'Quality gate',
  'Summarization',
  'Other'
)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "llm_trace_interactions" VALIDATE CONSTRAINT "llm_trace_interactions_kind_transition_check";
--> statement-breakpoint
ALTER TABLE "llm_trace_interactions" DROP CONSTRAINT IF EXISTS "llm_trace_interactions_kind_check";
--> statement-breakpoint
UPDATE "llm_trace_interactions"
SET "kind" = 'Knowledge memory'
WHERE "kind" = 'Deck memory';
--> statement-breakpoint
ALTER TABLE "llm_trace_interactions" ADD CONSTRAINT "llm_trace_interactions_kind_check" CHECK ("kind" IN (
  'Answer evaluation',
  'Question generation',
  'Reference answer',
  'Embedding',
  'Knowledge memory',
  'Quality gate',
  'Summarization',
  'Other'
)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "llm_trace_interactions" VALIDATE CONSTRAINT "llm_trace_interactions_kind_check";
--> statement-breakpoint
ALTER TABLE "llm_trace_interactions" DROP CONSTRAINT "llm_trace_interactions_kind_transition_check";
