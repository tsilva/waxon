import { randomUUID } from "node:crypto";

export const APPLICATION_CONTRACT_TEST_DATABASE_URL =
  process.env.APPLICATION_CONTRACT_TEST_DATABASE_URL ??
  process.env.QUESTION_SEARCH_TEST_DATABASE_URL;

type ApplicationContractModule = typeof import(
  "../../app/lib/v2/application.ts"
);

export type SemanticValidationOutcome =
  | "pass"
  | "fail"
  | "inconclusive"
  | "unavailable";

export type SemanticValidationController = {
  setOutcome(outcome: SemanticValidationOutcome): void;
  validateQuestion(): Promise<
    | { outcome: "pass"; reasons: [] }
    | {
        outcome: "fail" | "inconclusive" | "unavailable";
        reasons: string[];
      }
  >;
};

export type ApplicationContractClock = {
  now(): Date;
  set(value: Date | string): void;
};

export type EvaluationController = {
  setRecallResult(result: "incorrect" | "partial" | "correct"): void;
};

type ApplicationContractLearner = {
  id: string;
  direct: ReturnType<
    ReturnType<ApplicationContractModule["createWaxonApplication"]>["forLearner"]
  >;
  authorizedMcpClient: ReturnType<
    ReturnType<
      ApplicationContractModule["createWaxonApplication"]
    >["forAuthorizedMcpClient"]
  >;
};

export type ApplicationContractHarness = {
  clock: ApplicationContractClock;
  evaluation: EvaluationController;
  semanticValidation: SemanticValidationController;
  databaseCatalog(): Promise<{
    tables: string[];
    learnerSettingColumns: string[];
    questionColumns: string[];
    answerSubmissionColumns: string[];
    evaluationColumns: string[];
    gradeEventColumns: string[];
    questionSearchEmbeddingColumns: string[];
    questionVersionIdLocations: string[];
    obsoleteContractObjects: string[];
    enumValues: Record<string, string[]>;
  }>;
  setQuestionLifecycle(
    learnerId: string,
    questionId: string,
    lifecycle: "flagged",
  ): Promise<void>;
  provisionLearner(label: string): Promise<ApplicationContractLearner>;
  provisionDefaultLearner(label: string): Promise<ApplicationContractLearner>;
};

export async function withApplicationContract(
  run: (harness: ApplicationContractHarness) => Promise<void>,
): Promise<void> {
  const databaseUrl = APPLICATION_CONTRACT_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "APPLICATION_CONTRACT_TEST_DATABASE_URL or QUESTION_SEARCH_TEST_DATABASE_URL is required.",
    );
  }

  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_URL_UNPOOLED = databaseUrl;
  process.env.WAXON_QUESTION_SEARCH_MODE = "lexical";

  const [{ createWaxonApplication }, { getV2Client }] = await Promise.all([
    import("../../app/lib/v2/application.ts"),
    import("../../app/db/v2/client.ts"),
  ]);
  const { pool } = getV2Client();
  const createdLearnerIds = new Set<string>();
  let currentTime = new Date("2030-08-20T10:00:00.000Z");
  const clock: ApplicationContractClock = {
    now: () => new Date(currentTime),
    set(value) {
      currentTime = new Date(value);
    },
  };
  let semanticValidationOutcome: SemanticValidationOutcome = "pass";
  let evaluationRecallResult: "incorrect" | "partial" | "correct" = "correct";
  const evaluation: EvaluationController = {
    setRecallResult(result) {
      evaluationRecallResult = result;
    },
  };
  const semanticValidation: SemanticValidationController = {
    setOutcome(outcome) {
      semanticValidationOutcome = outcome;
    },
    async validateQuestion() {
      if (semanticValidationOutcome === "unavailable") {
        throw new Error("Deterministic semantic validation is unavailable.");
      }
      if (semanticValidationOutcome === "pass") {
        return { outcome: "pass", reasons: [] };
      }
      return {
        outcome: semanticValidationOutcome,
        reasons: [
          semanticValidationOutcome === "fail"
            ? "not_atomic"
            : "semantic_validation_inconclusive",
        ],
      };
    },
  };
  const evaluateAnswer = async () => ({
    recallResult: evaluationRecallResult,
    coveredPoints:
      evaluationRecallResult === "incorrect" ? [] : ["Application contract"],
    scoringIssues:
      evaluationRecallResult === "correct"
        ? []
        : ["Required application contract knowledge was missing"],
    clarifications: [],
    confidence: 1,
  });
  const application = createWaxonApplication({
    clock,
    evaluateAnswer,
    validateQuestion: semanticValidation.validateQuestion,
  });
  const defaultApplication = createWaxonApplication({ clock, evaluateAnswer });
  const productionFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Application contract tests must not call a live model.");
  };

  try {
    async function provisionLearner(
      label: string,
      selectedApplication: typeof application,
    ): Promise<ApplicationContractLearner> {
      const id = `application-contract-${randomUUID()}`;
      const email = `${id}@example.test`;
      await pool.query(
        `INSERT INTO waxon_v2.users (id, display_name, email)
         VALUES ($1, $2, $3)`,
        [id, label, email],
      );
      createdLearnerIds.add(id);
      return {
        id,
        direct: selectedApplication.forLearner(id),
        authorizedMcpClient: selectedApplication.forAuthorizedMcpClient(id),
      };
    }
    await run({
      clock,
      evaluation,
      semanticValidation,
      async databaseCatalog() {
        const [
          tables,
          learnerSettingColumns,
          questionColumns,
          answerSubmissionColumns,
          evaluationColumns,
          gradeEventColumns,
          questionSearchEmbeddingColumns,
          enumValues,
          questionVersionIdLocations,
          obsoleteContractObjects,
        ] =
          await Promise.all([
            pool.query<{ tableName: string }>(
              `SELECT table_name AS "tableName"
                 FROM information_schema.tables
                WHERE table_schema = 'waxon_v2'
                ORDER BY table_name`,
            ),
            pool.query<{ columnName: string }>(
              `SELECT column_name AS "columnName"
                 FROM information_schema.columns
                WHERE table_schema = 'waxon_v2'
                  AND table_name = 'learner_settings'
                ORDER BY ordinal_position`,
            ),
            pool.query<{ columnName: string }>(
              `SELECT column_name AS "columnName"
                 FROM information_schema.columns
                WHERE table_schema = 'waxon_v2'
                  AND table_name = 'questions'
                ORDER BY ordinal_position`,
            ),
            pool.query<{ columnName: string }>(
              `SELECT column_name AS "columnName"
                 FROM information_schema.columns
                WHERE table_schema = 'waxon_v2'
                  AND table_name = 'answer_submissions'
                ORDER BY ordinal_position`,
            ),
            pool.query<{ columnName: string }>(
              `SELECT column_name AS "columnName"
                 FROM information_schema.columns
                WHERE table_schema = 'waxon_v2'
                  AND table_name = 'evaluations'
                ORDER BY ordinal_position`,
            ),
            pool.query<{ columnName: string }>(
              `SELECT column_name AS "columnName"
                 FROM information_schema.columns
                WHERE table_schema = 'waxon_v2'
                  AND table_name = 'grade_events'
                ORDER BY ordinal_position`,
            ),
            pool.query<{ columnName: string }>(
              `SELECT column_name AS "columnName"
                 FROM information_schema.columns
                WHERE table_schema = 'waxon_v2'
                  AND table_name = 'question_search_embeddings'
                ORDER BY ordinal_position`,
            ),
            pool.query<{ enumName: string; enumValue: string }>(
              `SELECT type.typname AS "enumName", enum.enumlabel AS "enumValue"
                 FROM pg_type type
                 JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
                 JOIN pg_enum enum ON enum.enumtypid = type.oid
                WHERE namespace.nspname = 'waxon_v2'
                ORDER BY type.typname, enum.enumsortorder`,
            ),
            pool.query<{ location: string }>(
              `SELECT table_name || '.' || column_name AS location
                 FROM information_schema.columns
                WHERE table_schema = 'waxon_v2'
                  AND column_name = 'question_version_id'
                ORDER BY table_name`,
            ),
            pool.query<{ objectName: string }>(
              `SELECT 'constraint:' || constraint_name AS "objectName"
                 FROM information_schema.table_constraints
                WHERE constraint_schema = 'waxon_v2'
                  AND constraint_name IN (
                    'answer_submissions_version_fk',
                    'question_search_embeddings_version_fk',
                    'question_embeddings_version_fk',
                    'question_evidence_version_fk',
                    'question_versions_question_fk'
                  )
                UNION ALL
               SELECT 'index:' || indexname AS "objectName"
                 FROM pg_indexes
                WHERE schemaname = 'waxon_v2'
                  AND indexname LIKE 'question_versions_%'
                ORDER BY "objectName"`,
            ),
          ]);
        const valuesByEnum: Record<string, string[]> = {};
        for (const row of enumValues.rows) {
          valuesByEnum[row.enumName] = [
            ...(valuesByEnum[row.enumName] ?? []),
            row.enumValue,
          ];
        }
        return {
          tables: tables.rows.map((row) => row.tableName),
          learnerSettingColumns: learnerSettingColumns.rows.map(
            (row) => row.columnName,
          ),
          questionColumns: questionColumns.rows.map((row) => row.columnName),
          answerSubmissionColumns: answerSubmissionColumns.rows.map(
            (row) => row.columnName,
          ),
          evaluationColumns: evaluationColumns.rows.map((row) => row.columnName),
          gradeEventColumns: gradeEventColumns.rows.map((row) => row.columnName),
          questionSearchEmbeddingColumns:
            questionSearchEmbeddingColumns.rows.map((row) => row.columnName),
          questionVersionIdLocations: questionVersionIdLocations.rows.map(
            (row) => row.location,
          ),
          obsoleteContractObjects: obsoleteContractObjects.rows.map(
            (row) => row.objectName,
          ),
          enumValues: valuesByEnum,
        };
      },
      async setQuestionLifecycle(learnerId, questionId, lifecycle) {
        await pool.query(
          `UPDATE waxon_v2.questions
              SET lifecycle = $3, updated_at = $4
            WHERE user_id = $1 AND id = $2`,
          [learnerId, questionId, lifecycle, clock.now()],
        );
      },
      provisionLearner(label) {
        return provisionLearner(label, application);
      },
      provisionDefaultLearner(label) {
        return provisionLearner(label, defaultApplication);
      },
    });
  } finally {
    globalThis.fetch = productionFetch;
    const ids = [...createdLearnerIds];
    if (ids.length > 0) {
      await pool.query(
        `DELETE FROM waxon_v2.answer_submissions WHERE user_id = ANY($1::text[])`,
        [ids],
      );
      await pool.query(
        `DELETE FROM waxon_v2.questions WHERE user_id = ANY($1::text[])`,
        [ids],
      );
      await pool.query(
        `DELETE FROM waxon_v2.users WHERE id = ANY($1::text[])`,
        [ids],
      );
    }
    await pool.end();
  }
}
