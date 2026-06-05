CREATE TABLE "llm_trace_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" bigint NOT NULL,
	"status" text NOT NULL,
	"calls" text NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "llm_trace_interactions_id_nonempty_check" CHECK (length(trim("llm_trace_interactions"."id")) > 0),
	CONSTRAINT "llm_trace_interactions_title_nonempty_check" CHECK (length(trim("llm_trace_interactions"."title")) > 0),
	CONSTRAINT "llm_trace_interactions_kind_check" CHECK ("llm_trace_interactions"."kind" IN ('Answer submitted', 'Question generation', 'Reference answer')),
	CONSTRAINT "llm_trace_interactions_status_check" CHECK ("llm_trace_interactions"."status" IN ('ok', 'pending', 'error')),
	CONSTRAINT "llm_trace_interactions_started_at_check" CHECK ("llm_trace_interactions"."started_at" >= 0),
	CONSTRAINT "llm_trace_interactions_updated_at_check" CHECK ("llm_trace_interactions"."updated_at" >= "llm_trace_interactions"."started_at")
);
--> statement-breakpoint
CREATE INDEX "llm_trace_interactions_started_at_idx" ON "llm_trace_interactions" USING btree ("started_at" DESC NULLS LAST);