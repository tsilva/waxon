CREATE TABLE "waxon_v2"."embedding_spaces" (
	"id" smallint PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "embedding_spaces_key_unique" UNIQUE("key")
);
--> statement-breakpoint
INSERT INTO "waxon_v2"."embedding_spaces" ("id", "key")
VALUES (1, 'openai:text-embedding-3-small:512:topic-v1');
--> statement-breakpoint
CREATE TABLE "waxon_v2"."question_embeddings" (
	"user_id" text NOT NULL,
	"space_id" smallint NOT NULL,
	"question_id" uuid NOT NULL,
	"embedding" halfvec NOT NULL,
	CONSTRAINT "question_embeddings_pk" PRIMARY KEY("user_id","space_id","question_id"),
	CONSTRAINT "question_embeddings_space_id_embedding_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "waxon_v2"."embedding_spaces"("id"),
	CONSTRAINT "question_embeddings_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO "waxon_v2"."question_embeddings"
  ("user_id", "space_id", "question_id", "embedding")
SELECT "user_id", 1, "question_id", "embedding"::halfvec
  FROM "waxon_v2"."question_search_embeddings"
 WHERE "model" IN ('openai/text-embedding-3-small', 'text-embedding-3-small')
   AND "embedding_version" = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TABLE "waxon_v2"."tag_embeddings_semantic" (
	"user_id" text NOT NULL,
	"space_id" smallint NOT NULL,
	"tag_id" uuid NOT NULL,
	"embedding" halfvec NOT NULL,
	CONSTRAINT "tag_embeddings_semantic_pk" PRIMARY KEY("user_id","space_id","tag_id"),
	CONSTRAINT "tag_embeddings_semantic_space_fk" FOREIGN KEY ("space_id") REFERENCES "waxon_v2"."embedding_spaces"("id"),
	CONSTRAINT "tag_embeddings_semantic_tag_fk" FOREIGN KEY ("user_id","tag_id") REFERENCES "waxon_v2"."tags"("user_id","id") ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO "waxon_v2"."tag_embeddings_semantic"
  ("user_id", "space_id", "tag_id", "embedding")
SELECT "user_id", 1, "tag_id", "embedding"::halfvec
  FROM "waxon_v2"."tag_embeddings"
 WHERE "model" IN ('openai/text-embedding-3-small', 'text-embedding-3-small')
   AND "embedding_version" = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "waxon_v2"."jobs" WHERE "type" = 'classify_question_tags';
--> statement-breakpoint
DROP TABLE "waxon_v2"."question_automatic_tags" CASCADE;
--> statement-breakpoint
DROP TABLE "waxon_v2"."question_tag_overrides" CASCADE;
--> statement-breakpoint
DROP TABLE "waxon_v2"."tag_aliases" CASCADE;
--> statement-breakpoint
DROP TABLE "waxon_v2"."question_search_embeddings" CASCADE;
--> statement-breakpoint
DROP TABLE "waxon_v2"."tag_embeddings" CASCADE;
--> statement-breakpoint
ALTER TABLE "waxon_v2"."tag_embeddings_semantic" RENAME TO "tag_embeddings";
--> statement-breakpoint
ALTER TABLE "waxon_v2"."tag_embeddings" RENAME CONSTRAINT "tag_embeddings_semantic_pk" TO "tag_embeddings_pk";
--> statement-breakpoint
ALTER TABLE "waxon_v2"."tag_embeddings" RENAME CONSTRAINT "tag_embeddings_semantic_space_fk" TO "tag_embeddings_space_id_embedding_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE "waxon_v2"."tag_embeddings" RENAME CONSTRAINT "tag_embeddings_semantic_tag_fk" TO "tag_embeddings_tag_fk";
--> statement-breakpoint
DROP TYPE "waxon_v2"."tag_override_decision";
