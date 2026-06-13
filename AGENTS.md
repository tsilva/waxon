# Repository Instructions

## Project Goal

Do not change this section unless the user explicitly asks to update the project goal.

Waxon is an app for learning any topic through adaptive question-and-answer practice. A user states a learning goal in a deck, and the app expands from that goal into targeted questions that match the user's current knowledge while gradually covering the full topic.

Every question is stored and resurfaced later based on the user's past performance. Once a user answers a question correctly, Waxon should help make that knowledge durable: if the user returns daily and completes their exercises, the system should schedule reviews near the point where mastery is likely to fade. This lets users maintain a large body of knowledge through short sessions focused on the questions most at risk of being forgotten.

## Waxon Deck Questions

When creating, cleaning up, deduplicating, or generating deck questions and probing questions, use the shared question-quality reference in [reference/question-quality.md](reference/question-quality.md).

## Project Knowledge

Use `.agents/knowledge/` as the shared project knowledge bundle. At the start of every task, read `.agents/knowledge/index.md` and any relevant concept files before making changes. During work, add or update knowledge only when it is durable, evidence-backed, and useful to future agents. At the end of every task, explicitly consider whether the work produced new durable knowledge or invalidated existing knowledge; if so, update the bundle before handing control back. Put uncertain notes in `.agents/knowledge/inbox/` with `status: draft`; promote them only after verification. Do not store secrets, credentials, chain-of-thought, private customer data, or large raw logs.

## Waxon UI Design

When making design, styling, layout, responsive UI, visual polish, or frontend interaction changes, use the repo design-system reference in [design-reference/design-system.md](design-reference/design-system.md). For visual fidelity work, compare against [design-reference/waxon-approved-ui.png](design-reference/waxon-approved-ui.png) and update [design-reference/fidelity-ledger.md](design-reference/fidelity-ledger.md) when the comparison changes.
