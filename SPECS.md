## PURPOSE

Waxon is a multi-user, chat-first LLM tutor for people learning any technical or non-technical topic. A learner states a goal, and the tutor turns that goal into an adaptive course that teaches one section at a time, checks understanding with questions, and advances only when the learner is ready.

Learn must build understanding in the minimum effective time and interactions. Every answered Learn question must become a durable review item in one unified question bank, and Review must resurface free-text recall questions according to the learner's past performance so that daily practice maintains a large body of knowledge with minimal effort.

## REQUIREMENTS

- This file must contain only durable, product-facing requirements; transient implementation notes, experiments, and debugging details must remain outside it.
- A durable requirement must be added, rewritten, or removed when product intent changes, and overlapping requirements must be consolidated rather than duplicated.
- Detailed operational guidance must live in the relevant reference or skill when it is necessary but too specific for this contract.
- Waxon must support learning any topic, and product behavior must not be specialized to the AI/ML topics used most often during current testing.
- Production must support multiple users without mixing their learning data.
- Local agent product testing must use the local TCLV/Tiago account and the current shared production database unless the user explicitly chooses another setup.
- Agents must not perform destructive actions against the shared production database without explicit user authorization.
- The tutor must ask for clarification when the learner's goal is too ambiguous to generate a coherent course structure.
- Learn must generate a table of contents for the learner's requested topic and use it as the forward course structure.
- The Learn transcript must remain the source of truth and must not be rewritten, forked, summarized, compacted, or replaced by a parallel representation.
- When the transcript can no longer fit within the available model context, Learn must show a clear "course is too long to continue" error rather than altering the transcript.
- Learner-facing tutor prose must be accurate, direct, informal, written in plain language, and ordered so that each idea prepares the learner for the next; metaphors must appear only when they clarify the material.
- Learner-facing prose must not expose internal objectives, widget-planning instructions, or next-question targets.
- A tutor turn that renders a question widget must also contain substantive teaching prose; objective-only or planning-only fallback text must not be accepted or stored as a completed lesson.
- A tutor turn that renders a question widget must keep the learner-facing question and answer choices in the widget rather than repeating them in the teaching prose.
- A normal tutor turn must default to one fresh question, and Learn must not add a separate flow for resurfacing previously asked Learn questions.
- After a weak answer, the tutor must remain on the current section or revisit a missing prerequisite before returning to that section.
- The tutor must decide section readiness from the learner's demonstrated understanding rather than from a fixed numeric score threshold.
- Section progress must move only forward through the table of contents.
- A course must complete only after the tutor advances beyond the final table-of-contents section.
- Learn must optimize for completing the table of contents; repeated retention practice must remain the responsibility of Review.
- After the learner answers a widget, that turn must render as a pending or resolved question-evaluation row rather than as an answerable widget.
- Only the newest unanswered question widget may remain enabled.
- Learn prompts and stable instructions must not contain redundant content that adds latency or reduces prompt-cache reuse.
- Learn must preserve a stable conversation prefix across turns so the model provider can reuse cached prompt content.
- Latency, cost, or prompt-cache optimizations must not weaken teaching accuracy, teaching quality, readiness decisions, or the single-conversation model.
- The rendered Learn UI must be derived from assistant messages, tool calls, and tool responses in the transcript.
- The tutor must use conversation tool calls to generate the table of contents, render a question widget, save and evaluate a review question, record section advancement, and complete the course.
- A learner's widget answer must enter the transcript as the tool response to that widget's tool call.
- When the tool protocol can return evaluation, persistence, advancement, and lesson continuation together, Learn must handle them in one LLM call rather than adding separate calls.
- Evaluation persistence must store a free-text review question together with the learner's answer and its evaluation through the conversation tool protocol.
- Section advancement must be emitted by the tutor through the conversation tool protocol and included with the next teaching turn when the protocol can carry both.
- Teaching, evaluation, and course progression must remain inside one tool-call conversation and must not be duplicated by hidden app-side workflows.
- Background work may generate embeddings, tags, provenance, or other non-teaching metadata only when it neither alters the Learn transcript nor blocks the learner's next interaction.
- Waxon must use one unified question bank, with tags and provenance distinguishing topics and sources.
- Every Learn question must enter the question bank after the learner answers it, never before, and the saved item must include the answer and evaluation data.
- Learn question widgets may use multiple choice when it benefits instruction, but every saved and resurfaced review item must be a free-text recall question.
- Tag and provenance generation must not block question saving or the next Learn interaction.
- A saved question's provenance must identify its source, including its Learn course and section when it originated in Learn.
- Knowledge-base and probing questions must satisfy `reference/question-quality.md`.
- Review must present question-bank items when they are due under the retention schedule.
- Review must accept free-text recall answers only.
- The retention schedule must assign longer intervals after repeated correct answers and shorter intervals after failed or weak answers.
- A failed Review question must reappear later in the same session but must not be the immediately following question.
- Review ordering must prioritize due questions whose performance history indicates that the learner is most likely to have forgotten or incompletely understood them.
- Sign-in and sign-up routes must render functional Clerk-hosted authentication components.
- An authentication fix is not accepted until the actual sign-in and sign-up flows have been verified.
- Local product-flow checks may bypass sign-in and sign-up, but they must use the local TCLV/Tiago user and verify access to Review, Learn, Tags, and Admin whenever those areas are in scope.
- UI changes must conform to `design-reference/design-system.md`.
- Visual-fidelity changes must be compared with `design-reference/waxon-approved-ui.png`, and `design-reference/fidelity-ledger.md` must be updated whenever that comparison changes.
- Tag badges must have square proportions with only a minimal corner radius and must not use a pill shape.
