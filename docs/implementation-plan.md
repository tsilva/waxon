# Waxon v2 implementation plan

## Goal

Build the shortest reliable path from “I learned something” to “I can still
recall it months later.”

Waxon v2 succeeds when a learner can:

1. save a question, note, URL, or document without organizing it first;
2. receive a small set of grounded, high-quality recall questions;
3. complete a fast, bounded daily Review session;
4. understand mistakes and correct bad grading;
5. see what is covered, missing, duplicated, weak, or unsupported; and
6. grow one maintainable question bank without creating an ever-growing daily
   backlog.

No finite product can guarantee permanent retention for an infinitely growing
bank with finite study time. Waxon can make a useful conditional promise:

> If the learner completes the proposed Review plan and that plan fits their
> available time, Waxon will keep modeled recall near their selected retention
> target. When it cannot, Waxon will say what is at risk and why.

This is a clean v2 rebuild. There is no legacy migration, backfill, compatibility
layer, or preservation requirement for current data. Old data is purged only
after the live v2 smoke test passes.

## Product decisions

- Each learner has one question bank.
- Sources, concepts, and saved views organize the bank. They do not own cards
  or separate schedules.
- In the interface, concepts behave like simple multi-select tags. Canonical
  names and aliases prevent tag sprawl without exposing ontology maintenance in
  the normal capture flow.
- Library is for capture, search, organization, and maintenance.
- Review is for due-item recall practice only.
- Questions enter the bank as Draft or New, never as an unbounded immediately
  due batch.
- Every active question is atomic, self-contained, answerable, and grounded in
  stored evidence or explicit learner attestation.
- Learner answers, grades, and corrections are permanent evidence. Search
  indexes, coverage summaries, and current schedules are rebuildable.
- AI proposes questions, feedback, duplicate judgments, and repairs.
  Deterministic application code owns authorization, state changes, scheduling,
  limits, and final activation.
- Uncertainty produces a Draft or a learner choice, never silent activation,
  deletion, or mastery transfer.

## Experience rules

These rules apply to every milestone:

- **Save first.** Capture returns as soon as the learner’s input is durable.
  Parsing, embeddings, and model work continue in the background.
- **One obvious next action.** Empty Library starts with Add knowledge. Empty
  Review explains whether the learner is done, waiting for New admission, or
  blocked by capacity.
- **Small decisions.** Generated questions land in a compact Inbox. The learner
  reviews exceptions and uncertain cases rather than administering internal
  tables.
- **Stable Review.** A session shows an estimated count and duration, does not
  reshuffle after it starts, and resumes across tabs or reloads.
- **Fast feedback, honest fallback.** The next prompt appears immediately.
  Model feedback may arrive asynchronously; self-grade is always available
  when evaluation is slow or unavailable.
- **No mystery state.** Every Draft, source, or question has a plain-language
  status and a repair action.
- **Mobile is first-class.** The critical capture and Review flows work at
  390 px, with keyboard navigation, visible focus, reduced motion, and 200%
  zoom.

## Practical architecture

Keep the current product stack unless implementation evidence disproves it:

- Next.js App Router and React;
- Clerk authentication;
- Neon Postgres and Drizzle;
- private object storage for uploaded source files;
- the existing model-provider abstraction;
- the repository’s existing design system; and
- pnpm with the repository’s supply-chain protections.

Use one application and one Postgres-backed background-job queue. Do not build
a custom ledger, distributed scheduler, event platform, partitioning scheme, or
control plane.

The application has three layers:

```text
route or UI
  -> application use case
     -> domain rule
        -> learner-scoped database transaction
```

Routes obtain the learner identity from Clerk. Jobs store the owning learner
when they are created and re-enter the same learner-scoped use cases. Every
learner-owned row carries `user_id`; database foreign keys and repository tests
prevent cross-learner relationships.

Postgres transactions, unique constraints, and idempotency keys handle normal
concurrency:

- one active Review session per learner;
- one accepted answer per presented item;
- one active canonical question per exact recall target;
- one source/finalization result per capture request; and
- one committed result per background job.

External model calls and file parsing happen outside database transactions.
The commit step rechecks that the referenced question or source version is
still current.

### Core data model

Keep the model small and explainable:

| Area | Records | Purpose |
| --- | --- | --- |
| Identity | users, learner settings | authentication, time budget, retention target |
| Sources | sources, source versions, evidence spans | durable input and exact provenance |
| Coverage | coverage targets, target/evidence links | auditable units of knowledge |
| Questions | questions, question versions, question/evidence links, relations | recall prompts, answers, edits, merges, splits |
| Organization | concepts, aliases, question/concept links, saved views | non-exclusive navigation |
| Learning | answer submissions, evaluations, grade events, memory states | permanent evidence and current FSRS state |
| Review | sessions, session items, retry obligations | stable bounded practice |
| Work | jobs and idempotency receipts | retryable background processing |

Canonical records are never overwritten when history matters. A question edit
creates a version; a grade correction appends a grade event. Current search
documents, embeddings, coverage summaries, and memory state may be rebuilt from
canonical records.

A direct question is grounded by a stored learner-attested source version
containing the confirmed prompt and answer. It therefore uses the same
provenance model as imported material without pretending that a model suggestion
is evidence.

Question lifecycle is:

```text
Draft -> New -> Learning -> Review
            \-> Paused
            \-> Archived
            \-> Suspended
            \-> Trash
            \-> Superseded
```

- Draft is incomplete or awaiting a quality, evidence, or duplicate decision.
- New is valid but not yet admitted into Review.
- Learning and Review are schedulable active states.
- Paused and Archived create no Review work.
- Suspended is visible and explains a quality, evidence, or safety problem.
- Trash is reversible logical removal.
- Superseded preserves the history of a merge or split and is not schedulable.

### Background jobs

Use one jobs table with:

- job type, owner, input version, and idempotency key;
- pending/running/succeeded/failed/cancelled state;
- bounded retries and a lease expiry;
- visible progress and a safe error message; and
- a result reference.

Workers claim jobs with `FOR UPDATE SKIP LOCKED`. Duplicate delivery is safe.
Answer evaluation receives the highest priority, then source capture, then
generation and maintenance. Start with conservative per-user and global limits;
tune them from measured traffic rather than designing for hypothetical
infinite scale.

Uploads use a short-lived one-use intent bound to the learner, object key,
declared type, and maximum bytes. Issuing the intent reserves the declared
storage. Successful finalization converts the reservation to actual stored
bytes; cancellation, rejection, or expiry deletes any partial object and
releases the reservation exactly once. Finalization verifies ownership, size,
type, checksum, and generation before a source becomes usable.

## Core behavior

### Capture and activation

Add knowledge accepts:

- a direct question with an answer or scoring rubric;
- pasted text or notes;
- a URL;
- PDF or text files; and
- a topic request that searches the learner’s existing evidence.

The source or direct Draft is saved before enrichment. The UI immediately shows
its state and lets the learner retry or cancel failed processing.

A single activation gate is used for direct, generated, edited, and repair
questions. A question can become New only when it has:

- one precise recall target;
- a concise, self-contained prompt;
- a reference answer or rubric;
- an answer mode;
- evidence supporting the prompt and every required answer point, or explicit
  learner attestation for direct knowledge;
- no unresolved ambiguity or unsupported claim; and
- a completed duplicate check.

The shared
[question-quality reference](../reference/question-quality.md) is the
authoritative wording contract. A broad prompt is split into atomic Drafts.
An omitted direct answer remains Draft until the learner confirms or edits a
suggested answer.

### Coverage

Source processing divides material into atomic coverage targets: claims,
distinctions, formulas, procedures, derivation steps, prerequisites, and
failure modes. Each material source section must be:

- Covered by an active question;
- Weak because its question is broad, ambiguous, or incomplete;
- Missing;
- Intentionally ignored with a learner-visible reason; or
- Unresolved because extraction or evidence is incomplete.

Waxon never labels a source fully covered while material remains Unresolved.
Generation creates Drafts only for Missing or Weak targets and cites exact
evidence. Existing questions can cover targets from newly added sources.

Generation is bounded per request. When a document is too large for one pass,
Waxon preserves completed work, marks the rest Unresolved, and offers Continue
analysis. It never silently truncates the source or claims complete coverage.

URL ingestion blocks private-network and metadata addresses, rechecks every
redirect, limits bytes and time, and never forwards learner credentials.
Document parsing has explicit file, page, and extracted-text limits and never
executes embedded content.

### Duplicate handling and maintenance

Before activation, Waxon checks:

1. normalized exact identity;
2. lexical and embedding neighbors from the same learner; and
3. a structured comparison of recall target, direction, scope, cueing, answer
   mode, and rubric.

The result is Distinct, Duplicate, or Uncertain. Only Distinct can activate
automatically. Duplicate offers Use existing or Merge. Uncertain stays Draft
with a comparison view.

Final activation is serialized per learner with one short Postgres transaction
that re-runs the candidate lookup before commit. Model comparison happens before
that transaction. This prevents two concurrently accepted semantic duplicates
from both becoming active without introducing a separate coordination service.

A merge is allowed only for the same atomic recall target. It:

- chooses one canonical prompt and answer;
- unions concepts, sources, and evidence;
- keeps all original attempts and grades;
- replays compatible grades in chronological order to rebuild memory;
- redirects pending evaluation to the canonical question exactly once; and
- marks redundant identities Superseded.

Different retrieval directions, scopes, or reasoning steps are not duplicates
and do not share mastery.

Wording-only edits may keep memory after the activation gate confirms equivalent
meaning and difficulty. A materially changed target creates new memory.
Splitting a broad question creates conservative child states; it does not copy
full mastery to every child.

Library surfaces a maximum of 20 high-impact maintenance suggestions at a time:
duplicates, broad questions, weak answers, unsupported questions, conflicting
answers, concept alias collisions, and uncovered source targets. Each has a
preview, one primary action, and undo when safe.

### Review, grading, and retry

Review accepts free-text answers only. Initial answer modes are:

- normalized exact recall for vocabulary, symbols, formulas, and short facts;
- semantic recall for explanations and derivations; and
- rubric recall for procedures and multi-point comparisons.

Each presentation stores the exact question version shown and accepts one
answer. Deterministic exact grading is used when possible. Model grading returns:

- Again, Hard, Good, or Easy;
- covered and missing rubric points;
- concise corrective feedback;
- the expected answer;
- a demonstrated gap or misconception; and
- confidence.

Deterministic grading returns the same corrective contract, including the
expected accepted forms and the precise mismatch.

Low-confidence or failed evaluation asks the learner to self-grade. The learner
can correct any grade. Corrections preserve the original evaluation and rebuild
the question’s current memory state from its grade history.

Once an answer is accepted, that question cannot be issued again while its
grade is pending. Model completion, learner self-grade, or explicit
invalidation clears this barrier exactly once, including across session
completion, reload, and another tab.

An Again on a first presentation creates exactly one retry later in the same
resumable session. It must follow a different question; if no different eligible
question exists, it waits at least ten minutes. Failing the retry schedules an
ordinary future review and does not create another same-session retry.

If the learner pauses, archives, or trashes the question before the retry, the
retry is visibly waived. Losing required source support or a safety invalidation
also waives an unexposed retry with the reason recorded. A compatible edit or
merge transfers it. An ordinary quality problem defers it. No maintenance
operation silently loses or duplicates it. A materially changed edit or split
keeps the retry bound to the retained old version unless the learner explicitly
uses one of the allowed waiver actions.

### Adaptive scheduling and capacity

Use a pinned FSRS implementation behind a small pure adapter. Store:

- difficulty;
- stability;
- last reviewed time;
- next due time; and
- the scheduler-policy version.

Only Again/Hard/Good/Easy changes scheduling. Model confidence and prose do not
directly manipulate intervals.

The learner chooses a daily time budget and desired retention. The daily plan:

1. selects active questions whose modeled recall is at risk within the next
   24 hours;
2. prioritizes lower retrievability, importance, overdue time, uncertainty, and
   demonstrated gaps;
3. fits the highest-value due work into the time budget;
4. reserves room for the one possible retry per first presentation;
5. introduces New questions only with remaining sustainable capacity; and
6. disperses closely related questions when possible.

It does not pad a session once every remaining question is modeled above the
retention target for the planning horizon.

M4 keeps this priority policy in one small versioned module with fixed weights
and deterministic tie-breaks. Reference fixtures freeze its behavior; dogfood
evidence may tune a later version without rewriting scheduling history.

The plan is stable once issued and has a hard presentation cap. Saved views may
start supplemental practice from currently due questions, but they never hide
active questions from the bank-wide retention forecast or pull future work
forward.

If all at-risk work does not fit, Waxon shows:

- the estimated sustainable retention;
- important material at risk;
- how many New questions are waiting and for how long;
- the effect of adding time; and
- explicit pause or priority choices.

Waxon never silently lowers the target, pauses material, or turns all historical
debt into today’s Review list.

### Targeted repair

An answer may produce at most one repair Draft, and only for a missing point,
misconception, or step demonstrated by that answer. It links to the attempt,
target, and evidence, then passes the normal quality and duplicate gate.

Repair Drafts remain in Inbox until accepted and are capped per learner per day.
Waxon does not generate adjacent trivia merely because the model can.

## Milestones

Milestones are sequential. Each ends in a usable, testable product increment.
Do not begin the next milestone while a required exit journey is broken.

### M0 — Clean v2 foundation

**Deliver**

- Replace the legacy schema with one fresh v2 baseline migration.
- Add learner-scoped repositories, database constraints, and mutation
  idempotency.
- Add the background jobs table and worker.
- Add conservative per-learner and global request, queue, model-call, token, and
  storage limits with plain-language retry/reset responses.
- Create empty Library, Review, Inbox, Sources, and Trash states using the
  existing visual system.
- Put all v2 routes behind one server-side capability flag.
- Add one documented database reset/bootstrap command.

**Exit gate**

- A clean database boots the app with one command.
- Two authenticated users cannot read, link, or mutate each other’s data.
- Duplicate requests and duplicate job delivery produce one result.
- Stored learner and model text renders inert across every shared text surface.
- Empty states and Add knowledge work at desktop and 390 px.
- Test, typecheck, lint, and production build pass.

### M1 — Excellent manual learning loop

This is the first product worth using every day.

**Deliver**

- Direct question capture and answer confirmation.
- Question versions and the complete lifecycle.
- The shared quality/evidence/duplicate activation gate.
- Library create, edit, search, pause, archive, Trash, and restore.
- Exact, semantic, and rubric evaluation.
- Append-only answers, evaluations, grade corrections, and FSRS scheduling.
- Stable bounded Review sessions and exactly one delayed retry. M1 selects
  earliest-due work with importance as a tie-break and uses a conservative
  fixed New-item cap; M4 replaces this selector with the full capacity planner.
- Immediate next-prompt navigation with self-grade fallback.

**Exit gate**

- A learner can add and review an AI explanation, formula, Japanese vocabulary
  item, and multi-point procedure.
- Broad, unsupported, answer-less, and duplicate questions remain Draft with a
  useful repair action.
- Adding 100 accepted questions does not create 100 immediately due reviews.
- Again creates one delayed retry across reload, another tab, and day rollover.
- Correcting a grade changes the schedule without erasing the original result.
- A lost or delayed evaluation cannot cause the same question to be reissued;
  self-grade clears the pending barrier without allowing a late model result to
  overwrite it.
- Two tabs cannot create two sessions or answer the same presentation twice.
- Edit, pause, archive, Trash, and restore preserve the required history.
- Review contains no bank-management controls.
- Critical browser journeys and automated checks pass.

### M2 — Frictionless source-to-draft pipeline

**Deliver**

- Paste, URL, PDF, and text-file capture.
- Durable source-first saving with visible processing progress.
- One-time private upload intents with exact reservation cleanup.
- Safe URL fetching and bounded document parsing.
- Evidence spans and the source viewer.
- Coverage-target extraction with unresolved and ignored scope.
- Evidence-grounded Draft generation and batch Inbox actions.
- Grounded topic requests that search existing evidence or ask for a source.
- Retry, cancel, and Continue analysis without duplicate work.

**Exit gate**

- A saved source remains visible and retryable through parser, embedding, or
  model failure.
- A Vision Transformer paper becomes evidence-linked targets and Drafts without
  manual tagging.
- Japanese source material uses the same pipeline and data model.
- Every generated answer claim resolves to stored evidence before activation.
- A source cannot appear fully covered while material remains Unresolved.
- On a fixed human-reviewed AI/ML, Japanese, and general-domain corpus,
  coverage-target extraction reaches at least 95% precision and 90% material
  target recall in each domain; missed material stays Unresolved.
- Re-ingesting or retrying identical input is idempotent.
- Upload ownership, expiry, size, checksum, and cleanup tests pass.
- Hostile URL and oversized-document fixtures fail safely.
- Source-capture browser journeys and automated checks pass.

### M3 — Coverage and effortless maintenance

**Deliver**

- Source and concept coverage views.
- Merge and split previews.
- Canonical concepts with aliases and optional broader/narrower links.
- Saved views.
- Prioritized Health suggestions with safe undo.
- Reversible source disable and separate irreversible source erasure.
- Rebuild commands for derived search, embeddings, coverage, and memory state.

**Exit gate**

- Merging true duplicates retains sources, concepts, attempts, pending grading,
  and compatible memory while leaving one schedulable question.
- Similar but different recall targets cannot merge mastery.
- Splitting a broad question creates atomic children with conservative memory.
- Disabling a source visibly suspends only questions that lose required support.
- Source erasure previews retained effects, removes live source payloads, and
  every object copy, discloses managed-backup expiry, and does not erase
  unrelated learning history.
- A learner can find Vision Transformers, Japanese, or weak material without
  decks.
- Rebuilding derived data produces the same bank and learning state.
- Maintenance browser journeys and automated checks pass.

### M4 — Adaptive planner and repair flywheel

**Deliver**

- Learner-selected daily time and desired retention.
- Risk-ranked bounded daily planning.
- Capacity-aware New admission.
- Infeasibility explanation and what-if time choices.
- Targeted repair Drafts from demonstrated gaps.
- Scheduler-policy versioning and shadow evaluation.
- Product metrics for observed recall, learner minutes, at-risk material,
  grading overrides, duplicate removal, coverage, and repair usefulness.

**Exit gate**

- Deterministic fixtures prove that all due work is selected when it all fits;
  otherwise the constrained plan chooses the highest-priority feasible set.
- Increasing available time cannot reduce protected due material.
- Review never exceeds its stated presentation and time envelope by design;
  actual time is clearly labeled as an estimate.
- New questions advance when capacity exists and remain visibly waiting during
  true overload rather than becoming hidden debt.
- Saved views cannot narrow the bank-wide retention promise.
- Insufficient capacity produces an honest, actionable explanation.
- Repair Drafts are traceable to demonstrated gaps, bounded, deduplicated, and
  inactive until accepted.
- On held-out dogfood history with enough matured reviews, the selected
  scheduler policy is no worse than the pinned prior policy for recall per
  learner-minute, and observed recall stays within five percentage points of
  the modeled target in every prediction band with at least 200 matured
  reviews. Sparse bands are labeled uncalibrated. Until that evidence exists,
  conservative defaults remain active.
- Planner, constrained-capacity browser journeys, and automated checks pass.

### M5 — Polish, prove, cut over, and purge

**Deliver**

- Responsive and accessible polish using the repository design system.
- Observability for capture, grading, job age, scheduling, and failures.
- Rate, storage, queue, and model-cost limits based on measured load.
- Database backup/restore and private-object recovery rehearsal.
- Production-equivalent load and failure testing.
- A fresh production v2 database and storage namespace.

**Launch targets**

- 25,000 questions for a heavy learner without full-bank request scans;
- capture acknowledgement below 500 ms server p95;
- next Review prompt below 300 ms server p95;
- Library first page below 500 ms server p95;
- daily plan open below one second server p95;
- evaluation feedback below 10 seconds p95 when the provider is healthy; and
- saved inputs, accepted answers, and self-grade remain available during model
  failure.

These are launch targets, not an instruction to build sharding. If production
later approaches them, optimize measured queries and workers first; change the
storage or queue architecture only when evidence requires it.

**Cutover**

1. Freeze a v2 release candidate and pass every milestone gate.
2. Create the empty production v2 database and object namespace.
3. Route only disposable smoke accounts to v2.
4. Run authentication, empty-bank, capture, Review, correction, source,
   duplicate, deletion, and recovery journeys.
5. If green, briefly block legacy writes and route real accounts to the empty
   v2 product.
6. Enable v2 writes. From this point, rollback means an earlier v2-compatible
   deployment against the same v2 data, never a return to legacy storage.
7. Repeat the disposable live smoke and watch errors, latency, and job age.
8. Purge the legacy database and storage only after the live gate remains green.
9. Remove legacy routes, migrations, flags, and code.

**Exit gate**

- All requirement proofs below pass on the same frozen build.
- Backup/restore and object recovery meet the documented recovery targets.
- Provider failure preserves learner input and offers honest fallbacks.
- No severity-1 usability, accessibility, authorization, or data-loss defect
  remains.
- Test, typecheck, lint, production build, and native-browser journeys pass.

## Verification

### Automated

- Unit tests cover lifecycle rules, question-quality checks, exact
  normalization, scheduler behavior, retry behavior, merge compatibility,
  planner priority, and coverage status.
- Integration tests cover learner isolation, idempotency, upload ownership and
  cleanup, answer/correction races, one active session, job retries, merge with
  pending evaluation, source disable, and clean-database bootstrap.
- AI evaluation fixtures cover AI/ML, Japanese, and general-domain questions;
  broad and ambiguous prompts; supported and unsupported claims; true
  duplicates and hard negatives; grading errors; and valid/invalid repair
  Drafts. Tests assert decisions and evidence, not exact model prose.
  Each domain contains at least 200 true-duplicate pairs, 200 hard-negative
  pairs, 400 human-graded answers balanced across the four grades, and 20
  representative sources with at least 200 labeled coverage targets.
  Auto-Duplicate decisions require at least 98% precision and 95% recall per
  domain, with Uncertain kept inactive. Grading requires at least 90% exact
  four-grade agreement, at least 98% agreement within one grade, and below 2%
  false-pass rate on answers humans label Again; otherwise the version remains
  in shadow or asks the learner to self-grade.
- Native-browser journeys cover authentication, empty bank, direct capture,
  first Review, delayed retry, correction, source-to-Inbox, merge, split,
  coverage, Trash restore, capacity explanation, mobile, keyboard, focus,
  reduced motion, and zoom.

### Product acceptance

Run a dogfood cohort before broad release. The build may advance only when:

- learners can capture common material without setup or data loss;
- the median daily session finishes within its displayed time estimate;
- active questions have answers and evidence;
- duplicate and grading decisions meet the pinned human-reviewed quality set;
- grade overrides, generation rejection, and repair acceptance are measured;
- due counts agree across Library, Review, and Stats; and
- interviews show that the statuses and capacity explanation are understood
  without internal terminology.

## Requirement traceability

S1–S20 refer to the requirements in `SPECS.md`, in order.

| Requirement | Milestone and proof |
| --- | --- |
| S1 domain-neutral | M1/M2 AI/ML, Japanese, and general-domain fixtures |
| S2 authentication/isolation | M0 route, repository, job, and database tests |
| S3 one bank | M0/M3 schema plus concepts and saved-view journeys |
| S4 direct/source capture | M1/M2 capture journeys |
| S5 active-question quality | M1 shared activation gate and quality corpus |
| S6 nonblocking save | M1/M2 failure and retry journeys |
| S7 auditable coverage | M2/M3 source residual and coverage tests |
| S8 dedupe/history merge | M1/M3 duplicate, merge, pending-grade, and replay tests |
| S9 safe lifecycle changes | M1/M3 edit, split, merge, archive, and restore tests |
| S10 reversible removal/separate erasure | M1/M3/M5 Trash and erasure tests |
| S11 Library-only management | M1 navigation and Review audit |
| S12 eligibility | M1/M3 lifecycle and suspension tests |
| S13 no intake debt | M1/M4 New-admission tests |
| S14 free-text due Review | M1/M4 answer-mode and due-only tests |
| S15 feedback/correction | M1 evaluation, correction, and replay tests |
| S16 adaptive intervals | M1/M4 FSRS property and shadow-policy tests |
| S17 one delayed retry | M1/M3 retry, lifecycle, merge, and no-recursion tests |
| S18 bounded risk plan | M4 planner priority and capacity fixtures |
| S19 infeasibility disclosure | M4 service and browser tests |
| S20 bounded gap repair | M4 evidence, duplicate, and cap tests |

Waxon v2 is complete only when all S1–S20 proofs pass on the same frozen build.

## Critical path

```text
M0 clean foundation
  -> M1 excellent manual loop
    -> M2 source-to-draft
      -> M3 coverage and maintenance
        -> M4 adaptive planning and repair
          -> M5 hardening, cutover, purge
```

The first priority is one manually entered question that is pleasant to save,
reliable to review, correctly scheduled, and safe to maintain. Every later
milestone strengthens that same loop.
