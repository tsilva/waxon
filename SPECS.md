## HOW TO USE THIS FILE

- Before any task in this repository, read this compact product specification.
- Treat these specifications as required contracts and preserve them while working.
- Keep this file limited to durable, product-facing requirements; transient implementation notes, experiments, and debugging details must remain outside it.
- After any task, update this file when the user states a durable requirement, a requirement changes or is dropped, or the work reveals a durable product contract.
- Keep this file compact, accurate, and non-redundant by consolidating overlapping requirements rather than duplicating them.
- Put detailed operational guidance in the relevant reference or skill when it is necessary but too specific for this contract.

## PROJECT PURPOSE

Waxon is a multi-user, chat-first LLM tutor for any topic. It turns each learner's goal into an adaptive course that teaches section by section, checks understanding, and advances when the learner is ready. Learn minimizes time to understanding; answered questions enter one durable bank, and Review schedules free-text recall from past performance for lasting knowledge through short daily practice.

## PROJECT REQUIREMENTS

- Waxon must teach any topic without behavior specialized to current AI/ML test topics.
- Production must isolate each user's learning data.
- Sign-in and sign-up routes must render functional Clerk-hosted components; authentication fixes require verification of both flows.
- Unless directed otherwise, local product tests must use TCLV/Tiago and the current shared production database; they may bypass auth, must verify in-scope Review, Learn, Tags, and Admin access, and require explicit approval for destructive database actions.
- Learn must clarify goals too ambiguous for a coherent course before generating and following a topic table of contents.
- Normal tutor turns must default to one fresh question, without a prior-question resurfacing flow.
- Section readiness must reflect demonstrated understanding, never a fixed score. Weak answers keep the tutor on the section or a prerequisite. Progress is forward-only; the course completes only after advancing beyond the final table-of-contents section.
- Learn drives table-of-contents completion; Review owns retention practice.
- Tutor prose must be accurate, direct, informal, plain, sequential, free of internal plans, and use metaphors only for clarity.
- Widget turns require substantive teaching prose; questions and choices appear only in widgets, and objective- or planning-only fallbacks cannot be lessons.
- Answered widgets become pending or resolved evaluation rows; only the newest unanswered widget remains enabled.
- The Learn transcript is the immutable source of truth: never rewrite, fork, summarize, compact, or replace it. Context overflow must show a clear "course is too long to continue" error.
- The Learn UI must derive from transcript assistant messages and tool calls and responses.
- Transcript tool calls must create the table of contents, render questions, persist and evaluate review questions, advance sections, and complete courses; each widget answer must be the response to its tool call.
- Where supported, one LLM call must return evaluation, persistence, advancement, and lesson continuation, including the next teaching turn after advancement.
- Evaluation persistence must store a free-text review question, learner answer, and evaluation through the conversation tool protocol.
- Teaching, evaluation, and progression must remain one tool-call conversation without hidden app-side duplication; background work may add only non-teaching metadata without altering the transcript or blocking the learner.
- Learn prompts must avoid redundant stable instructions and keep a stable cacheable prefix; latency, cost, and cache optimizations must preserve teaching, readiness, and the single-conversation model.
- Waxon must use one question bank, with tags and provenance distinguishing topics and sources.
- Library alone manages the bank; Review handles due-item recall.
- Learn questions enter the bank only after answer, with answer and evaluation data.
- Learn widgets may use multiple choice for instruction, but all saved and resurfaced Review items must require free-text recall.
- Tag and provenance generation must not block saving or the next Learn interaction; provenance must identify the source, including Learn course and section when applicable.
- Knowledge-base and probing questions must satisfy `reference/question-quality.md`.
- Review must present due bank items and accept only free-text recall answers.
- Review must schedule longer intervals after repeated correct answers and shorter ones after failed or weak answers.
- Failed Review questions must reappear later in the session, never immediately next.
- Review must prioritize due questions most likely forgotten or incompletely understood from performance history.
- UI changes must follow `design-reference/design-system.md`; visual-fidelity changes must compare against `design-reference/waxon-approved-ui.png` and update `design-reference/fidelity-ledger.md`.
- Tag badges must be square, minimally rounded, and never pill-shaped.
