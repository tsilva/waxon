CREATE TYPE "waxon_v2"."tag_override_decision" AS ENUM('include', 'exclude');--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_automatic_tags" (
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"confidence" double precision,
	"classifier_version" text NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_automatic_tags_pk" PRIMARY KEY("user_id","question_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_tag_overrides" (
	"user_id" text NOT NULL,
	"question_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"decision" "waxon_v2"."tag_override_decision" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_tag_overrides_pk" PRIMARY KEY("user_id","question_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."tag_aliases" (
	"user_id" text NOT NULL,
	"tag_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_aliases_pk" PRIMARY KEY("user_id","tag_id","normalized_alias"),
	CONSTRAINT "tag_aliases_user_normalized_unique" UNIQUE("user_id","normalized_alias")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."tag_embeddings" (
	"user_id" text NOT NULL,
	"tag_id" uuid NOT NULL,
	"model" text NOT NULL,
	"embedding_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" halfvec(512) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_embeddings_pk" PRIMARY KEY("user_id","tag_id","model","embedding_version")
);
--> statement-breakpoint
CREATE TABLE "waxon_v2"."tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"normalized_label" text NOT NULL,
	"scope_note" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_user_id_id_unique" UNIQUE("user_id","id")
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_automatic_tags" ADD CONSTRAINT "question_automatic_tags_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_automatic_tags" ADD CONSTRAINT "question_automatic_tags_tag_fk" FOREIGN KEY ("user_id","tag_id") REFERENCES "waxon_v2"."tags"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_tag_overrides" ADD CONSTRAINT "question_tag_overrides_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."question_tag_overrides" ADD CONSTRAINT "question_tag_overrides_tag_fk" FOREIGN KEY ("user_id","tag_id") REFERENCES "waxon_v2"."tags"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."tag_aliases" ADD CONSTRAINT "tag_aliases_tag_fk" FOREIGN KEY ("user_id","tag_id") REFERENCES "waxon_v2"."tags"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."tag_embeddings" ADD CONSTRAINT "tag_embeddings_tag_fk" FOREIGN KEY ("user_id","tag_id") REFERENCES "waxon_v2"."tags"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."tags" ADD CONSTRAINT "tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_automatic_tags_tag_idx" ON "waxon_v2"."question_automatic_tags" USING btree ("user_id","tag_id");--> statement-breakpoint
CREATE INDEX "question_tag_overrides_tag_idx" ON "waxon_v2"."question_tag_overrides" USING btree ("user_id","tag_id");--> statement-breakpoint
CREATE INDEX "tag_embeddings_lookup_idx" ON "waxon_v2"."tag_embeddings" USING btree ("user_id","model","embedding_version");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_active_normalized_label_unique" ON "waxon_v2"."tags" USING btree ("user_id","normalized_label") WHERE "waxon_v2"."tags"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tags_user_deleted_label_idx" ON "waxon_v2"."tags" USING btree ("user_id","deleted_at","label");