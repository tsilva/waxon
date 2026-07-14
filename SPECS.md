## HOW TO USE THIS FILE

- Before any task in this repository, read this compact product specification.
- Treat these specifications as required contracts and preserve them while working.
- Keep this file limited to durable, product-facing requirements; transient implementation notes, experiments, and debugging details must remain outside it.
- After any task, update this file when the user states a durable requirement, a requirement changes or is dropped, or the work reveals a durable product contract.
- Keep this file compact, accurate, and non-redundant by consolidating overlapping requirements rather than duplicating them.
- Put detailed operational guidance in the relevant reference or skill when it is necessary but too specific for this contract.

## PROJECT PURPOSE

Waxon is a multi-user system for building and retaining a durable body of knowledge through free-text question-and-answer practice. Users manage one question bank, while Review decides what and when to practice from past performance so short daily sessions strengthen recall and surface incomplete understanding without requiring the learner to plan topics or review days.

## PROJECT REQUIREMENTS

- Waxon must support questions about any topic without behavior specialized to current AI/ML test topics.
- Production must isolate each user's learning data.
- Sign-in and sign-up routes must render functional Clerk-hosted components; authentication fixes require verification of both flows.
- Unless directed otherwise, local product tests must use TCLV/Tiago and the current shared production database; they may bypass auth, must verify in-scope Review, Library, Tags, and Admin access, and require explicit approval for destructive database actions.
- Waxon must use one question bank, with tags and provenance distinguishing topics and sources.
- Library alone manages the bank; Review handles due-item recall.
- New questions may be entered manually or generated from a user prompt and must be saved with provenance.
- Tag and provenance enrichment must not block saving a question.
- Knowledge-base and probing questions must satisfy `reference/question-quality.md`.
- Review must present due bank items and accept only free-text recall answers.
- Review must schedule longer intervals after repeated correct answers and shorter ones after failed or weak answers.
- Failed Review questions must reappear later in the session, never immediately next.
- Review must own study allocation so the learner does not need to plan topics, practice duration, or review days; it must prioritize and revisit questions according to forgetting risk, uncertainty, and incomplete understanding rather than fixed or equal rotation.
- UI changes must follow `design-reference/design-system.md`; visual-fidelity changes must compare against `design-reference/waxon-approved-ui.png` and update `design-reference/fidelity-ledger.md`.
- Tag badges must be square, minimally rounded, and never pill-shaped.
