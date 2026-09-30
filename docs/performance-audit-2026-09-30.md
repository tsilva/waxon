# Waxon performance audit — 30 September 2026

Waxon's largest verified delays are database round trips and the amount of work attached to each interaction. The configured evaluator also takes seconds, but reducing model latency alone would leave Review and Library visibly slow.

## What was exercised

Native Codex Desktop in-app Browser: Library, question search, lifecycle filters, Add question dialog (cancelled), Review navigation, repeated Next question, answer typing (cleared without submission), and Admin. The audit used the existing learner's 367 Questions, 340 due Questions, 66 answer submissions, and 63 Tags. No Questions, answers, corrections, credentials, or lifecycle changes were saved by the audit. Existing read endpoints do update user/settings records internally.

The local Next.js development server runs at http://localhost:55741. It was started with `keyenv run -- pnpm dev --port auto`; other servers were left running. Database services were timed separately through their real application functions, with PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` for read queries. Three fresh evaluator calls used synthetic classification answers and had database persistence disabled. Existing model traces supplied additional historical evidence.

The browser API exposes a read-only DOM scope without the Performance API. Therefore browser interaction timings below include automation overhead; they are not INP, frame-time, or React Profiler measurements. No production deployment, mobile device, throttled connection, or representative large database was benchmarked. Warm API timings and direct database profiling establish delays independent of first-route compilation, but do not establish production latency percentiles.

## Measured baseline

Five consecutive HTTP samples per endpoint after initial exploration:

| Operation | Median | Sample range | Response / notes |
| --- | ---: | ---: | --- |
| Library | 696 ms | 690–1,589 ms | 35,222 bytes; 50 Questions |
| Review queue | 1,318 ms | 1,283–1,496 ms | 28,084 bytes; Question plus 20 previous answers |
| Due summary | 1,170 ms | 1,135–1,343 ms | Only 45 bytes |
| Tags | 505 ms | 497–518 ms | First page |
| Settings | 633 ms | 621–774 ms | Only 28 bytes |
| Admin traces | 816 ms | 790–1,336 ms | 2,691,173 bytes; 200 interactions |

Earlier warm samples agreed: Review 1,280–1,298 ms and summary 1,122–1,128 ms. Next question disabled the answer box for 1,408 and 1,440 ms in two repeat interactions, with one 3,988 ms outlier. Four concurrent queue reads took 1.9–2.9 seconds; a subsequent eight-request run took 1.3–2.2 seconds. These small runs show variability, not a monotonic load curve or an established capacity limit.

Direct application service profiling, excluding route authentication and development-server overhead:

| Service | Warm wall time | SQL calls |
| --- | ---: | ---: |
| Library list | 422 ms | 3 |
| Review open | 883 ms | 8 |
| Summary | 754 ms | 6 |
| Settings | 250 ms | 2 |
| Tags | 132 ms | 1 |
| Library text search | 303 ms | 4, including evaluation reference Tags |

Simple queries repeatedly cost 123–127 ms end to end while PostgreSQL executed them in 0.018–0.058 ms. This is network/driver/pool overhead, not expensive SQL execution. The database hostname identifies AWS us-east-1; the app server for these measurements ran locally in Portugal. Production function locality remains unverified.

## Fix in this order

### 1. Remove provisioning work from routine authenticated reads

Evidence: `app/lib/auth.ts:50`. Local authentication reads the user, upserts it with a fresh `updatedAt`, then attempts to insert settings on every API request. Production authentication additionally calls `client.users.getUser()` on each request before upserting the user and settings. The production Clerk leg was inspected, not timed.

`app/lib/v2/settings.ts:28` inserts settings before selecting them. Review first reaches the authentication settings insert, then repeats settings provisioning inside the application service. A local Settings GET executes five SQL calls across authentication and settings access to return 28 bytes.

Change: provision at initial sign-in or an explicit missing-record fallback, synchronize profile changes through a defined update path, and keep routine reads free of upserts. Reuse identity/settings within each request. Preserve authenticated learner isolation and revocation checks; an identity cache must have a clear freshness policy.

Expected impact: removing three 125 ms trips is about 375 ms in this local environment. This is a measured estimate, not a promised production saving. It also eliminates avoidable writes to the same user row under concurrent requests.

### 2. Collapse Review's database waterfall and specialize its summary

Evidence: `app/lib/v2/settings.ts:68`, `app/lib/v2/liveReview.ts:164`, `:230`, `:259`, and `:494`.

Review serially provisions settings, reads timezone, computes day boundaries through another database call, fetches queue/status, and finally loads Tags. Several calls can be combined. The day calculation itself executes in 0.03 ms but costs about 124 ms as a separate trip.

The summary calls the same `reviewStatus()` as Review. To return a count, it retrieves and orders all 340 due Questions, including their prompts. Its warm application work takes 754 ms; the actual queue query executes in about 6.5 ms. Queue ordering repeats correlated latest-grade work; the captured plan visits a submissions scan 306 times in each of two correlated branches. This is currently small SQL time but unnecessary for a count and a scale risk.

Change: use a dedicated count/min query for summary. Compute timezone/day alongside the relevant database query, consolidate pending/future/queue selection, and return only the selected Question plus a small candidate window. Keep count and eligibility complete: the product requires every due Question, immediate new-Question eligibility, MCP priority, and Again ordering. Fetching a window must not cap queue membership. Use set-based latest-evidence joins or transactionally maintained rebuildable derived metadata instead of repeated correlated lookups where profiling supports it.

Expected impact: remove multiple 125 ms request legs and stop transferring the whole due queue for a count or one Question.

### 3. Make Next question available locally and shorten submission acknowledgement

Evidence: `app/(app)/review/ReviewApp.tsx:603`. Next question awaits a complete queue fetch, and the composer is disabled for the duration. The browser reproduced the visible wait.

Change: prefetch a small window of upcoming eligible Questions and switch locally on Next. Refresh in the background and invalidate on answers, flags, additions, restorations, corrections, timezone/day changes, and external MCP updates. Validate eligibility on submission; a stale prefetched candidate must not create invalid learning evidence.

Evidence: `app/lib/v2/liveReview.ts:512` and `app/api/v2/review/answer/route.ts`. The answer save transaction has many sequential SQL operations, then rereads evaluation state, then awaits workflow dispatch. The UI subsequently awaits another full queue request before enabling the next composer. Model execution is already asynchronous; acknowledgement is still on a long critical path. This save path was inspected, not executed against the learner's history.

Change: combine transaction work where possible, return the known pending evaluation and authoritative next-Question information in the acknowledgement, and advance the UI immediately once the save is accepted. Preserve the durable job, idempotency receipt, immutable evidence, and transactional eligibility checks. Do not substitute an unreliable detached promise for durable dispatch.

### 4. Stop preloading the full Admin trace payload during learning

Evidence: `app/AuthenticatedProviders.tsx:12` preloads Admin code and data for an administrator using either learning page. `app/AppViewCache.tsx` stores the full response. The API returned 2.69 MB containing request/response payloads for 200 interactions, even though learning does not need those payloads.

Change: load Admin data on intent or navigation; give its list a compact paginated summary endpoint; fetch full call payloads only when opening a detail. Keep learning-view data prefetching deduplicated and prioritize the current screen. JSON parsing of this payload alone took roughly 6.2 ms in Node; browser allocation/rendering and slow-network transfer were not profiled. At 10 Mbps, 2.69 MB would take about 2.15 seconds before compression and other overhead; actual HTTP compression was not measured.

### 5. Remove client-side waterfalls and stop polling whole views

Evidence: `app/(app)/AuthenticatedClientHydrator.tsx` starts a dynamic client import from an effect. Only after the client mounts do page effects start API requests. Route prefetch does not automatically preload these custom client-side data requests.

Evidence: `app/(app)/review/ReviewApp.tsx:518` fetches settings before calling `loadQueue()`, although queue responses already contain timezone. With saved settings, that adds a measured roughly 0.63-second request before queue refresh. Without saved settings, an additional PATCH joins the chain. `app/ToolbarState.tsx` separately fetches summary while Library preloads a full Review response that also contains summary.

Change: start code/data loading together from an intentional navigation preloader or an authenticated bootstrap payload. Consume cached timezone/queue information and perform timezone detection only when necessary. Share toolbar summary with the existing Review request. Keep private learner data out of a publicly cached shell.

Evidence: pending feedback triggers a full queue reload after 900 ms, including authentication, timezone, queue computation, previous answers, and Tags. At measured queue latency, each polling cycle is roughly 2.2 seconds before completion. It is request completion followed by delay, not overlapping fixed-frequency polling by design.

Change: use the existing evaluation endpoint for pending submission IDs, or a compact batch endpoint, then merge updates. Push completion events where deployment support warrants them. Refresh queue membership only when an evaluation actually changes it. Scope updates by submission/Question and avoid allowing an older response to overwrite newer view state.

### 6. Improve inference with an accuracy and tail-latency benchmark

Fresh calls to the configured `google/gemini-3.8-flash` evaluator took 2,984, 2,038, and 3,237 ms, with expected Correct, Incorrect, and Partial results. Three cases cannot establish accuracy or p95 latency.

Historical successful `google/gemini-3.1-flash-lite` evaluation calls: n=30, median 1,467 ms, observed p95 1,904 ms. These used different questions, timestamps, and conditions. They suggest a model comparison worth running, not a valid controlled speed/accuracy comparison. Historical embedding calls had median 289 ms and p95 1,429 ms for 98 successes; seven errors occurred. Older tag-classification traces are not evidence that current Library reads invoke a classifier: current related-Tag reads use SQL/embeddings.

Evidence: `app/lib/v2/model.ts` uses a complete non-streamed JSON response, up to 900 output tokens, unconstrained provider selection apart from required parameters, and a 60-second timeout. `app/lib/v2/recallEvaluation.ts` retries any exception up to three times; `runLiveEvaluationJob()` has another retry layer. Three timed-out model attempts can consume about 180 seconds before workflow/job retries, excluding overhead.

Change: compare candidate evaluators on the same representative corpus, checking false-Correct rate, feedback usefulness, latency distribution, provider errors, and output length. Select only after quality passes. Keep the existing strict result schema; reduce needless output only if all required claims/gaps remain represented. Evaluate provider latency selection and input-prefix caching against current provider documentation and actual metrics. Classify retryable failures, enforce a total evaluation deadline, and separate transient transport failures from schema/configuration errors. Keep failed evaluations visible and recoverable without inventing a grade. Streaming can expose validated progress or feedback, but must not commit partial grading JSON or alter scheduling early.

### 7. Address rendering and data growth after the large waits

No browser frame-time bottleneck was established. The actual Markdown component, rendered through React's server renderer on real Library text, took a median about 4 ms for 50 blocks, 7 ms for 100 blocks, and 14 ms for 400 blocks; maximum at 400 was 26 ms. This excludes browser reconciliation, style, layout, paint, and lower-powered devices.

Evidence: Review owns the answer state, so typing rerenders its Question and previous-answer list; `FeedbackRow` is not memoized. Library rerenders its rows when search changes. Collapsed Library details remain mounted and render the Answer Standard. Load more appends every page without virtualization. `AnswerComposer` resizes once in the change handler and again in an effect for the same value; each resize writes height and reads `scrollHeight`. AppViewCache retains search-result entries without an explicit size bound.

Change: isolate composer state where appropriate; stabilize props and memoize unchanged Question/feedback rows; mount detail content on expansion; do one textarea measurement per change; bound the search cache; use windowing or measured content visibility when the list grows. Cache expensive Markdown parsing by immutable text. Profile real browser React commits and layout before choosing further changes. The modal backdrop blurs are a lower-priority mobile profiling candidate, not a verified cause of current delays.

### 8. Make search and Tags scale without breaking semantics

Evidence: Library search in `app/lib/v2/service.ts:519` uses `to_tsvector('simple', q.prompt || ' ' || q.reference_answer)`, while `app/db/v2/schema.ts:193` indexes a differently weighted/coalesced expression. The Library full-text expression does not match that index. Its observed query executed in about 17 ms on 367 Questions, so this is primarily a growth concern. A sequential scan on such a small table alone is not evidence of a missing useful index.

Change: use the existing indexed expression or a matching generated search document consistently; benchmark plans at representative per-learner and total database sizes. Consider an index on learner plus updated-time/id for Library cursor order only after comparing plans. Current schema has no matching Library-order index.

Related Tags executed in about 52 ms for 50 Questions and 63 Tags, and 30 ms for the searched page. The plan compares each selected Question against all active Tags and revisits materialized scored/classified results to calculate diagnostics. Cost grows with page size × learner Tag count. Evaluation-only reference Tags can add another database query on Library's critical path.

Change: remove evaluation reference judgments from ordinary learner reads, reduce repeated diagnostic passes, and benchmark 5,000 Questions/1,000 Tags with the existing script. Preserve compatible embedding spaces, exact-match priority with semantic relatedness, strongest relevance across selected Tags, and complete stable pagination. Global approximate nearest-neighbor limits must not silently discard learner-specific results.

## Suggested acceptance targets

These are proposed engineering targets, not approved product requirements or achieved results:

- Local visible feedback for clicks and typing: under 100 ms at p95; no long main-thread task over 50 ms during routine interactions.
- Cached Next question and repeat tab navigation: under 100 ms at p95 on the target devices.
- Warm read responses: under 250 ms at p95 from the intended deployment region, with breakdowns for authentication, pool wait, SQL, serialization, and transfer.
- Save acknowledgement: under 300 ms at p95, with the next composer available while evaluation continues.
- Evaluator result: initial target under 2 seconds at p95, conditional on passing the existing correctness requirements; report failures and tails separately.
- Learning navigation must not fetch full trace bodies; ordinary text editing should not rerender unchanged feedback or collapsed details.

Instrument click-to-next-Question, submission-to-save, save-to-evaluation-completion, and completion-to-visible-feedback separately. Add Server-Timing/spans at meaningful boundaries, not just total model-call latency. Benchmark cold/warm production behavior, a midrange phone, slower network, and a representative learner. Tune database pool and trace sampling from measured wait/overhead; server tracing currently samples 100%, but its cost was not isolated here.

For deployment locality, verify function and database regions before moving either. Vercel recommends placing functions near the data source: [function regions](https://vercel.com/docs/functions/configuring-functions/region). Next.js distinguishes route prefetch from application data strategies: [prefetching](https://nextjs.org/docs/app/guides/prefetching). Check those against the installed Next.js 16.3 documentation before implementation.

## Limits and preserved product intent

The audit establishes several reproducible warm delays; it does not prove every possible bottleneck. Production Clerk overhead, workflow dispatch/queue time, answer-save transactions, correction/rebuild scaling, real browser long tasks, mobile GPU/layout cost, and billion-Question database performance remain unmeasured.

No performance fix should truncate Review, change grading to make it faster, skip duplicate prevention, weaken learner isolation, compare incompatible embeddings, or persist Tag assignments. Cached/preloaded views need explicit invalidation and authoritative write validation. Root SPECS.md was reread; the stakeholder explicitly approved adding: “Waxon must keep learner interactions responsive without perceptible UI stalls during navigation, rendering, or automated evaluation.” That exact requirement was added under Responsiveness.
