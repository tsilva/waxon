import { readFile } from "node:fs/promises";
import {
  QUESTION_SEARCH_EVAL_CASES,
  type QuestionSearchEvalCase,
} from "../tests/fixtures/question-search-eval.mts";

type EvaluationResult = {
  caseId: string;
  rank: number | null;
  advisory?:
    | "exact_duplicate"
    | "review_similar"
    | "no_close_match"
    | "search_incomplete";
};

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function recallAtTen(
  cases: readonly QuestionSearchEvalCase[],
  results: ReadonlyMap<string, EvaluationResult>,
): number {
  const positives = cases.filter((item) => item.label === "same_target");
  return percentage(
    positives.filter((item) => {
      const rank = results.get(item.id)?.rank;
      return typeof rank === "number" && rank >= 1 && rank <= 10;
    }).length,
    positives.length,
  );
}

const resultFlag = process.argv.find((value) => value.startsWith("--results="));
const counts = Object.fromEntries(
  ["same_target", "related_distinct", "unrelated"].map((label) => [
    label,
    QUESTION_SEARCH_EVAL_CASES.filter((item) => item.label === label).length,
  ]),
);
const strata = Object.fromEntries(
  [...new Set(QUESTION_SEARCH_EVAL_CASES.map((item) => item.stratum))].map(
    (stratum) => [
      stratum,
      QUESTION_SEARCH_EVAL_CASES.filter((item) => item.stratum === stratum)
        .length,
    ],
  ),
);

if (!resultFlag) {
  console.log(
    JSON.stringify(
      {
        datasetCases: QUESTION_SEARCH_EVAL_CASES.length,
        counts,
        strata,
        usage:
          "Pass --results=/path/to/results.json with [{caseId, rank, advisory}] to score retrieval output.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const resultPath = resultFlag.slice("--results=".length);
const parsed = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
if (!Array.isArray(parsed)) {
  throw new Error("Evaluation results must be a JSON array.");
}
const results = new Map<string, EvaluationResult>();
for (const item of parsed) {
  const result = item as Partial<EvaluationResult>;
  if (typeof result.caseId !== "string") continue;
  results.set(result.caseId, {
    caseId: result.caseId,
    rank: typeof result.rank === "number" ? result.rank : null,
    advisory: result.advisory,
  });
}
const overallRecall = recallAtTen(QUESTION_SEARCH_EVAL_CASES, results);
const criticalStrata = [
  ...new Set(
    QUESTION_SEARCH_EVAL_CASES.filter(
      (item) => item.critical && item.label === "same_target",
    ).map((item) => item.stratum),
  ),
];
const recallByCriticalStratum = Object.fromEntries(
  criticalStrata.map((stratum) => {
    const cases = QUESTION_SEARCH_EVAL_CASES.filter(
      (item) => item.stratum === stratum,
    );
    return [stratum, recallAtTen(cases, results)];
  }),
);
const exactAdvice = QUESTION_SEARCH_EVAL_CASES.filter(
  (item) => results.get(item.id)?.advisory === "exact_duplicate",
);
const exactPrecision = percentage(
  exactAdvice.filter((item) => item.label === "same_target").length,
  exactAdvice.length,
);
const gates = {
  datasetComplete: results.size === QUESTION_SEARCH_EVAL_CASES.length,
  overallRecallAtTen: overallRecall >= 0.98,
  criticalStrataRecallAtTen: Object.values(recallByCriticalStratum).every(
    (value) => value >= 0.95,
  ),
  exactDuplicatePrecision: exactPrecision === 1,
};
console.log(
  JSON.stringify(
    {
      datasetCases: QUESTION_SEARCH_EVAL_CASES.length,
      scoredCases: results.size,
      overallRecallAtTen: overallRecall,
      recallByCriticalStratum,
      exactDuplicatePrecision: exactPrecision,
      gates,
    },
    null,
    2,
  ),
);
if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
