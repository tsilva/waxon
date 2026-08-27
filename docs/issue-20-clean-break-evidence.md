# Issue 20 clean-break evidence

## Issue 32 Library Flagging extension

- Branch: `codex/issue-32-final-question-semantics`
- Tested code revision: `ff8d543697f4c385af760b7ecea09f21d0b98e8b`
- Tested local URL: `http://localhost:65344`
- Native Browser: connected Codex Desktop `iab`; no external browser or fallback used
- Disposable database: local `pgvector/pgvector:pg16` on an automatically assigned loopback port; the clean baseline was installed immediately before the run and no production data or secrets were used

The issue #32 extension in case 3A passed at desktop and `390 x 844`. Through visible Library interactions, the dedicated acceptance Learner added two Active Questions, opened Review to identify the current Question, returned to the Library, and Flagged the other, non-current Question with `Prompt is unclear`, `Answer standard is wrong`, and the exact detail `Final-head retained Question needs attention outside Review.` The Flagged inbox showed Learner origin, both reasons, the detail, and the same recorded Question identity. At 390 px, the inbox and all action controls remained contained with no horizontal overflow; the modal fit inside the viewport at 359 x 824 with 10 px edge clearance, all five reason badges formed one column, and empty submission remained enabled. Submitting the second Flag without a reason or detail succeeded, retained that Question's identity, produced a distinct empty Learner Flag in the inbox, and left Review visibly at `0 due` with `Your queue is clear.` This journey was replayed after the final race/error/refresh review fixes on the exact revision above.

Console inspection found no application exception, hydration error, failed request, or accessibility error. Only normal React/HMR/Web Analytics development messages and Next's known development-only smooth-scroll advisory appeared.

| Issue 32 check | Result |
| --- | --- |
| Arbitrary non-current Active Question exposes and submits the shared Flag dialog | passed |
| Multiple reasons, optional detail, Learner origin, and same Question identity | passed |
| Empty Flag submission | passed |
| Immediate removal from Review and Flagged inbox visibility | passed |
| Desktop and 390 px containment, one-column narrow reason badges, and modal fit | passed |
| Native console review | passed |

Issue #32 screenshots:

- `/private/tmp/issue-32-final-head-flag-modal-narrow.png`
- `/private/tmp/issue-32-final-head-flagged-bank-narrow.png`
- `/private/tmp/issue-32-final-head-flagged-bank-desktop.png`
- `/private/tmp/issue-32-final-head-review-clear-desktop.png`

The issue #32 disposable-database verification also passed before this final native replay: 93 tests, 0 failed, 0 skipped; typecheck; lint; dependency security; schema generation with no drift; and a `VERCEL_ENV=preview` hosted-mode build. The pull request's Vercel preview failure remains an external hosted-preview limitation and is not represented as a live-preview pass.

## Candidate

- Base: `origin/main` at `2b568e592fbe6ba58bcd950a430dcdb4d0416f1e`
- Branch: `codex/issue-20-clean-break-journey`
- Tested code revision: `fc768404dc754ec227c7a08ec009ef6d16ddccdf`
- Native suite: `tests/browser-use-clean-break-journey.md`
- Disposable database: local `pgvector/pgvector:pg16`; no production data or secrets used
- Prepared local URL: `http://localhost:65221`
- Native Browser owner: coordinator with the connected Codex Desktop `iab`
- Diagnostic transport: runner-side Node `fetch` to the suite's guarded absolute `http://localhost:65221` endpoints because IAB evaluation has no `fetch`; Learner mutations remain visible and the MCP token remains only in process memory

## Native visible acceptance

The coordinator completed the issue-scoped suite in the connected native Codex Desktop `iab`; no external browser or implementation worker substituted for that run. Cases 1-5 and 7-9 passed on `f0cb73ad50f372fa9d4928399eb052dfe60ee6f2`. The only subsequent application change made keyboard focus and button activation explicit inside the Review Flag dialog; case 6 was then rerun natively on `fc768404dc754ec227c7a08ec009ef6d16ddccdf`, including a new narrow screenshot. All nine cases are accepted on the tested candidate.

Earlier attempts on `892fd84e7e97e3f462844228b069f8727186a6eb`, `bd60112447e7570908e22824271fbcf3a2af7d8f`, and `503e8a083cdb307e7592273d08da78ab5047cb4b` are superseded. They exposed and led to repairs for request-time acceptance authorization and a retained Turbopack module-graph export; none is used as final acceptance evidence.

| Case | Result | Visible assertions |
| --- | --- | --- |
| 1. Isolated identity/private Library/initial obsolete-control sweep | passed | Dedicated acceptance Learner opened an empty private Library; Active, Flagged, and Archived were the only lifecycle filters; obsolete source, generation, concept, capacity, retention, Pause, and Trash controls were absent. |
| 2. Add/search/immutable replace/Archive/restore | passed | A Prompt and Answer Standard were added and found; correct recall produced immutable evidence and a future schedule; replacement created a distinct reset Question while preserving the archived original's evidence; Archive kept it out of Review and restore preserved identity/evidence. |
| 3. Validation Flagging/Flagged attention inbox | passed | A semantically questionable candidate entered Flagged with Waxon-validation origin and a readable reason; the inbox exposed restore, replace, and archive resolution actions. |
| 4. Automatic/editable IANA timezone/live Local Day membership | passed | Europe/Lisbon was detected and persisted automatically; switching between Pacific/Kiritimati (`2026-08-28`) and Pacific/Pago_Pago (`2026-08-27`) recomputed queue membership from 6 to 5 without session state, and reload preserved the result. |
| 5. Generic evaluation/Again/Hard/Good/Easy/correction | passed | The one free-text path showed Answer Standard and Demonstrated Gap; Again moved to the queue end and returned the same day; correction produced ordered future dates Hard `2026-08-29`, Good `2026-08-30`, Easy `2026-09-04`; the corrected grade survived reload. |
| 6. Review Flag modal/accessibility/immediate removal | passed | The named modal exposed five optional badges, optional detail, and enabled empty submission. Native Tab and Shift+Tab advanced and wrapped focus, Enter and Space toggled a badge, Escape closed and restored focus to the trigger. Detailed and empty Flag submissions both removed the current Question immediately and appeared distinctly in the Flagged inbox. |
| 7. Authorized MCP Client journey/isolation/revocation | passed | UI-created authorization initialized Streamable HTTP MCP; add returned canonical Active/Flagged outcomes, replay returned the same identities, a new key returned exact duplicates, search returned full standards and lifecycle, another Learner was excluded, UI revocation made the next call return 401, and the temporary credential was revoked. |
| 8. Desktop/narrow responsive and obsolete-control sweep | passed | Library and Review were visually inspected at desktop and 390 x 844; long content, grade controls, the modal, and all Library states remained contained with no clipping or overlapping actions; the obsolete-control sweep remained clean. |
| 9. Console and evidence review | passed | No application, hydration, request, or accessibility errors appeared. The only message was Next's development-only smooth-scroll advisory; all visible assertions, tested URL, commands, screenshots, and hosted-preview distinction are recorded here. |

Console findings: the native run produced no application, hydration, request, or accessibility errors. The only console message was Next's development-only `scroll-behavior: smooth` advisory.

Successful-state screenshots:

- `/private/tmp/issue-20-clean-break-library-desktop.png`
- `/private/tmp/issue-20-clean-break-review-flag-narrow.png`
- `/private/tmp/issue-20-clean-break-library-narrow.png`
- `/private/tmp/issue-20-clean-break-review-desktop.png`
- `/private/tmp/issue-20-clean-break-review-narrow.png`

## Automated and transport evidence

| Command/check | Outcome |
| --- | --- |
| `pnpm db:reset -- --confirm-clean-break` with both DB URLs set to the disposable database | passed; clean baseline installed |
| `pnpm test` with `APPLICATION_CONTRACT_TEST_DATABASE_URL`, `QUESTION_SEARCH_TEST_DATABASE_URL`, and both runtime DB URLs set to a fresh disposable database | passed on `fc768404dc754ec227c7a08ec009ef6d16ddccdf`: 87 tests, 0 failed, 0 skipped |
| repeated browser fixture seed contract | passed: new identities, reset mastery, queue eligibility restored, Archived-predecessor/current-Flagged mixes converge, prior Learning Evidence preserved, unrelated Learner unchanged, unexpected Active Question rejected without mutation |
| deterministic acceptance evaluator and resolved-answer layout contracts | passed: authorization uses a dependency-free identity leaf rather than the hot-reloaded auth module; an authorized development submission traverses the application boundary, persisted DB job, and production-like Workflow consumer without a model call; authorization is omitted for production-time submissions, other Learners, and unnamed Prompts; job consumption revalidates the persisted marker, Learner, and Prompt; metadata remains in the main content grid and cannot cover Answer Grade controls |
| retained-server Answer submission at `http://localhost:65221` | passed without restart: POST returned `202`, the persisted job recorded the narrow authorization, and polling completed with `Good` plus deterministic feedback; the server PID and original start time remained unchanged |
| exact catalog contract | passed: 13 accepted tables; only Active/Flagged/Archived lifecycle values; obsolete objects absent |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed |
| `pnpm security:check` | passed: registry-only dependency sources; no known vulnerabilities |
| `pnpm db:generate` then `git diff --exit-code -- drizzle-v2` | passed: `No schema changes, nothing to migrate` |
| `VERCEL_ENV=preview pnpm build` against the disposable database | passed in a self-contained temporary mirror while the required dev server remained running; migrations applied and all 23 routes built |
| local `/api/mcp` Streamable HTTP diagnostic at `http://localhost:65221` | passed before the native run: runner-side Node transport used the absolute tested-origin endpoint for initialize/notification, stable `candidateId` check payload, ID-free add payload, canonical Active/Flagged creation, idempotent replay, exact duplicate detection, revocation, and revoked call 401; token was not logged or persisted |

The first temporary build mirror attempt failed before application compilation because Turbopack rejects a `node_modules` symlink outside the project root. Repeating the same candidate build with a real hard-linked dependency tree passed. This was build-isolation tooling, not an application failure.

## CI evidence

The CI workflow now provisions a digest-pinned pgvector/Postgres service, installs the clean baseline, supplies all DB test variables, runs the full suite without expected DB skips, verifies schema-generation drift, and builds with `VERCEL_ENV=preview`. This removes the former CI path where application/catalog/search DB suites could skip.

## Hosted-preview distinction

The passing `VERCEL_ENV=preview pnpm build` is local hosted-mode build evidence. The PR's Vercel preview was attempted, but Vercel reported deployment `dpl_DEENVrGbknrGxU2rk9KUtX5eNhgo` as `ERROR` without build output even though its build record was `READY`; no live-preview claim is made. GitHub CI, CodeQL, and dependency review passed on the prior application revision, and the final revision must receive fresh checks before merge.

## Remaining risk and handoff

Native acceptance and local gates are complete. Remaining merge gates are two independent reviews of the final evidence SHA and fresh hosted checks. The Vercel preview error remains an operational risk until a deployment for the final head is live or the external provisioning failure is confirmed as non-application infrastructure.
