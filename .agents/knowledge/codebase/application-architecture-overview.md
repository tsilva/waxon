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
* Review queue state and pending evaluations are kept in memory for the current server process.
* API routes run on the Node.js runtime and are forced dynamic according to the README notes.
* Answer grading uses `OPENROUTER_API_KEY` or `LLM_API_KEY`; without either key, submitted answers are recorded with score `0` and a configuration message.

# Data Model Cues

The README identifies these important tables and relationships:

* `users` own `decks`.
* The default deck is `Deep Learning`.
* `questions` stores per-card state and uses `deck_id`.
* `question_attempts` stores each resolved user attempt with `deck_id`, raw answer, concise LLM answer summary, score, justification, and timestamps.
* Waxon maps Clerk accounts through `auth_accounts`.

# Relevant Paths

* `app/review/` and `app/api/review-queue/` contain review experience surfaces.
* `app/api/submit-answer/` and answer evaluation libraries are part of grading.
* `app/lib/scheduler.ts` contains scheduling behavior.
* `app/lib/reviewQueue.ts` contains queue behavior.
* `app/lib/openRouter.ts` contains OpenRouter-compatible LLM access.
* `tests/*.test.mts` contains Node test coverage for scheduler, parsing, generation, and related libraries.

# Citations

* `README.md` overview, commands, notes, and architecture summary.
* `package.json` scripts and dependencies.
