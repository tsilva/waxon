CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_search_embeddings" (
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"question_version_id" uuid NOT NULL,
	"model" text NOT NULL,
	"source_version" integer NOT NULL,
	"source_hash" text NOT NULL,
	"embedding" halfvec(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_search_embeddings_pk" PRIMARY KEY("user_id","question_id","model","source_version")
);--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_search_embeddings" ADD CONSTRAINT "question_search_embeddings_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_search_embeddings" ADD CONSTRAINT "question_search_embeddings_version_fk" FOREIGN KEY ("user_id","question_version_id") REFERENCES "waxon_v2"."question_versions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_search_embeddings_lookup_idx" ON "waxon_v2"."question_search_embeddings" USING btree ("user_id","model","source_version");--> statement-breakpoint
DROP INDEX IF EXISTS "waxon_v2"."question_versions_prompt_search_idx";--> statement-breakpoint
CREATE INDEX "question_versions_current_search_idx" ON "waxon_v2"."question_versions" USING gin ((
	setweight(to_tsvector('simple', coalesce("prompt", '')), 'A') ||
	setweight(to_tsvector('simple', coalesce("reference_answer", '')), 'B')
)) WHERE "is_current" = true;--> statement-breakpoint
CREATE INDEX "question_versions_current_prompt_trgm_idx" ON "waxon_v2"."question_versions" USING gist ("prompt" gist_trgm_ops) WHERE "is_current" = true;--> statement-breakpoint
CREATE INDEX "questions_user_target_idx" ON "waxon_v2"."questions" USING btree ("user_id","target_key");
