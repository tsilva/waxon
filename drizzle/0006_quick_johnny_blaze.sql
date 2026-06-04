CREATE TABLE "llm_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"provider" text DEFAULT 'openrouter' NOT NULL,
	"user_id" text,
	"deck_id" text,
	"question" text,
	"requested_model" text NOT NULL,
	"returned_model" text,
	"generation_id" text,
	"status" text NOT NULL,
	"http_status" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"cost" numeric,
	"latency_ms" integer NOT NULL,
	"usage" jsonb,
	"error" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_calls_generation_idx" ON "llm_calls" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "llm_calls_user_created_idx" ON "llm_calls" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_deck_created_idx" ON "llm_calls" USING btree ("deck_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_operation_created_idx" ON "llm_calls" USING btree ("operation","created_at");