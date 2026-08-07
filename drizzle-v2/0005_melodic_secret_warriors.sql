ALTER TABLE "waxon_v2"."saved_views" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "waxon_v2"."saved_views" CASCADE;--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" DROP CONSTRAINT "coverage_targets_generation_run_fk";
--> statement-breakpoint
ALTER TABLE "waxon_v2"."coverage_targets" ADD CONSTRAINT "coverage_targets_generation_run_fk" FOREIGN KEY ("user_id","generation_run_id") REFERENCES "waxon_v2"."generation_runs"("user_id","id") ON DELETE cascade ON UPDATE no action;