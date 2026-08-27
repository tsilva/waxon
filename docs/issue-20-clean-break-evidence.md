# Issue 20 clean-break evidence

## Candidate

- Base: `origin/main` at `2b568e592fbe6ba58bcd950a430dcdb4d0416f1e`
- Branch: `codex/issue-20-clean-break-journey`
- Native suite: `tests/browser-use-clean-break-journey.md`
- Disposable database: local `pgvector/pgvector:pg16`; no production data or secrets used
- Prepared local URL: `http://localhost:65221`
- Native Browser owner: coordinator with the connected Codex Desktop `iab`

## Native visible acceptance

The implementation worker had no attached `iab` pane and did not substitute another browser. The coordinator must run the full issue-scoped suite against the final candidate and replace the pending cells below before merge approval.

| Case | Result | Visible assertions |
| --- | --- | --- |
| 1. Isolated identity/private Question Bank/initial obsolete-control sweep | pending | pending native `iab` run |
| 2. Add/search/immutable replace/Archive/restore | pending | pending native `iab` run |
| 3. Validation Flagging/Flagged attention inbox | pending | pending native `iab` run |
| 4. Automatic/editable IANA timezone/live Local Day membership | pending | pending native `iab` run |
| 5. Generic evaluation/Again/Hard/Good/Easy/correction | pending | pending native `iab` run |
| 6. Review Flag modal/accessibility/immediate removal | pending | pending native `iab` run |
| 7. Authorized MCP Client journey/isolation/revocation | pending | pending native `iab` run |
| 8. Desktop/narrow responsive and obsolete-control sweep | pending | pending native `iab` run |
| 9. Console and evidence review | pending | pending native `iab` run |

Console findings: not inspected by this worker because native `iab` was unavailable. The suite requires the coordinator to report all messages and treats unexpected application, hydration, request, or accessibility errors as failures.

Screenshots: none captured by this worker. The suite requires these successful-state paths plus a screenshot for every failure or ambiguity:

- `/private/tmp/issue-20-clean-break-library-desktop.png`
- `/private/tmp/issue-20-clean-break-review-flag-narrow.png`
- `/private/tmp/issue-20-clean-break-library-narrow.png`
- `/private/tmp/issue-20-clean-break-review-desktop.png`
- `/private/tmp/issue-20-clean-break-review-narrow.png`

## Automated and transport evidence

| Command/check | Outcome |
| --- | --- |
| `pnpm db:reset -- --confirm-clean-break` with both DB URLs set to the disposable database | passed; clean baseline installed |
| `pnpm test` with `APPLICATION_CONTRACT_TEST_DATABASE_URL`, `QUESTION_SEARCH_TEST_DATABASE_URL`, and both runtime DB URLs set to the disposable database | passed: 80 tests, 0 failed, 0 skipped |
| repeated browser fixture seed contract | passed: new identities, reset mastery, queue eligibility restored, prior Learning Evidence preserved, unrelated Learner unchanged, unexpected Active Question rejected without mutation |
| exact catalog contract | passed: 13 accepted tables; only Active/Flagged/Archived lifecycle values; obsolete objects absent |
| `pnpm typecheck` | passed |
| `pnpm lint` | passed |
| `pnpm security:check` | passed: registry-only dependency sources; no known vulnerabilities |
| `pnpm db:generate` then `git diff --exit-code -- drizzle-v2` | passed: `No schema changes, nothing to migrate` |
| `VERCEL_ENV=preview pnpm build` against the disposable database | passed in a self-contained temporary mirror while the required dev server remained running; migrations applied and all 23 routes built |
| local `/api/mcp` Streamable HTTP diagnostic at `http://localhost:65221` | passed: credential 200, initialize 200 with protocol `2025-03-26`, stateless session header absent, initialized notification 202, tools/list 200 with all three canonical tools, revoke 200, revoked call 401 plain-text `Unauthorized` |

The first temporary build mirror attempt failed before application compilation because Turbopack rejects a `node_modules` symlink outside the project root. Repeating the same candidate build with a real hard-linked dependency tree passed. This was build-isolation tooling, not an application failure.

## CI evidence

The CI workflow now provisions a healthy pgvector/Postgres service, installs the clean baseline, supplies all DB test variables, runs the full suite without expected DB skips, verifies schema-generation drift, and builds with `VERCEL_ENV=preview`. This removes the former CI path where application/catalog/search DB suites could skip.

## Hosted-preview distinction

The passing `VERCEL_ENV=preview pnpm build` is local hosted-mode build evidence only. No Vercel or other deployed preview was created or inspected by this worker, so there is no deployed-preview URL or live-preview claim in this report. A deployed-preview check, if required by merge policy, must be recorded separately after the PR deployment exists.

## Remaining risk and handoff

The sole required acceptance handoff is the coordinator's complete visible native `iab` run and report update. Until that run passes, responsive layout, focus behavior, visible legacy-control absence, screenshots, and browser console state remain unverified on this candidate even though their deterministic and component contracts pass.
