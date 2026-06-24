---
type: Architecture Note
title: Application architecture overview
description: Waxon is a Next.js app using Neon Postgres, Drizzle, Clerk/local test auth, in-memory queue state, and LLM grading.
resource: README.md
tags: [architecture, nextjs, postgres, auth, llm, review]
timestamp: 2026-06-13T17:26:41Z
status: verified
confidence: high
source:
  - file:README.md
  - file:package.json
  - file:app/db/schema.ts
---

# Overview

Waxon is a Next.js application for typed recall practice. It serves due questions, grades submitted answers through an OpenRouter-compatible LLM API, stores score history in Postgres through Drizzle, and schedules each next review from the resulting score.

# Main Runtime Components

* The app uses Next.js with React and API routes under `app/api/`.
* Database storage uses Neon Postgres through Drizzle. The schema lives in `app/db/schema.ts`, and generated migrations live in `drizzle/`.
* Login and signup use Clerk in deployed environments. Local development can use a test-user flow so app routes are testable without a Clerk browser session.
* Public static pages (`/`, `/privacy-policy`, `/terms-and-conditions`) intentionally bypass the authenticated client provider shell and Clerk middleware fast path to avoid loading auth/third-party scripts before the user enters the app. They use the trimmed root global stylesheet; auth pages use a minimal auth-only stylesheet; authenticated pages keep the fuller app stylesheet in the route-group layout. Shared fonts are local CSS `@font-face` assets rather than root-level preloads; font URLs in CSS should use content-hashed filenames under `public/fonts/` because `/fonts/:path*` is served with long immutable cache headers.
* Static-first app shell pages bypass Clerk middleware in `proxy.ts` so document requests can serve directly. Private data remains server-protected through `/api/*` and `/admin*`, and signed-out users are redirected by the shared client auth gate after the shell loads.
* Clerk auth pages lazy-load the sign-in/sign-up widgets after the user clicks the static fallback action. The nested provider that mounts `<SignIn>` or `<SignUp>` must allow Clerk UI loading; setting `prefetchUI={false}` there causes `Clerk was not loaded with Ui components` and crashes the auth page. Keep `prefetchUI={false}` only on app-shell providers that do not mount Clerk hosted UI components.
* Static-first authenticated pages should use `app/(app)/AuthenticatedClientHydrator.tsx` for the repeated dynamic client import, `AuthenticatedProviders`, and static-shell inert/hide behavior. Route-specific hydrators should stay thin wrappers that provide the client loader, initial props, and static selector.
* Static shell headers reserve the right-side toolbar slot with `reader-actions-placeholder`; `PersistentReviewToolbarActions` must stay mounted inside `AuthenticatedProviders` so the due count and signed-in user menu/avatar appear after client auth hydration. The persistent actions should be anchored to the document/header slot, not `position: fixed`, so they scroll away with the toolbar instead of floating over review content.
* `PersistentReviewToolbarActions` should not fetch or cache due counts on its own. The visible header due count is the total due review count, published by the hydrated Review app after a lightweight `/api/queue-status` count refresh; it must not mirror the small local review-session lookahead buffer.
* `/review` keeps the document static-first, then makes the review card actionable before secondary panels finish. The client first requests one due item through `/api/review-queue?limit=1`, renders the question and answer textarea, and only then maintains a small background review-session lookahead plus previous-answer/profile data. `PersistentReviewToolbarActions` should not issue its own `/api/user` fetch on `/review`; it receives the Review toolbar snapshot instead. Review data should not block the document render.
* Review queue state and pending evaluations are kept in memory for the current server process.
* API routes run on the Node.js runtime and are forced dynamic according to the README notes.
* Review scheduling distinguishes immediate failures from partial recall: `scheduleNextReview` keeps scores `<= 5` due now, schedules scores `6-8` for the next day, treats scores `9-10` as successful recalls, and shortens first/relearning success intervals before growing mature intervals from the last successful review. Queue retry insertion should follow the persisted `nextDue`; only due-now results should be reinserted for immediate retry.
* Review queue reads and submit validation must agree on concept-tag eligibility: a question is reviewable only when it has at least one active concept tag. Keep `getDueQuestions`, queue counts, scheduled-next lookups, queued-question pages, and embedding-proximity queue search aligned with `submitAnswer`'s active-tag check, otherwise stale or muted-tag questions can render but fail with "Question is not in review."
* Answer grading uses `OPENROUTER_API_KEY` or `LLM_API_KEY`; without either key, submitted answers are recorded with score `0` and a configuration message. Review answer submissions must be non-empty after trimming; the Review UI disables empty submits and `/api/submit-answer` rejects blank answers before auth/rate-limit/evaluation work.
* Evaluator `correctAnswer` text is expected to preserve markdown for formulas. The shared `formatFormulaMarkdown` helper wraps obvious bare formula spans in inline markdown code before storage/display so existing plain-text formula answers still render with formula styling. The custom inline math renderer must keep numeric-only math spans such as `$1001$` renderable while still treating ordinary dollar amounts such as `$320,000` and `$.99` as currency, not math.
* The custom inline math renderer intentionally supports a small common subset of LaTeX commands rather than full TeX. It maps learner-facing operators such as `\div`, `\times`, `\leq`, and `\geq`, and consumes TeX spacing commands such as `\,`, `\:`, `\;`, `\!`, `\quad`, and `\qquad` so generated course lessons do not show raw command names or backslashes.
* Learn course creation streams partial TOCs to the client. Once the first valid TOC page arrives, the first chat lesson can start from an in-memory draft course while the full TOC and durable course record continue finalizing in parallel.
* Learn course intake, TOC generation, and tutor turns use the Learn-specific OpenRouter model config (`LLM_LEARN_MODEL`, default `google/gemini-3.1-flash-lite`) instead of the generic `LLM_MODEL`, so global chat-model overrides do not leak into the learner-facing course path.
* Learn chat milestone advancement is intentionally conservative: the progress tool can propose advancing, but the route only advances after a recorded high-scoring answer evaluation demonstrates mastery.
* Learn chat answer submissions use one combined `course_answer_decision` LLM call to both grade/record the answered question and decide milestone progress before the next tutor stream. Answer-evaluation calls use the separate OpenRouter evaluation model (`LLM_EVALUATION_MODEL`, default `google/gemini-3.1-flash-lite`) so grading can be changed without changing the tutor lesson model. Keep this evaluator prompt compact: widget answers should send the parsed widget/question/answer plus only a short lesson-context excerpt, not duplicated full conversation JSON. The route still enforces `requireCourseMilestoneMastery()` locally, so milestone advancement requires a recorded high-scoring answer. The course chat SSE `done` payload includes `latencyMetrics` with `answer_decision_ms`, `time_to_first_delta_ms`, and `chat_stream_ms`. Course message metrics also persist OpenRouter prompt-cache usage when available: cached prompt tokens, uncached prompt tokens, cache-write tokens, and cache-hit percentage.
* Learn LLM prompts should keep immutable instructions as the request prefix and put dynamic topic, course, milestone, progress, and conversation fields later. For example, course TOC generation keeps the reusable TOC instructions before the dynamic `Topic:` line so provider prompt caching can reuse the largest stable prefix. OpenRouter/Gemini prompt-cache hits require explicit `cache_control` breakpoints in message content; the Learn tutor turn uses one cacheable immutable tutor-instruction block, keeps course/milestone/progress/history after the breakpoint, and uses a stable per-user Learn chat `session_id` with a prompt-shape version suffix.
* Learn extracted review questions preserve inline code/math markdown by transferring matching formatting spans from the original tutor question into the server-side extracted question record.
* Learn chat assistant turns should create learner question widgets through the structured `render_question_widget` tool call. `course_chat_messages.tool_calls` stores normalized widget calls so `LearnPageClient` can render free-text or multiple-choice widgets after reloads without hiding widget JSON in assistant prose. While the tutor response is streaming, `/api/courses/chat` emits `question_widget_pending` as soon as a widget tool-call delta starts so the client reserves a placeholder card, then emits `question_widget` with normalized tool calls once the payload is parseable before the final `done` history sync. Legacy `waxon:question-widget` comments remain supported for old rows and repair fallback. Widget submissions still post back through `/api/courses/chat`, where the existing course question-attempt evaluator records the generated question and answer into the durable question bank. Because the learner-facing question may exist only in the widget, answered widgets must remain visible as read-only history with the learner's answer after evaluation. Match an answered widget only within the message window before the next tutor turn; fallback widget IDs can repeat across turns.

# Data Model Cues

The README identifies these important tables and relationships:

* `questions` stores per-card state directly under `user_id`.
* `question_attempts` stores each resolved user attempt with raw answer, concise LLM answer summary, score, justification, and timestamps.
* Waxon maps Clerk accounts through `auth_accounts`.
* The deployed database was migrated from older deck-scoped question data to this user-scoped model in `drizzle/0025_user_scoped_question_data.sql`. That migration backfills `user_id` onto `questions`, `question_attempts`, and `question_embeddings`, adds the user-scoped indexes expected by `app/db/schema.ts`, and leaves legacy `deck_id` columns nullable for data preservation and compatibility with current inserts.

# Relevant Paths

* `app/review/` and `app/api/review-queue/` contain review experience surfaces.
* `/review`, `/learn`, `/library`, `/stats`, `/tags`, and `/queue` serve static-first route shells; signed-in data for those surfaces should load through their client hydrators and API routes rather than blocking the page document render.
* Authenticated app pages live under the route group `app/(app)/`, which preserves their public URL paths while keeping the root public layout free of the authenticated provider shell. Clerk sign-in and sign-up live under `app/(auth)/` so they keep Clerk context and `app/(auth)/auth-globals.css` without loading the authenticated app toolbar shell or full app stylesheet.
* Internal app routes are accessible in `pnpm dev --port auto` through local test auth as `eng.tiago.silva@gmail.com`. Lighthouse audits for protected pages should include `/review`, `/learn`, a representative `/learn/courses/[courseId]`, `/library`, `/tags`, `/stats`, `/admin`, and a representative `/admin/traces/[traceId]`. `/queue` intentionally redirects to `/library`.
* `app/PreviousAnswerRow.tsx` is the shared question-row widget used by Review, Learn evaluation rows, and Library question rows.
* Library tag filters are deep-linkable with `?tag=<slug>` and hydrate into visible `#slug` search tokens. Tag chips in Review, Library, and Tags should link to that Library URL rather than using free-text `q` search.
* `app/api/submit-answer/` and answer evaluation libraries are part of grading.
* `app/lib/scheduler.ts` contains scheduling behavior.
* `app/lib/reviewQueue.ts` contains queue behavior.
* `app/lib/openRouter.ts` contains OpenRouter-compatible LLM access.
* `tests/*.test.mts` contains Node test coverage for scheduler, parsing, generation, and related libraries.

# Citations

* `README.md` overview, commands, notes, and architecture summary.
* `package.json` scripts and dependencies.
