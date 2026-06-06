ALTER TABLE "decks" ADD COLUMN "coverage" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_coverage_length_check" CHECK (length("coverage") <= 2000);
