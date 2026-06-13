---
type: Codebase Note
title: Project goal and product boundaries
description: Waxon teaches any topic through adaptive free-text question practice and durable spaced review.
resource: AGENTS.md
tags: [product, learning, review, decks]
timestamp: 2026-06-13T17:26:41Z
status: verified
confidence: high
source:
  - file:AGENTS.md
  - file:README.md
---

# Project Goal

Waxon is an app for learning any topic through adaptive question-and-answer practice. A user states a learning goal in a deck, and the app expands from that goal into targeted questions that match the user's current knowledge while gradually covering the full topic.

Every question is stored and resurfaced later based on the user's past performance. After a correct answer, Waxon should schedule future review near the point where mastery is likely to fade, so daily use keeps a large body of knowledge durable through short sessions focused on at-risk questions.

# Boundaries Future Agents Should Preserve

* Decks are centered on a user learning goal.
* Questions are durable stored learning objects, not disposable generated prompts.
* Review scheduling should be based on user performance history.
* Correct answers should feed long-term retention, not just immediate completion.
* For deck question work, use the shared quality reference at `reference/question-quality.md`.
* For design and visual UI work, use `design-reference/design-system.md`; for visual fidelity work, compare against `design-reference/waxon-approved-ui.png` and update `design-reference/fidelity-ledger.md` when the comparison changes.

# Citations

* `AGENTS.md` Project Goal and repository instructions.
* `README.md` overview and notes.
