-- Run only after:
-- 1. the Stage One code and migrations have been deployed;
-- 2. retained counts match scripts/lean-core-preflight.mts output;
-- 3. the complete Review journey has passed in production;
-- 4. the uploaded-blob inventory has been reviewed and separately deleted.

BEGIN;

DROP TABLE IF EXISTS waxon_v2.review_session_item_path_nodes;
ALTER TABLE waxon_v2.review_session_items DROP COLUMN IF EXISTS source_context;

DROP TABLE IF EXISTS waxon_v2.source_focus_stack;
DROP TABLE IF EXISTS waxon_v2.source_learning_edges;
DROP TABLE IF EXISTS waxon_v2.source_learning_nodes;
DROP TABLE IF EXISTS waxon_v2.source_learning_paths;
DROP TABLE IF EXISTS waxon_v2.target_questions;
DROP TABLE IF EXISTS waxon_v2.question_evidence;
DROP TABLE IF EXISTS waxon_v2.target_evidence;
DROP TABLE IF EXISTS waxon_v2.evidence_spans;
DROP TABLE IF EXISTS waxon_v2.coverage_targets;
DROP TABLE IF EXISTS waxon_v2.generation_run_artifacts;
DROP TABLE IF EXISTS waxon_v2.generation_runs;
DROP TABLE IF EXISTS waxon_v2.source_materials;
DROP TABLE IF EXISTS waxon_v2.source_versions;
DROP TABLE IF EXISTS waxon_v2.sources;

DROP TABLE IF EXISTS waxon_v2.question_concepts;
DROP TABLE IF EXISTS waxon_v2.concept_aliases;
DROP TABLE IF EXISTS waxon_v2.concepts;
DROP TABLE IF EXISTS waxon_v2.question_embeddings;
DROP TABLE IF EXISTS waxon_v2.question_relations;
DROP TABLE IF EXISTS waxon_v2.repair_drafts;

ALTER TABLE waxon_v2.question_versions DROP COLUMN IF EXISTS target_text;
ALTER TABLE waxon_v2.question_versions DROP COLUMN IF EXISTS quality_decision;
ALTER TABLE waxon_v2.question_versions DROP COLUMN IF EXISTS quality_reasons;
ALTER TABLE waxon_v2.question_versions DROP COLUMN IF EXISTS duplicate_of_question_id;
ALTER TABLE waxon_v2.question_versions DROP COLUMN IF EXISTS learner_attested;

DROP TYPE IF EXISTS waxon_v2.source_kind;
DROP TYPE IF EXISTS waxon_v2.source_status;
DROP TYPE IF EXISTS waxon_v2.source_material_kind;
DROP TYPE IF EXISTS waxon_v2.generation_run_status;
DROP TYPE IF EXISTS waxon_v2.target_requirement;
DROP TYPE IF EXISTS waxon_v2.coverage_status;
DROP TYPE IF EXISTS waxon_v2.learning_path_status;
DROP TYPE IF EXISTS waxon_v2.learning_path_node_kind;
DROP TYPE IF EXISTS waxon_v2.quality_decision;

COMMIT;
