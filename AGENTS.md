# Repository Instructions

## Project Goal

Do not change this section unless the user explicitly asks to update the project goal.

This project is an app for building and retaining knowledge through adaptive question-and-answer practice. Users create or generate a question bank, answer from memory in their own words, and rely on Review to decide what to practice and when.

Every question is stored and resurfaced later based on the user's past performance. Once a user answers a question correctly, the app should help make that knowledge durable: if the user returns daily and completes their exercises, the system should schedule reviews near the point where mastery is likely to fade. This lets users maintain a large body of knowledge through short sessions focused on the questions most at risk of being forgotten.

## Product Specification

Before any task, read [SPECS.md](SPECS.md).

## Issue Threading

Before any fix or behavior-changing edit in this repo, especially behavior regressions, product-flow issues, auth/deploy/UI bugs, or user-reported breakage, use the project-level skill in [.codex/skills/waxon-issue-threading/SKILL.md](.codex/skills/waxon-issue-threading/SKILL.md).

## Questions

When creating, cleaning up, deduplicating, or generating knowledge-base questions and probing questions, use the shared question-quality reference in [reference/question-quality.md](reference/question-quality.md).

## UI Design

When making design, styling, layout, responsive UI, visual polish, or frontend interaction changes, use the repo design-system reference in [design-reference/design-system.md](design-reference/design-system.md). For visual fidelity work, compare against [design-reference/waxon-approved-ui.png](design-reference/waxon-approved-ui.png) and update [design-reference/fidelity-ledger.md](design-reference/fidelity-ledger.md) when the comparison changes.
