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
  validateQuestion(): Promise<{ passes: boolean; reasons: string[] }>;
};

export type ApplicationContractClock = {
  now(): Date;
  set(value: Date | string): void;
};

export type ApplicationContractHarness = {
  clock: ApplicationContractClock;
  semanticValidation: SemanticValidationController;
  provisionLearner(label: string): Promise<{
    id: string;
    direct: ReturnType<
      ReturnType<ApplicationContractModule["createWaxonApplication"]>["forLearner"]
    >;
    authorizedMcpClient: ReturnType<
      ReturnType<
        ApplicationContractModule["createWaxonApplication"]
      >["forAuthorizedMcpClient"]
    >;
  }>;
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
  const semanticValidation: SemanticValidationController = {
    setOutcome(outcome) {
      semanticValidationOutcome = outcome;
    },
    async validateQuestion() {
      return semanticValidationOutcome === "pass"
        ? { passes: true, reasons: [] }
        : {
            passes: false,
            reasons: [
              `Deterministic semantic validation ${semanticValidationOutcome}.`,
            ],
          };
    },
  };
  const application = createWaxonApplication({
    clock,
    evaluateAnswer: async ({ referenceAnswer }) => ({
      grade: "good",
      feedback: "The deterministic evaluator accepted the answer.",
      expectedAnswer: referenceAnswer,
      coveredPoints: ["Application contract"],
      missingPoints: [],
      demonstratedGap: null,
      confidence: 1,
    }),
    validateQuestion: semanticValidation.validateQuestion,
  });
  const productionFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Application contract tests must not call a live model.");
  };

  try {
    await run({
      clock,
      semanticValidation,
      async provisionLearner(label) {
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
          direct: application.forLearner(id),
          authorizedMcpClient: application.forAuthorizedMcpClient(id),
        };
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
        `DELETE FROM waxon_v2.review_sessions WHERE user_id = ANY($1::text[])`,
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
