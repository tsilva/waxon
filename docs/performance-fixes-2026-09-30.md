# Waxon performance fixes — 30 September 2026

The audit's application bottlenecks have been addressed on the current branch. These are local development results against the same existing learner; they do not establish production latency percentiles or guarantee zero delay on every device.

## Measured result

Five warm sequential HTTP samples per endpoint, excluding one warm-up request:

| Endpoint | Audit median | Updated median | Change |
| --- | ---: | ---: | --- |
| Library | 696 ms | 312 ms | 55% less time |
| Review queue | 1,318 ms | 287 ms | 78% less time |
| Review summary | 1,170 ms | 142 ms | 88% less time |
| Tags | 505 ms | 139 ms | 72% less time |
| Settings | 633 ms | 141 ms | 78% less time |
| Admin traces | 816 ms | 294 ms | 64% less time |

Admin list responses fell from 2,691,173 bytes to 29,970 bytes (99% smaller), with 50 compact interactions per page. Review grew slightly, from 28,084 to 30,407 bytes, because it now includes up to eight upcoming candidates; it no longer needs a blocking request for each Next click.

Five native in-app browser Next interactions changed the Question with the composer enabled, taking 323–407 ms including browser automation calls. The previous observed disabled intervals were 1,408–1,440 ms with one 3,988 ms outlier. These are automation observations, not browser INP or frame-time measurements. Typing, opening feedback details, Library navigation and disclosures, Admin navigation, and deferred trace payload loading were also exercised without saving learner answers.

## Implemented changes

- Routine authentication verifies every production session but caches the display profile for 60 seconds in a bounded, deduplicated cache. Existing profiles and settings no longer receive provisioning writes on every read. Avatar edits invalidate the profile; Admin APIs require a fresh profile for authorization.
- Review fetches day, eligibility, complete membership count, pending status, next date, and a nine-Question window in one query. Latest grade evidence is selected once per Question. Summary uses a separate count/min query without prompts or queue ordering. Flagging validates the specific Question instead of loading the entire queue.
- Next advances locally within the server window and refills in the background. It preserves complete queue membership, stops at the edge of a partial window, and refuses local advancement across a Local Day boundary. Focus, visibility, periodic refresh, and learning mutations refresh/invalidate cached state; submissions still validate eligibility transactionally.
- A new answer commits its immutable evidence, evaluation, durable job, and idempotency receipt in one SQL statement inside the existing locked transaction. The response returns the known pending evaluation without rereading it. Workflow dispatch remains awaited. The UI advances after acknowledgement and retains the same idempotency key when retrying an unsuccessful acknowledgement.
- Pending feedback uses a batch of at most 20 learner-scoped evaluation IDs. Completed evaluations trigger a membership refresh; polling no longer repeatedly reloads the complete Review view. Hidden tabs pause polling.
- Learning pages preload their own data alongside client code. Toolbar counts share Review data. Admin data loads on navigation; summaries omit request/response bodies in SQL, paginate, and fetch individual payloads only when details open. Totals are explicitly for loaded trace groups.
- Markdown and unchanged feedback/Library rows are memoized. Collapsed details mount on expansion. Textareas resize once per value change. Offscreen list rows use content visibility. Library caches have a 20-entry bound and 60-second freshness; generation checks stop older responses overwriting newer navigation or mutation results.
- Library full-text search now uses the expression already covered by the weighted GIN index. Evaluation reference Tags are excluded from ordinary reads; diagnostic comparison can be enabled with `WAXON_TAG_REFERENCE_DIAGNOSTICS=1`. Related-Tag diagnostics use a single window pass, preserving embedding compatibility, lexical priority, and complete result pagination.
- Evaluator requests prefer latency-ranked providers while retaining required structured parameters and the current model. Each transport attempt has a 15-second timeout; one evaluation has a 30-second total deadline. Permanent configuration/authentication failures, exhausted transport or schema retries, and total-deadline failures do not multiply through automatic job retries. Each evaluation is limited to three attempts and 30 seconds across the retry layers. Failures remain visible and manually recoverable, without inventing a grade. Provider controls follow [OpenRouter's routing documentation](https://openrouter.ai/docs/guides/routing/provider-selection).
- Timing headers on Library, Review, summary, and answer endpoints expose authentication, service/save, workflow dispatch, and serialization durations without private data. Equal-time corrections receive monotonically increasing timestamps under the queue lock, fixing a nondeterministic ordering failure exposed by the fast test database.

## Inference and scale checks

The same eight synthetic cases from the existing evaluator smoke corpus were run once per model, without database access:

| Model | Expected classifications | Median request time | Slowest |
| --- | ---: | ---: | ---: |
| google/gemini-3.8-flash | 8/8 | 2,528 ms | 3,993 ms |
| google/gemini-3.1-flash-lite | 6/8 | 949 ms | 1,036 ms |

Flash Lite incorrectly rejected a valid finite-horizon formula and classified an off-by-one answer as Incorrect instead of Partial. The default remains unchanged. Eight cases are a smoke check, not a representative accuracy or tail-latency study.

A separate disposable PostgreSQL/pgvector database held 5,000 synthetic Questions and 1,000 Tags, using compatible 512-dimensional vectors. After updating planner statistics and removing concurrent build load, a 50-Question related-Tag page had medians of 120 ms before and 126 ms after; no Tag CPU speedup is claimed. A two-Tag ranked Question page took 45 ms after, returned 50 Questions, and retained a continuation cursor. Early runs with stale planner statistics and concurrent builds took seconds, demonstrating why those measurements cannot establish an application regression. This synthetic fixture does not model billion-Question production scale.

## Verification and remaining limits

The production build, TypeScript check, lint, 79 focused tests, and a final 25-test cache/window/retry run passed. The final full suite passed 167 of 171 tests, with four failures reproduced on the unchanged branch: two stale clean-baseline migration assertions, one pre-existing date/layout source assertion, and a semantic-Tag test expecting truncated results. The focused run includes Review ordering, MCP priority, timezone serialization, idempotency, immutable evidence/corrections, learner isolation, stable Library/search pagination, workflow evaluation, retry deadlines, stale-response protection, and complete-window behavior.

No dependencies were added, no branch was changed, and nothing was pushed or deployed. Existing development servers were left running. The test database and synthetic fixtures were isolated from learner data.

The local server is http://localhost:55741. Repeat measurements with:

```sh
pnpm performance:benchmark --base-url=http://localhost:55741 --iterations=20
```

For an authenticated deployment, provide its session cookie through `WAXON_BENCHMARK_COOKIE`; the benchmark never prints it. Admin measurements require Admin access. Requests are read-only, sequential, and include one excluded warm-up.

Production Clerk latency, function/database region alignment, cold starts, browser frame times on target phones, and deployed workflow dispatch latency still require deployment/device measurements. The local database round trip remains about 123 ms because this server is in Portugal and its configured database is in AWS us-east-1. The evaluator still takes seconds, but it runs independently of the next composer. Changing production regions or switching models without those measurements would not constitute a verified fix.
