# Question quality experiment

These auxiliary scripts run from the repository root:

- [`scripts/question-quality-experiment.mts`](../scripts/question-quality-experiment.mts) runs the experiment, checkpoints results, and optionally applies question flags.
- [`scripts/question-quality-report.mts`](../scripts/question-quality-report.mts) creates a Markdown report from a checkpoint without model requests or database access.
- [`shared/question-quality-experiment.mts`](../shared/question-quality-experiment.mts) contains the request isolation, retry, concurrency, and feedback helpers used by the experiment.

Each question is sent alone to `deepseek/deepseek-v4.1-flash` with only “Answer the following question” and the prompt. The answer standard, tags, history, and other questions are excluded. Optional DeepSeek reasoning is explicitly disabled for a fast baseline, and provider parameter support is required. DeepSeek requests prioritize provider throughput; routing can still use different providers for the same model. This measures that configuration, not the model at its strongest reasoning setting. The resulting answer goes through Waxon's production `evaluateRecall` and `evaluateRecallWithRetries` functions, using `LLM_EVALUATION_MODEL` and its existing normalization.

The best result is `correct`. FSRS grades are not calculated because they depend on learner history. A `partial` or `incorrect` result is a suspected quality issue, which can also result from answering-model mistakes or evaluator mistakes.

Run a two-question pilot:

```sh
keyenv run -- pnpm question-quality:experiment --limit 2 --concurrency 2
```

Resume across the complete bank and flag non-correct results:

```sh
keyenv run -- pnpm question-quality:experiment --limit all --concurrency 4 --apply-flags
```

Without `--apply-flags`, the database is read-only. With it, only question lifecycle and flag feedback are written after evaluations finish. Existing flags are preserved. Archived questions are evaluated but remain archived. Changed questions are skipped when applying flags. Transport errors, empty answers, truncated answers, and model identity mismatches do not become flags.

No answer submissions, evaluations, answer grades, scheduling evidence, or database LLM traces are saved. The script removes database environment variables before calling the evaluator. Its explicit read connection enforces read-only transactions. Results, model answers, evaluator feedback, and run metadata are saved locally under ignored `test-results/question-quality/` with private file permissions. Do not commit these learner data files.

Concurrency defaults to four and is capped at sixteen. Each worker handles one independent answer-and-evaluation pair. Transient DeepSeek transport and HTTP errors are retried with bounded backoff; evaluator failures use the production retry path. A valid non-correct result is not retried to fish for a passing grade. After five consecutive failed questions, dispatch stops and in-flight work finishes. The summary counts unprocessed questions and exits with a failure status; rerun to resume after provider recovery.

`--user-id` is required when multiple banks exist. Without it, the script only selects a bank when there is exactly one. `--limit` defaults to two and includes all lifecycles in creation order. `--output` selects the JSONL checkpoint path. Completed results are reused only for unchanged prompts and answer standards; errors are retried, reusing a completed model answer when only evaluation failed. A manifest rejects resumes with changed learner, models, or experiment/evaluator code. Flag insertion is idempotent within a run.

Generate a readable local report with each non-correct question, its answer standard, DeepSeek answer, and evaluator feedback:

```sh
pnpm question-quality:report
```

Pass a JSONL path as the report command's first argument to inspect a different run. The report describes completed checkpoint results and lists request errors separately.

In the September 2026 run, high concurrency caused repeated response-body timeouts. Four workers recovered most failed requests, so start with that default and increase only if the provider remains responsive. The existing evaluator also has a 900-token completion cap shared with Gemini reasoning; this can truncate structured JSON. Such cases remain evaluation errors and never become automatic quality flags.
