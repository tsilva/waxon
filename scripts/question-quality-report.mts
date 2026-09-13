import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExperimentResult } from "../shared/question-quality-experiment.mts";

const input = resolve(process.argv[2] ?? "test-results/question-quality/prompt-only.jsonl");
const output = `${input}.report.md`;
const manifest = JSON.parse(readFileSync(`${input}.manifest.json`, "utf8"));
const latest = new Map<string, ExperimentResult>();
for (const line of readFileSync(input, "utf8").split("\n").filter(Boolean)) {
  const result = JSON.parse(line) as ExperimentResult;
  latest.set(result.question.id, result);
}
const results = [...latest.values()].sort((a, b) => a.question.prompt.localeCompare(b.question.prompt));
const failures = results.filter((result) => result.evaluation && result.evaluation.recallResult !== "correct");
const errors = results.filter((result) => result.error);
const lines = [
  "# Question quality experiment", "",
  `Run: ${manifest.runId}`, "",
  `Answer model: ${manifest.answerModel}. Evaluator: ${manifest.evaluatorModel}. Optional answer-model reasoning: ${manifest.answerReasoning === false ? "disabled" : "provider default"}.`, "",
  "Each answer request contained one question and no answer standard, history, tags, or neighboring questions. Grades were evaluated in memory and retained in local experiment files only. They were not saved as learner submissions or learning evidence.", "",
  `Results in this checkpoint: ${results.filter((result) => result.evaluation?.recallResult === "correct").length} Correct, ${results.filter((result) => result.evaluation?.recallResult === "partial").length} Partial, ${results.filter((result) => result.evaluation?.recallResult === "incorrect").length} Incorrect, ${errors.length} request errors.`, "",
  "A non-correct result is a suspected question-quality issue. Answering-model mistakes and evaluator mistakes can produce the same result. Correct answers do not establish that a question is well written.", "",
  "## Questions for review", "",
];
for (const result of failures) {
  lines.push(`### ${result.question.prompt.replace(/\n/g, " ")}`, "",
    `Question ID: ${result.question.id}. Original state: ${result.question.lifecycle}. Evaluation: ${result.evaluation!.recallResult}.`, "",
    "**Evaluator feedback**", "", result.evaluation!.feedback, "",
    "**Stored answer standard**", "", result.question.referenceAnswer, "",
    "**DeepSeek answer**", "", result.answer ?? "Unavailable", "");
}
if (!failures.length) lines.push("No non-correct evaluations in this checkpoint.", "");
if (errors.length) {
  lines.push("## Requests needing retry", "");
  for (const result of errors) lines.push(`- ${result.question.id}: ${result.question.prompt.replace(/\n/g, " ")}: ${result.error}`, "");
}
writeFileSync(output, lines.join("\n"), { mode: 0o600 });
console.log(output);
