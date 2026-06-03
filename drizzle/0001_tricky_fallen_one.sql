CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "question_embeddings" (
	"id" serial PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "generated_from_question" text;--> statement-breakpoint
ALTER TABLE "question_embeddings" ADD CONSTRAINT "question_embeddings_question_questions_question_fk" FOREIGN KEY ("question") REFERENCES "public"."questions"("question") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "question_embeddings_question_model_idx" ON "question_embeddings" USING btree ("question","embedding_model");--> statement-breakpoint
CREATE INDEX "question_embeddings_model_question_idx" ON "question_embeddings" USING btree ("embedding_model","question");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_generated_from_question_questions_question_fk" FOREIGN KEY ("generated_from_question") REFERENCES "public"."questions"("question") ON DELETE set null ON UPDATE no action;
