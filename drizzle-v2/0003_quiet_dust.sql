CREATE UNIQUE INDEX "sources_user_kind_checksum_unique" ON "waxon_v2"."sources" USING btree ("user_id","kind","checksum") WHERE "waxon_v2"."sources"."kind" <> 'direct' AND "waxon_v2"."sources"."checksum" IS NOT NULL;--> statement-breakpoint
ALTER TYPE "waxon_v2"."source_status" ADD VALUE 'needs_attention' BEFORE 'failed';--> statement-breakpoint
ALTER TYPE "waxon_v2"."source_status" ADD VALUE 'cancelled' BEFORE 'rejected_limit';
