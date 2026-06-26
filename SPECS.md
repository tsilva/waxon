# Waxon Specs

Durable product requirements for Waxon. Read this file before every task in this repo. After every task, update it when a durable requirement was learned, changed, or dropped.

## Product Summary

Waxon is a chat-first LLM tutor for learning any topic. The user says what they want to learn; the tutor clarifies if needed, generates a table of contents, teaches one section at a time, asks a fresh question through a tool-rendered widget, evaluates the answer, and advances only when the tutor judges the learner is ready. The Learn flow should feel like one fast, natural LLM conversation with tool access, not a set of hidden app-side workflows.

Every generated learning question becomes a durable review item in one unified, tagged question bank. Review then resurfaces due free-text recall questions on a performance-based retention schedule, so the user can build and retain a large body of knowledge with the minimum effective learning and review time.

## Spec Maintenance Rules

- Keep this file compact, product-facing, and non-redundant.
- Keep the product summary accurate as the product direction changes.
- Add new durable requirements when the user states them or a task reveals them.
- Remove or rewrite requirements when they are dropped, superseded, duplicated, or stale.
- Prefer merging related bullets over appending near-duplicates.
- Keep transient implementation notes, experiments, and one-off debugging details out of this file.
- Move detailed guidance to linked references or skills when detail is still needed.

## Product Scope

- Waxon should support learning any topic, including technical topics like AI/ML and non-technical topics like languages.
- Current testing is mostly deep learning and AI/ML, but product decisions should not overfit to that domain.
- The learner should learn content in the minimum effective time and interactions.
- Production should support multiple users.
- Local agent testing should use the local test account for Tiago and the current shared production database unless explicitly changed.
- Because local testing uses the shared production database for now, agents must avoid destructive data actions unless the user explicitly allows them.

## Learn Flow

- Learn is driven by a generated table of contents for the requested topic.
- The Learn transcript is the source of truth; do not rewrite, fork, summarize, compact, or otherwise hack the conversation.
- If context is exhausted, show a clear "course is too long to continue" error.
- Tutor prose should be informal, direct, accurate, simple, structured, sequential, and use helpful metaphors when they clarify.
- The tutor should generally ask one fresh question per turn; do not add a special resurfacing flow for previous Learn questions.
- Weak answers should keep the tutor on the same section or revisit prior prerequisite ideas before returning to the current section.
- Advancement is based on tutor judgment that the learner is ready, not on a hard score threshold.
- Section advancement only moves forward. A course completes when the tutor advances past the final table-of-contents section.
- Learn optimizes for completing the table of contents; durable retention drilling belongs to Review.
- After a learner answers a widget, the answered widget should remain visible as read-only history and the newest unanswered widget should remain enabled.

## Learn Architecture

- Learn should be very fast; keep system prompts and stable instructions as small as possible.
- Preserve a stable conversation prefix to maximize prompt caching, reduce cost, and reduce latency.
- Prompt-cache optimization is important but must not degrade teaching quality, accuracy, section-readiness decisions, or the conversation model.
- Rendering should be an intelligent interpretation of the conversation: assistant messages, tool calls, and tool responses determine what the UI shows.
- The LLM interacts with the app through tool calls: generate the table of contents, render a question widget, save/evaluate a review question, record section advancement, and complete the course.
- User answers to question widgets should enter the conversation as tool responses to the question tool call.
- Answer evaluation and lesson continuation should use the fewest LLM calls possible; prefer one call when the tool protocol can support it.
- Evaluation/persistence should be represented through tool calls that store a free-text review question plus answer/evaluation data.
- Section advancement should be emitted by the LLM through the conversation's tool protocol, preferably in the same call as the next teaching/question turn when possible.
- Keep Learn orchestration inside the tool-call conversation model; avoid app-side workarounds that create hidden parallel teaching or evaluation flows.
- Non-teaching background jobs are allowed for embeddings, tags, provenance, and other persistence work when they reduce latency and do not alter the Learn transcript or block the UX.

## Question Library

- Waxon uses one unified question bank; topics and sources are organized with tags and provenance.
- Every generated Learn question should be added to the question library so it can be reviewed later.
- Learn widgets may use multiple choice when useful, but durable review questions should be stored and resurfaced as free-text recall prompts.
- Tags and provenance can be generated after the question is saved and must not delay the learning flow.
- Question provenance should make it clear where a question came from, including Learn course and section context.
- Knowledge-base questions and probing questions must follow `reference/question-quality.md`.

## Review

- Review presents questions from the question library when they are due.
- Review questions should be free-text recall only for now.
- Scheduling should push repeatedly correct answers farther into the future and bring failed or weak answers back sooner.
- Failed review questions should reappear later in the same session, but not immediately as the next question.
- Review should prioritize questions the user is likely to have forgotten or not fully understood.

## Auth

- Sign-in and sign-up routes must render functional Clerk hosted UI components.
- Auth fixes should be verified on the actual sign-in/sign-up flow before treating the issue as resolved.

## UI

- UI changes must follow `design-reference/design-system.md`.
- Visual fidelity changes must compare against `design-reference/waxon-approved-ui.png` and update `design-reference/fidelity-ledger.md` when the comparison changes.
