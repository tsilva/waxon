## HOW TO USE THIS FILE

- Before any task in this repository, read this compact product specification.
- Treat these specifications as required contracts and preserve them while working.
- Keep this file limited to durable, product-facing requirements; transient implementation notes, experiments, and debugging details must remain outside it.
- After any task, update this file when the user states a durable requirement, a requirement changes or is dropped, or the work reveals a durable product contract.
- Keep this file compact, accurate, and non-redundant by consolidating overlapping requirements rather than duplicating them.
- Put detailed operational guidance in the relevant reference or skill when it is necessary but too specific for this contract.

## PROJECT PURPOSE

Waxon is a multi-user, chat-first LLM tutor for any topic. It turns a learner's goal into an adaptive, section-by-section course that teaches, checks understanding, and advances when the learner is ready. Learn must build understanding with minimal time and interaction; every answered question enters one durable question bank, where Review schedules free-text recall from past performance to maintain knowledge with minimal daily practice.

## PROJECT REQUIREMENTS

- Waxon must teach any topic without specializing product behavior for current AI/ML test topics, and production must isolate each user's learning data.
- Sign-in and sign-up routes must render functional Clerk-hosted authentication components.
- An authentication fix is not accepted until the actual sign-in and sign-up flows have been verified.
- Local agent product tests must use the local TCLV/Tiago account and current shared production database unless the user chooses otherwise; destructive database actions require explicit authorization.
- Local product-flow checks may bypass sign-in and sign-up, but they must use the local TCLV/Tiago user and verify access to Review, Learn, Tags, and Admin whenever those areas are in scope.
- The tutor must ask for clarification when the learner's goal is too ambiguous to generate a coherent course structure.
- Learn must generate a table of contents for the learner's requested topic and use it as the forward course structure.
- A normal tutor turn must default to one fresh question; Learn must not add a separate flow for resurfacing prior Learn questions.
- After a weak answer, the tutor must remain on the current section or revisit a missing prerequisite before returning to that section.
- The tutor must decide section readiness from the learner's demonstrated understanding rather than from a fixed numeric score threshold.
- Section progress must move only forward, and a course must complete only after advancing beyond the final table-of-contents section.
- Learn must optimize for completing the table of contents; repeated retention practice must remain the responsibility of Review.
- Tutor prose must be accurate, direct, informal, plain, sequentially clear, and free of internal objectives, widget plans, or next-question targets; use metaphors only when clarifying.
- A question-widget turn must include substantive teaching prose, keep the question and choices only in the widget, and never accept or store objective-only or planning-only fallback text as a lesson.
- An answered widget must render as a pending or resolved evaluation row, not an answerable widget; only the newest unanswered widget may remain enabled.
- The Learn transcript must remain the unaltered source of truth: never rewrite, fork, summarize, compact, or replace it with a parallel representation.
- If the transcript exceeds model context, Learn must show a clear "course is too long to continue" error rather than alter it.
- The rendered Learn UI must be derived from assistant messages, tool calls, and tool responses in the transcript.
- The tutor must use conversation tool calls to generate the table of contents, render questions, save and evaluate review questions, advance sections, and complete courses.
- A learner's widget answer must enter the transcript as the tool response to that widget's tool call.
- When supported by the protocol, Learn must return evaluation, persistence, advancement, and lesson continuation in one LLM call, including advancement with the next teaching turn.
- Evaluation persistence must store a free-text review question together with the learner's answer and its evaluation through the conversation tool protocol.
- Teaching, evaluation, and progression must remain in one tool-call conversation without hidden app-side duplication; background work may add only non-teaching metadata and must neither alter the transcript nor block the learner.
- Learn prompts must avoid redundant stable instructions and preserve a stable conversation prefix for provider caching; latency, cost, and cache optimizations must not weaken teaching, readiness decisions, or the single-conversation model.
- Waxon must use one unified question bank, with tags and provenance distinguishing topics and sources.
- Library must be the single question-bank management surface; Review must remain focused on due-item recall practice.
- Every Learn question must enter the question bank only after it is answered, with its answer and evaluation data.
- Learn question widgets may use multiple choice when it benefits instruction, but every saved and resurfaced review item must be a free-text recall question.
- Tag and provenance generation must not block saving or the next Learn interaction; provenance must identify the source, including the Learn course and section when applicable.
- Knowledge-base and probing questions must satisfy `reference/question-quality.md`.
- Review must present due question-bank items and accept only free-text recall answers.
- The retention schedule must assign longer intervals after repeated correct answers and shorter intervals after failed or weak answers.
- A failed Review question must reappear later in the same session but must not be the immediately following question.
- Review ordering must prioritize due questions whose performance history indicates that the learner is most likely to have forgotten or incompletely understood them.
- UI changes must follow `design-reference/design-system.md`; visual-fidelity changes require comparison with `design-reference/waxon-approved-ui.png` and a corresponding `design-reference/fidelity-ledger.md` update.
- Tag badges must have square proportions with only a minimal corner radius and must not use a pill shape.
