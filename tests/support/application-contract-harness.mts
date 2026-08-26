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
  semanticValidation: SemanticValidationController;
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
  const evaluateAnswer = async ({ referenceAnswer }: { referenceAnswer: string }) => ({
    grade: "good" as const,
    feedback: "The deterministic evaluator accepted the answer.",
    expectedAnswer: referenceAnswer,
    coveredPoints: ["Application contract"],
    missingPoints: [],
    demonstratedGap: null,
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
      semanticValidation,
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
