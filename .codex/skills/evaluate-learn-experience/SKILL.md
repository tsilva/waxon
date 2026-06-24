---
name: evaluate-learn-experience
description: Evaluate and improve Waxon's Learn course experience end to end. Use when the user asks Codex to act as a learner, audit Learn/course quality, validate beginner teaching quality, measure answer-to-next-material latency, tune Learn prompts, compare tutor/evaluator models, run a loop that improves the Learn flow through browser testing and metrics, or update this skill based on evidence from those runs.
---

# Evaluate Learn Experience

Use this skill to run a tight product-quality loop over Waxon's Learn experience: simulate real beginner learners, measure the actual browser flow, judge teaching quality, tune prompts/models/flow, and rerun the same scenarios before accepting changes.

## Operating Rules

- Read `.agents/knowledge/index.md`, then the relevant Learn architecture notes before changing code.
- At the start of every substantive Learn evaluation or tuning run, create a Codex goal for the concrete objective unless an active goal already exists for the same work. Mark the goal complete only after the evaluation, kept changes, verification, knowledge updates, and final report are done; mark it blocked only under the platform's repeated-blocker rule.
- Use the real app flow, preferably in the browser. Start the dev server with `pnpm dev --port auto` and report the printed URL. If a server is already running, do not kill it.
- Use the native Codex Desktop in-app Browser for browser testing unless a more specific repo instruction overrides it. Load the bundled Browser skill/runtime, initialize `browser-client`, select the `iab` browser, and drive it through its documented Playwright/CUA APIs before using fallbacks.
- Keep production and live data untouched unless the user explicitly asks for live validation or deploy work.
- Treat speed and teaching quality as a joint target. Do not accept a faster flow that worsens factual accuracy, beginner clarity, or mastery gating.
- Make small, reversible prompt/model/flow changes. Preserve existing tests and add targeted tests for durable contracts.
- Record useful findings in `.agents/knowledge/experiments/` when the loop produces reusable evidence.
- Treat this skill as self-improving within its own scope. The user has granted standing permission to update this skill when an evaluation run reveals a durable bug in the workflow or a better way to perform the task.

## Loop

1. Establish the baseline.
   - Capture current branch and dirty files.
   - Identify active Learn models from `app/lib/openRouter.ts` and env defaults.
   - Inspect current Learn flow in `app/api/courses/chat/route.ts`, `app/lib/courseGeneration.ts`, and `app/(app)/learn/LearnPageClient.tsx`.

2. Choose fixed beginner scenarios.
   - Use at least 3 topics for a quick loop and 5 topics for a stronger loop.
   - Preferred set: CNNs for images, PPO in reinforcement learning, linear regression, SQL joins, and Bayes rule.
   - For each topic, define novice personas: correct, partial, confused, wrong, and "asks for clarification".

3. Run the browser experience.
   - Start a new course from `/learn`.
   - Answer at least 4 tutor questions per topic.
   - Use the inline question widgets when present; do not bypass the user-facing flow by calling APIs directly unless debugging.
   - After submitting a widget answer and receiving the final response, verify the answered widget remains visible as read-only history with the learner's answer, and the newest unanswered widget remains enabled. This catches regressions where hidden-widget-only questions disappear after evaluation or repeated fallback widget IDs disable the next question.
   - When judging rendered tutor text, wait for the final SSE `done` result or the stored-message replacement after streaming. Transient streamed deltas can include fragments that server repair removes before persistence.
   - Save screenshots or concise notes only when they reveal a concrete UX, teaching, or latency issue.

4. Measure latency from the user's perspective.
   - Capture `answer_decision_ms`, `time_to_first_delta_ms`, and `chat_stream_ms` from the course chat SSE `done` payload or stored trace surfaces.
   - Capture prompt-cache usage from course message metrics when provider usage reports it: cached prompt tokens, uncached prompt tokens, cache-write tokens, and cache-hit percentage.
   - Also record perceived wait from answer submission to first visible next-material token.
   - Separate fixed overhead from token throughput: high `tok/s` does not imply a snappy answer-to-next-turn transition.

5. Judge teaching quality.
   - Score each turn from 1-5 for factual accuracy, beginner clarity, jargon definition, concrete example quality, question appropriateness, and progress decision quality.
   - Flag any hallucinated facts, unexplained technical terms, too-large conceptual jumps, repetitive questions, overly strict advancement, or premature advancement.
   - Prefer evidence from the actual rendered lesson and question, not only model traces.

6. Tune only the bottleneck.
   - If `answer_decision_ms` dominates, tune the evaluator prompt, evaluator model, response size, JSON shape, or local deterministic handling.
   - If `time_to_first_delta_ms` dominates, tune the tutor model, request size, streaming start path, or whether noncritical work can move after first token.
   - If `chat_stream_ms` dominates, tune lesson length, model choice, or max token budget.
   - When tuning Learn prompts for cache efficiency, keep immutable instructions and stable context before dynamic topic, course, milestone, progress, answer, or conversation fields.
   - If teaching quality is weak, tune the tutor prompt and examples before touching latency.
   - If progress decisions are wrong, tune the evaluator or local mastery gate without weakening `requireCourseMilestoneMastery()`.

7. Rerun the same scenarios.
   - Use the same topics and learner answers after each meaningful change.
   - Compare before/after in a compact table.
   - Keep a change only when latency improves or stays acceptable and quality does not regress.

8. Verify before handoff.
   - Run `pnpm typecheck`, `pnpm test`, and `pnpm lint` unless the change is docs-only.
   - For UI/flow changes, complete at least one browser run through answer submission and next lesson streaming.
   - Summarize modified files, measured deltas, residual risks, and any skipped checks.

9. Improve this skill when the run teaches something reusable.
   - At the end of every use, review whether the skill caused friction, missed evidence, repeated a manual workaround, used the wrong measurement, or needed an instruction that would have prevented a bug.
   - Update `.codex/skills/evaluate-learn-experience/SKILL.md` immediately when the lesson is durable, evidence-backed, and specific to evaluating/tuning the Learn experience.
   - Keep self-updates concise. Add rules, measurement fields, scenario changes, or decision criteria; do not add narrative retrospectives.
   - Validate the skill after every self-update with `python3 /Users/tsilva/.codex/skills/.system/skill-creator/scripts/quick_validate.py .codex/skills/evaluate-learn-experience`.
   - Mention self-updates in the final handoff with the evidence that justified them.
   - Ask the user before adding new scripts, dependencies, external services, broad policy changes, or instructions that affect other skills.
   - Do not self-update from a single ambiguous observation, personal preference, transient provider outage, or a failed run that lacks a clear root cause.

## Report Format

Use a compact table for the core evidence:

```text
topic | turn | learner answer type | answer_decision_ms | first_delta_ms | chat_stream_ms | accuracy | beginner clarity | issue
CNNs  | 2    | partial             | 820                | 1380           | 4100           | 5/5      | 3/5              | "inductive bias" not defined
```

Then list:

- `Changes tried`: prompt/model/flow changes and why.
- `Kept changes`: only changes supported by the rerun.
- `Rejected changes`: faster or prettier changes that harmed teaching quality, accuracy, or mastery gating.
- `Skill updates`: any self-update made to this skill, or `none`.
- `Next bottleneck`: the single most useful follow-up.

## Model Guidance

- Use a fast evaluator model for answer grading and progress decisions. Mercury is a good default when it returns reliable compact JSON.
- Use a stronger tutor model when lesson quality, examples, or novice explanations regress.
- Use a stronger judge model only for offline evaluation if needed; do not put slow judge calls in the user-facing path.
- Always distinguish tutor-model latency from evaluator-model latency in the final analysis.
