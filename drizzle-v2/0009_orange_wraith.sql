CREATE TABLE "waxon_v2"."llm_trace_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" bigint NOT NULL,
	"status" text NOT NULL,
	"calls" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."mcp_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."mcp_credentials" ADD CONSTRAINT "mcp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "v2_llm_trace_interactions_started_at_idx" ON "waxon_v2"."llm_trace_interactions" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mcp_credentials_active_token_idx" ON "waxon_v2"."mcp_credentials" USING btree ("token_hash") WHERE "waxon_v2"."mcp_credentials"."revoked_at" IS NULL;