ALTER TABLE "waxon_v2"."source_focus_stack" DROP CONSTRAINT "source_focus_stack_parent_gap_fk";
--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" DROP CONSTRAINT "source_learning_nodes_question_fk";
--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" DROP CONSTRAINT "source_learning_nodes_bridge_source_fk";
--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_focus_stack" ADD CONSTRAINT "source_focus_stack_parent_gap_fk" FOREIGN KEY ("user_id","parent_gap_node_id") REFERENCES "waxon_v2"."source_learning_nodes"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" ADD CONSTRAINT "source_learning_nodes_question_fk" FOREIGN KEY ("user_id","question_id") REFERENCES "waxon_v2"."questions"("user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waxon_v2"."source_learning_nodes" ADD CONSTRAINT "source_learning_nodes_bridge_source_fk" FOREIGN KEY ("user_id","bridge_source_id") REFERENCES "waxon_v2"."sources"("user_id","id") ON DELETE restrict ON UPDATE no action;