---
name: measure-model-effective-stats-tui
description: Measure a Waxon Learn model's effective blended TUI performance stats, including latency, throughput, cost, prompt-cache hit percentage mean/std, cache writes, failures, and rollback behavior. Use when Codex is asked to benchmark, compare, or characterize a specific Learn model id through terminal learner runs, especially in multi-agent orchestrations where each agent receives a fixed server port.
---

# Measure Model Effective Stats TUI

Measure the real learner-facing behavior of one model by running Waxon's Learn TUI through multiple fresh courses and aggregating the resulting trace metrics. The goal is an effective blended report, not a synthetic provider benchmark.

## Required Inputs

- Require `model_id`. If it is missing, ask for it before running anything.
- Require `port`. The orchestrator must provide a fixed port for this agent. If it is missing, ask for it before launching a server.
- Accept optional `run_id`, `course_count`, `turns_per_course`, `topic_set`, and `base_url`.
- Default `course_count` to 5. Use at least 3 only for a quick smoke run and label it as such.
- Default `turns_per_course` to 4 answered widget turns after course creation, unless the model or budget fails earlier.

Do not silently substitute the default Waxon model. Do not use `--port auto` in this skill. The fixed-port requirement is an explicit exception for multi-agent model-stat runs.

## Guardrails

- Read `AGENTS.md` and `SPECS.md` first. Preserve the Learn contracts while measuring.
- Use `scripts/learn_tui.py` as the primary exercise path. Do not create courses or submit learner answers through raw API shortcuts.
- Use raw API calls only for measurement support: `/api/admin/traces`, `/api/courses/chat/prompt-preview`, `/api/user`, or health checks.
- Keep data non-destructive. Fresh courses are allowed; deleting or mutating unrelated courses is not.
- If the Learn flow breaks, stop and report the breakage before treating metrics as valid.
- If a request asks for optimization as well as measurement, keep measurement and code changes separated: baseline, patch, rerun, then compare.

## Launch On The Fixed Port

1. Capture the current branch, commit, dirty files, `model_id`, `port`, and UTC start time.
2. Check whether the requested port is already listening:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

If anything is listening on that port, stop and report `port_in_use` to the orchestrator. Do not kill the process and do not pick a different port.

3. Launch the server with all relevant model variables pinned to the requested model:

```bash
LLM_MODEL="<model_id>" \
LLM_LEARN_MODEL="<model_id>" \
LLM_EVALUATION_MODEL="<model_id>" \
pnpm dev --port "<port>"
```

Use `http://localhost:<port>` as `base_url` unless the orchestrator provides a different URL. Report the printed URL.

4. Confirm the local test user can access the app:

```bash
curl -fsS "http://localhost:<port>/api/user"
```

Local development should authenticate as `eng.tiago.silva@gmail.com`, which also allows `/api/admin/traces`.

## Prove The Requested Model Is In Use

Before collecting stats, prove that the running server is using `model_id`.

1. Start one fresh TUI course with `--raw-events`:

```bash
python3 -B scripts/learn_tui.py \
  --base-url "http://localhost:<port>" \
  --new "Learn CNNs for images" \
  --raw-events \
  --no-color
```

2. After the course exists, use `/raw` inside the TUI, or POST `/api/courses/chat/prompt-preview` for that course id, and verify `modelRequest.model` equals `model_id`.
3. Fetch `/api/admin/traces` after the first model calls and verify every run-window Learn call has `call.model === model_id`.
4. If any learner-facing call uses a different model, invalidate the run, fix the launch environment, and restart with fresh courses.

Set all three env vars because Waxon has separate generic, Learn, and evaluation model selectors. A blended Learn run may include intake, TOC generation, tutor streaming, and answer decision/evaluation calls.

## Fresh Course Matrix

Use multiple fresh courses so the stats include cold starts, cache writes, and warm within-course turns. Preferred topics:

```text
Learn CNNs for images
Learn PPO in reinforcement learning
Learn linear regression
Learn SQL joins
Learn Bayes rule
```

Use a consistent answer pattern across models:

```text
turn 1: mostly correct, concise
turn 2: partial answer with one misconception
turn 3: wrong but plausible answer
turn 4: clarification-seeking answer that still attempts the question
```

Answer the rendered widget in the TUI. The submitted request must carry `message.widgetAnswer`; do not bypass the widget by posting hand-built chat payloads. After each answer, wait for the SSE `done` event and press Enter when the TUI asks.

For concurrent same-model agents, ask the orchestrator for a unique `run_id`. If traces may otherwise be ambiguous, append a compact label such as `(benchmark <run_id>)` to every topic in every compared model run, and mention that this label was part of the measured prompt.

## Collect Evidence

For each course and turn, record:

- `course_id`, topic, and created-at time.
- TUI transcript path or captured terminal log.
- Raw SSE `done.latencyMetrics`: `answer_decision_ms`, `time_to_first_delta_ms`, `chat_stream_ms`, and `rollback_count`.
- `turnCost` from SSE `done`.
- Whether a widget rendered, whether the answered widget became an evaluation row, and whether the newest unanswered widget appeared.
- Any `error`, `rollback`, missing `done`, or unexpected evaluation skip.

After every course, fetch traces immediately because the trace store returns the most recent 200 interactions:

```bash
curl -fsS "http://localhost:<port>/api/admin/traces" > "/tmp/waxon-traces-<run_id>.json"
```

Trace calls expose:

```text
interaction.id, interaction.title, interaction.kind, interaction.startedAt
call.id, call.operation, call.model, call.callType, call.status, call.startedAt
call.inputTokens, call.outputTokens, call.cachedPromptTokens
call.uncachedPromptTokens, call.cacheWriteTokens, call.cacheHitPercent
call.cost, call.latencyMs, call.requestPayload, call.responsePayload
```

Filter traces by run window, `model_id`, and, when available, `run_id` or course-topic text in `interaction.title` / `call.requestPayload`. If unrelated calls cannot be excluded, mark the run contaminated instead of overclaiming precision.

## Compute Effective Stats

The primary blended population is every learner-facing LLM trace call caused by the fresh-course TUI runs. Include course intake, TOC generation, tutor streaming, answer decision/evaluation, and any Learn quality-gate calls that happen in the path. Exclude admin prompt-preview checks and unrelated background traces from the primary blend; list them separately if they occur.

For each population, compute:

- `n_calls`, `n_ok`, `n_error`, `n_courses`, `n_answered_turns`, and rollback count.
- Total input tokens, output tokens, cached prompt tokens, uncached prompt tokens, cache-write tokens, total tokens, and total cost.
- Latency from `call.latencyMs`: mean, sample stddev, p50, p90, min, max.
- User-visible timing from SSE `done.latencyMetrics`: same summary for answer decision, first delta, and chat stream.
- Throughput per call: `outputTokens / (latencyMs / 1000)`, excluding zero-output and zero-latency calls.
- Prompt-cache hit percent per call: use `call.cacheHitPercent` when present, else `cachedPromptTokens / inputTokens * 100` when `inputTokens > 0`.
- Prompt-cache hit percent mean and sample stddev across calls.
- Weighted prompt-cache hit percent: `sum(cachedPromptTokens) / sum(inputTokens) * 100`.
- Cache-write rate: `sum(cacheWriteTokens) / sum(inputTokens) * 100`.
- LLM calls per answered learner turn: `n_calls / n_answered_turns`.
- Warmup vs steady-state cache: compare course creation and first answer against later answers in the same course.

Use sample stddev (`n - 1`) when `n >= 2`; otherwise report `n/a`.

## Aggregation Helper

Use this as a local one-shot if helpful after saving `/api/admin/traces` to JSON. Adjust `RUN_LABEL` only when the run label was embedded in topics or payloads.

```bash
MODEL_ID="<model_id>" START_AT="<iso-start>" END_AT="<iso-end>" \
TRACE_JSON="/tmp/waxon-traces-<run_id>.json" RUN_LABEL="" node <<'NODE'
const fs = require("node:fs");
const model = process.env.MODEL_ID;
const startMs = Date.parse(process.env.START_AT);
const endMs = Date.parse(process.env.END_AT || new Date().toISOString());
const runLabel = process.env.RUN_LABEL || "";
const payload = JSON.parse(fs.readFileSync(process.env.TRACE_JSON, "utf8"));

function pct(call) {
  if (typeof call.cacheHitPercent === "number") return call.cacheHitPercent;
  if (call.inputTokens > 0) return ((call.cachedPromptTokens || 0) / call.inputTokens) * 100;
  return null;
}

function summarize(values) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.length > 1
    ? xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (xs.length - 1)
    : null;
  const at = (q) => xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))];
  return {
    n: xs.length,
    mean,
    stddev: variance === null ? null : Math.sqrt(variance),
    p50: at(0.5),
    p90: at(0.9),
    min: xs[0],
    max: xs[xs.length - 1],
  };
}

const rows = [];
for (const interaction of payload.interactions || []) {
  for (const call of interaction.calls || []) {
    const t = Date.parse(call.startedAt || interaction.startedAt);
    const haystack = `${interaction.title || ""}\n${call.requestPayload || ""}`;
    if (call.model !== model) continue;
    if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
    if (runLabel && !haystack.includes(runLabel)) continue;
    rows.push({ interaction, call });
  }
}

const calls = rows.map((row) => row.call);
const totals = calls.reduce((acc, call) => {
  acc.inputTokens += call.inputTokens || 0;
  acc.outputTokens += call.outputTokens || 0;
  acc.cachedPromptTokens += call.cachedPromptTokens || 0;
  acc.cacheWriteTokens += call.cacheWriteTokens || 0;
  acc.cost += call.cost || 0;
  acc.errors += call.status === "error" ? 1 : 0;
  return acc;
}, { inputTokens: 0, outputTokens: 0, cachedPromptTokens: 0, cacheWriteTokens: 0, cost: 0, errors: 0 });

const report = {
  model,
  nCalls: calls.length,
  nErrors: totals.errors,
  totalCost: totals.cost,
  totalInputTokens: totals.inputTokens,
  totalOutputTokens: totals.outputTokens,
  totalCachedPromptTokens: totals.cachedPromptTokens,
  totalCacheWriteTokens: totals.cacheWriteTokens,
  weightedCacheHitPercent: totals.inputTokens ? (totals.cachedPromptTokens / totals.inputTokens) * 100 : null,
  cacheWritePercent: totals.inputTokens ? (totals.cacheWriteTokens / totals.inputTokens) * 100 : null,
  latencyMs: summarize(calls.map((call) => call.latencyMs)),
  tokensPerSecond: summarize(calls.map((call) =>
    call.outputTokens > 0 && call.latencyMs > 0 ? call.outputTokens / (call.latencyMs / 1000) : NaN
  )),
  promptCacheHitPercent: summarize(calls.map(pct).filter((x) => x !== null)),
  byOperation: Object.fromEntries([...new Set(calls.map((call) => call.operation))].sort().map((operation) => {
    const subset = calls.filter((call) => call.operation === operation);
    return [operation, {
      nCalls: subset.length,
      totalCost: subset.reduce((sum, call) => sum + (call.cost || 0), 0),
      latencyMs: summarize(subset.map((call) => call.latencyMs)),
      promptCacheHitPercent: summarize(subset.map(pct).filter((x) => x !== null)),
    }];
  })),
};

console.log(JSON.stringify(report, null, 2));
NODE
```

This helper is not a substitute for the TUI run log or the SSE `done.latencyMetrics`; it only summarizes trace calls.

## Report Format

Return a compact report with:

```text
model_id:
port:
run_id:
commit:
started_at / ended_at:
course_count / answered_turns:
fresh courses: title -> course_id
model proof: prompt-preview model, trace model check

blended summary:
metric | n | mean | stddev | p50 | p90 | min | max | total/weighted

operation breakdown:
operation | calls | errors | cost | latency mean/std/p90 | cache hit mean/std | weighted cache hit | cache writes

course breakdown:
course | turns | calls | cost | first_delta mean | trace latency mean | weighted cache hit | rollbacks | issues

spec/flow checks:
widget submissions, evaluation rows, newest widget, errors, rollbacks, contamination

raw evidence:
trace ids, log paths, saved JSON path
```

End with one of:

- `valid`: the model was pinned, traces were unambiguous, all TUI turns completed, and stats are trustworthy.
- `valid with caveats`: stats are useful but have named limitations, such as small `n`, provider missing cache fields, or one recoverable rollback.
- `invalid`: wrong model, trace contamination, TUI breakage, missing trace data, or server/auth failure.
