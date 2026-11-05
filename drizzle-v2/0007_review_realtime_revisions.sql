CREATE TABLE "waxon_v2"."review_revisions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waxon_v2"."review_revisions" ADD CONSTRAINT "review_revisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "waxon_v2"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO waxon_v2.review_revisions (user_id, revision)
SELECT id, 0 FROM waxon_v2.users;
--> statement-breakpoint
-- Bump once per affected learner per statement, including bulk MCP additions.
-- The revision commits atomically with the domain change; rollbacks emit nothing.
CREATE FUNCTION waxon_v2.bump_review_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO waxon_v2.review_revisions AS revisions (user_id, revision)
    SELECT DISTINCT changed.user_id, 1 FROM new_rows changed
      JOIN waxon_v2.users learner ON learner.id = changed.user_id
      ORDER BY changed.user_id
    ON CONFLICT (user_id) DO UPDATE SET revision = revisions.revision + 1;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO waxon_v2.review_revisions AS revisions (user_id, revision)
    SELECT DISTINCT changed.user_id, 1 FROM old_rows changed
      JOIN waxon_v2.users learner ON learner.id = changed.user_id
      ORDER BY changed.user_id
    ON CONFLICT (user_id) DO UPDATE SET revision = revisions.revision + 1;
  ELSE
    INSERT INTO waxon_v2.review_revisions AS revisions (user_id, revision)
    SELECT changed.user_id, 1 FROM (
      SELECT user_id FROM old_rows UNION SELECT user_id FROM new_rows
    ) changed JOIN waxon_v2.users learner ON learner.id = changed.user_id
    ORDER BY changed.user_id
    ON CONFLICT (user_id) DO UPDATE SET revision = revisions.revision + 1;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE source_table text;
BEGIN
  FOREACH source_table IN ARRAY ARRAY[
    'questions', 'memory_states', 'answer_submissions', 'evaluations',
    'recall_result_corrections', 'grade_events', 'learner_settings'
  ] LOOP
    EXECUTE format('CREATE TRIGGER review_revision_insert AFTER INSERT ON waxon_v2.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION waxon_v2.bump_review_revision()', source_table);
    EXECUTE format('CREATE TRIGGER review_revision_update AFTER UPDATE ON waxon_v2.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION waxon_v2.bump_review_revision()', source_table);
    EXECUTE format('CREATE TRIGGER review_revision_delete AFTER DELETE ON waxon_v2.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION waxon_v2.bump_review_revision()', source_table);
  END LOOP;
END;
$$;
