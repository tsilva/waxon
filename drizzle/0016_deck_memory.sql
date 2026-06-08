ALTER TABLE "decks" ADD COLUMN "memory" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_memory_length_check" CHECK (length("memory") <= 12000);
