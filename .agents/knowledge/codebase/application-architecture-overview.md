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
* Static-first authenticated pages should use `app/(app)/AuthenticatedClientHydrator.tsx` for the repeated dynamic client import, `AuthenticatedProviders`, and static-shell inert/hide behavior. Route-specific hydrators should stay thin wrappers that provide the client loader, initial props, and static selector.
* Static shell headers reserve the right-side toolbar slot with `reader-actions-placeholder`; `PersistentReviewToolbarActions` must stay mounted inside `AuthenticatedProviders` so the due count and signed-in user menu/avatar appear after client auth hydration. The persistent actions should be anchored to the document/header slot, not `position: fixed`, so they scroll away with the toolbar instead of floating over review content.
* `PersistentReviewToolbarActions` should not fetch or cache due counts on its own. The visible header due count is the Review session remaining count, published by the hydrated Review app after the session queue loads; the broader `/api/queue-status` due count can differ and should not be shown as a loading fallback.
* `/review` keeps the document static-first, then makes the review card actionable before secondary panels finish. The client first requests one due item through `/api/review-queue?limit=1`, renders the question and answer textarea, and only then backfills the remainder of the review-session queue plus previous-answer/profile data in the background. `PersistentReviewToolbarActions` should not issue its own `/api/user` fetch on `/review`; it receives the Review toolbar snapshot instead. `loadInitialReviewPageData()` exists but is not currently wired into `app/(app)/review/page.tsx`, so review data should not block the document render.
* Review queue state and pending evaluations are kept in memory for the current server process.
* API routes run on the Node.js runtime and are forced dynamic according to the README notes.
* Review scheduling distinguishes immediate failures from partial recall: `scheduleNextReview` keeps scores `<= 5` due now, schedules scores `6-8` for the next day, treats scores `9-10` as successful recalls, and shortens first/relearning success intervals before growing mature intervals from the last successful review. Queue retry insertion should follow the persisted `nextDue`; only due-now results should be reinserted for immediate retry.
* Review queue reads and submit validation must agree on concept-tag eligibility: a question is reviewable only when it has at least one active concept tag. Keep `getDueQuestions`, queue counts, scheduled-next lookups, queued-question pages, and embedding-proximity queue search aligned with `submitAnswer`'s active-tag check, otherwise stale or muted-tag questions can render but fail with "Question is not in review."
* Answer grading uses `OPENROUTER_API_KEY` or `LLM_API_KEY`; without either key, submitted answers are recorded with score `0` and a configuration message. Review answer submissions must be non-empty after trimming; the Review UI disables empty submits and `/api/submit-answer` rejects blank answers before auth/rate-limit/evaluation work.
* Evaluator `correctAnswer` text is expected to preserve markdown for formulas. The shared `formatFormulaMarkdown` helper wraps obvious bare formula spans in inline markdown code before storage/display so existing plain-text formula answers still render with formula styling.
* Learn course creation streams partial TOCs to the client. Once the first valid TOC page arrives, the first chat lesson can start from an in-memory draft course while the full TOC and durable course record continue finalizing in parallel.
* Learn chat milestone advancement is intentionally conservative: the progress tool can propose advancing, but the route only advances after a recorded high-scoring answer evaluation demonstrates mastery.
* Learn extracted review questions preserve inline code/math markdown by transferring matching formatting spans from the original tutor question into the server-side extracted question record.

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
* `app/api/submit-answer/` and answer evaluation libraries are part of grading.
* `app/lib/scheduler.ts` contains scheduling behavior.
* `app/lib/reviewQueue.ts` contains queue behavior.
* `app/lib/openRouter.ts` contains OpenRouter-compatible LLM access.
* `tests/*.test.mts` contains Node test coverage for scheduler, parsing, generation, and related libraries.

# Citations

* `README.md` overview, commands, notes, and architecture summary.
* `package.json` scripts and dependencies.
