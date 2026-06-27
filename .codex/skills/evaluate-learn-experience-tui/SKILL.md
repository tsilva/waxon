---
name: evaluate-learn-experience-tui
description: Evaluate and improve Waxon's Learn course experience through the single-file terminal client only. Use when the user asks for a TUI-only Learn audit, terminal learner run, script-driven Learn experience validation, Learn quality/latency evaluation without browser testing, or updates to the TUI Learn evaluation workflow.
---

# Evaluate Learn Experience TUI

Evaluate Waxon's Learn flow by acting as a learner through `scripts/learn_tui.py`. This skill is TUI-only: do not use browser automation as the primary evidence path unless the user changes scope or a failure must be compared against the browser UI.

## Guardrails

- Read `SPECS.md` at the start and convert the relevant Product Scope, Learn Flow, Learn Architecture, Question Library, and touched Auth/UI requirements into an acceptance checklist.
- Keep fixing and rerunning the same TUI evidence path until every applicable checklist item is `pass`, `not applicable`, or genuinely `blocked`. A remaining `fail` means the task is not complete.
- Treat the TUI as an API replica, not a replacement product surface. Use it to exercise the same Learn calls and flow; do not accept terminal-only behavior that violates browser-visible product specs.
- Preserve the single conversation thread. Widget answers must be submitted through `message.widgetAnswer`, and answered turns must render as pending or resolved evaluation rows while the newest unanswered widget is available.
- Keep production and live data untouched unless the user explicitly asks for live validation or deploy work. Local runs use the TCLV/Tiago test account and the current shared production database, so avoid destructive data actions.
- Spec failures outrank latency, cache, model-cost, and TUI polish. Fix transcript, widget-history, evaluation, persistence, advancement, and question-library contract violations before tuning performance.
- Make small, reversible prompt/model/flow/script changes and add targeted tests for durable contracts.

## Setup

1. Capture branch and dirty files. Preserve unrelated changes.
2. Read `AGENTS.md`, `SPECS.md`, `scripts/learn_tui.py`, `app/api/courses/chat/route.ts`, `app/lib/courseGeneration.ts`, `app/lib/courseQuestionWidget.ts`, and `app/lib/openRouter.ts`.
3. Start the app with `pnpm dev --port auto`, report the printed URL, and do not kill or restart existing servers. If startup fails because auto ports are unsupported, stop and warn the user.
4. Run the TUI against the printed URL:

```bash
python3 -B scripts/learn_tui.py --base-url <printed-url>
```

Use these options as needed:

```bash
python3 -B scripts/learn_tui.py --base-url <printed-url> --list
python3 -B scripts/learn_tui.py --base-url <printed-url> --new "Learn CNNs for images"
python3 -B scripts/learn_tui.py --base-url <printed-url> --course-id <course-id> --raw-events
```

Use `/raw` inside the TUI to inspect the current prompt-preview payload after selecting a course.

## Loop

1. Establish baseline:
   Identify active Learn models and env overrides. Build a `SPECS.md` acceptance checklist with columns for spec, TUI exercise path, status, evidence, and fix required.

2. Use fixed beginner scenarios:
   Quick loop uses at least 3 topics; stronger loop uses 5. Preferred topics: CNNs for images, PPO in reinforcement learning, linear regression, SQL joins, Bayes rule. Cover correct, partial, confused, wrong, and clarification-seeking learner personas.

3. Run the TUI experience:
   Start or resume courses through `scripts/learn_tui.py`, answer at least 4 tutor questions per topic, and use rendered widgets instead of direct API shortcuts unless debugging the TUI script itself. After each widget answer and final SSE `done`, verify the transcript replacement shows the answered turn as a pending or resolved evaluation row and the newest unanswered widget as available.

4. Measure learner-facing fluidity:
   Record `answer_decision_ms`, `time_to_first_delta_ms`, `chat_stream_ms`, perceived wait to first visible next-material token, user-facing LLM calls per answer, single-continuation success/fallback rate, and prompt-cache usage: cached tokens, uncached tokens, cache-write tokens, and hit percentage. Use `--raw-events`, `/raw`, route logs, and persisted traces as evidence.

5. Judge teaching quality and spec compliance:
   Score factual accuracy, beginner clarity, jargon definition, concrete examples, question appropriateness, and progress decision quality from 1-5. Flag hallucinations, unexplained terms, big conceptual jumps, repetition, overly strict advancement, premature advancement, duplicate evaluation chatter, workflow artifacts, and every violated `SPECS.md` requirement.

6. Fix spec failures before tuning bottlenecks:
   For each checklist `fail`, identify the smallest root cause and patch it before performance tuning. Preserve the single conversation model. If no spec failures remain, tune the main learner-facing bottleneck: extra calls, answer grading, first-token delay, streaming length, model choice, request shape, deferred work, prompt-cache shape, or TUI observability.

7. Rerun and verify:
   Rerun the same topics and learner answers after meaningful changes. Keep changes only when specs pass and latency improves or stays acceptable without quality regression. Run `python3 -B scripts/learn_tui.py --help`, `python3 -B -m tabnanny scripts/learn_tui.py` when the TUI script changes, and `pnpm typecheck`, `pnpm test`, and `pnpm lint` unless docs-only.

8. Improve this skill when evidence warrants:
   If a run reveals a durable TUI Learn-evaluation workflow lesson, update this file concisely and validate with:

```bash
python3 /Users/tsilva/.codex/skills/.system/skill-creator/scripts/quick_validate.py .codex/skills/evaluate-learn-experience-tui
```

Ask before adding dependencies, external services, broad policy changes, or instructions affecting other skills.

## Report Format

Use a compact evidence table:

```text
topic | turn | answer type | tui path | llm_calls | answer_decision_ms | first_delta_ms | chat_stream_ms | cache hit/write | accuracy | clarity | issue
CNNs  | 2    | partial     | widget   | 1         | 820                | 1380           | 4100           | 4897/0          | 5/5      | 3/5    | "inductive bias" not defined
```

Then list:

- `Spec checklist`: each applicable `SPECS.md` item exercised, evidence, status, and fix. End with `Unfulfilled specs: none` or list the exact failed/blocked specs.
- `Flow metrics`: perceived wait, LLM calls per answer, single-continuation success/fallback rate, and prompt-cache reads/writes.
- `TUI observations`: transcript rendering, widget history, input ergonomics, raw-event usefulness, and any script defects.
- `Changes tried`: prompt/model/flow/TUI changes and why.
- `Kept changes`: only changes supported by rerun evidence.
- `Rejected changes`: faster or cleaner changes that harmed teaching, accuracy, fluidity, or mastery gating.
- `Skill updates`: self-update made, or `none`.
- `Next bottleneck`: the single best follow-up.
