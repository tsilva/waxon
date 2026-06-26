---
name: evaluate-learn-experience
description: Evaluate and improve Waxon's Learn course experience end to end. Use when the user asks Codex to act as a learner, audit Learn/course quality, validate beginner teaching quality, measure answer-to-next-material latency, tune Learn prompts, compare tutor/evaluator models, run a loop that improves the Learn flow through browser testing and metrics, or update this skill based on evidence from those runs.
---

# Evaluate Learn Experience

Improve Waxon's Learn flow with real learner-like runs. Optimize for a fluid single conversation that helps the user learn the subject efficiently and completely: minimal perceived latency, maximum prompt-cache reuse, fewest user-facing LLM calls, and evaluation evidence before advancement.

## Guardrails

- For substantive runs, create a Codex goal unless an active goal already covers the work. Mark it complete only after kept changes, verification, and final report.
- Use the real app flow. Start with `pnpm dev --port auto`, report the printed URL, and do not kill existing servers.
- For browser checks, use the native Codex Desktop in-app Browser via the bundled Browser skill/runtime before fallbacks.
- Keep production and live data untouched unless the user explicitly asks for live validation or deploy work.
- Preserve the single conversation thread by default. Prefer one streaming answer-continuation request that grades the latest answer, teaches the next smallest idea, and emits the next widget; measure any fallback to separate evaluator/tutor calls.
- Never trade away factual accuracy, beginner clarity, complete coverage, visible widget history, or `requireCourseMilestoneMastery()` for speed, caching, or lower call count.
- Make small, reversible prompt/model/flow changes and add targeted tests for durable contracts.

## Loop

1. Establish baseline:
   Capture branch and dirty files; identify active Learn models in `app/lib/openRouter.ts` and env; inspect `app/api/courses/chat/route.ts`, `app/lib/courseGeneration.ts`, and `app/(app)/learn/LearnPageClient.tsx`.

2. Use fixed beginner scenarios:
   Quick loop uses at least 3 topics; stronger loop uses 5. Preferred topics: CNNs for images, PPO in reinforcement learning, linear regression, SQL joins, Bayes rule. Cover correct, partial, confused, wrong, and clarification-seeking learner personas.

3. Run the browser experience:
   Start a course from `/learn`, answer at least 4 tutor questions per topic, and use inline widgets instead of API shortcuts unless debugging. After a widget answer and final SSE `done` or stored-message replacement, verify the answered widget remains visible as read-only history and the newest unanswered widget remains enabled.

4. Measure learner-facing fluidity:
   Record `answer_decision_ms`, `time_to_first_delta_ms`, `chat_stream_ms`, perceived wait to first visible next-material token, user-facing LLM calls per answer, single-continuation success/fallback rate, and prompt-cache usage: cached tokens, uncached tokens, cache-write tokens, and hit percentage. For cache work, inspect serialized requests for explicit `cache_control` breakpoints and stable versioned `session_id`; stable prompt ordering alone is not enough.

5. Judge teaching quality:
   Score factual accuracy, beginner clarity, jargon definition, concrete examples, question appropriateness, and progress decision quality from 1-5. Flag hallucinations, unexplained terms, big conceptual jumps, repetition, overly strict advancement, premature advancement, duplicate evaluation chatter, and workflow artifacts. Prefer rendered lesson/widget evidence over traces alone.

6. Tune only the bottleneck:
   If extra calls dominate, first seek a same-response single-thread solution. If answer grading dominates, tune evaluator prompt/model/JSON size. If first-token delay dominates, tune tutor model, request shape, streaming path, or deferred work. If streaming dominates, tune lesson length, model choice, or max tokens. For cache efficiency, keep immutable instructions and stable context before dynamic topic, progress, answer, and conversation fields; version `session_id` when changing cache boundaries. Do not pad prompts for cache unless real turns improve wall-clock latency without quality loss.

7. Rerun and verify:
   Rerun the same topics and learner answers after meaningful changes. Keep changes only when latency improves or stays acceptable and quality does not regress. Run `pnpm typecheck`, `pnpm test`, and `pnpm lint` unless docs-only. For UI/flow changes, complete at least one browser answer-submission-to-next-lesson check.

8. Improve this skill when evidence warrants:
   If a run reveals a durable Learn-evaluation workflow lesson, update this file concisely and validate with `python3 /Users/tsilva/.codex/skills/.system/skill-creator/scripts/quick_validate.py .codex/skills/evaluate-learn-experience`. Ask before adding scripts, dependencies, external services, broad policy changes, or instructions affecting other skills.

## Report Format

Use a compact evidence table:

```text
topic | turn | answer type | llm_calls | answer_decision_ms | first_delta_ms | chat_stream_ms | cache hit/write | accuracy | clarity | issue
CNNs  | 2    | partial     | 1         | 820                | 1380           | 4100           | 4897/0          | 5/5      | 3/5    | "inductive bias" not defined
```

Then list:

- `Flow metrics`: perceived wait, LLM calls per answer, single-continuation success/fallback rate, and prompt-cache reads/writes.
- `Changes tried`: prompt/model/flow changes and why.
- `Kept changes`: only changes supported by rerun evidence.
- `Rejected changes`: faster or cleaner changes that harmed teaching, accuracy, fluidity, or mastery gating.
- `Skill updates`: self-update made, or `none`.
- `Next bottleneck`: the single best follow-up.

## Model Guidance

- Use a fast evaluator for grading/progress decisions; Mercury is a good default when it returns reliable compact JSON.
- Use a stronger tutor when novice explanation quality, examples, or factual accuracy regress.
- Use a stronger judge only offline; do not put slow judge calls in the user-facing path.
- Always distinguish tutor-model latency from evaluator-model latency.
