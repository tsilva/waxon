# Repository Instructions

## Project Goal

Do not change this section unless the user explicitly asks to update the project goal.

Waxon is an app for learning any topic through adaptive question-and-answer practice. A user states learning goals through courses or question-generation prompts, and the app expands from those goals into targeted questions that match the user's current knowledge while gradually covering the full topic.

Every question is stored and resurfaced later based on the user's past performance. Once a user answers a question correctly, Waxon should help make that knowledge durable: if the user returns daily and completes their exercises, the system should schedule reviews near the point where mastery is likely to fade. This lets users maintain a large body of knowledge through short sessions focused on the questions most at risk of being forgotten.

## Waxon Specs

Before any task in this repo, read the compact product specs in [SPECS.md](SPECS.md). Treat those specs as required contracts and preserve them while working. After any task, update [SPECS.md](SPECS.md) when the user states a durable requirement, a requirement changes or is dropped, or the work reveals a durable product contract. Keep the file compact, accurate, and non-redundant.

## Waxon Issue Threading

Before any Waxon fix or behavior-changing edit, especially behavior regressions, product-flow issues, Learn/auth/deploy/UI bugs, or user-reported breakage, use the project-level skill in [.codex/skills/waxon-issue-threading/SKILL.md](.codex/skills/waxon-issue-threading/SKILL.md).

## Waxon Questions

When creating, cleaning up, deduplicating, or generating knowledge-base questions and probing questions, use the shared question-quality reference in [reference/question-quality.md](reference/question-quality.md).

## Learn Experience Evaluation

When evaluating or tuning the Learn course experience for teaching quality, factual accuracy, beginner clarity, answer-to-next-material latency, or tutor/evaluator model choice, use the project-level skill in [.codex/skills/evaluate-learn-experience/SKILL.md](.codex/skills/evaluate-learn-experience/SKILL.md).

## Waxon UI Design

When making design, styling, layout, responsive UI, visual polish, or frontend interaction changes, use the repo design-system reference in [design-reference/design-system.md](design-reference/design-system.md). For visual fidelity work, compare against [design-reference/waxon-approved-ui.png](design-reference/waxon-approved-ui.png) and update [design-reference/fidelity-ledger.md](design-reference/fidelity-ledger.md) when the comparison changes.
