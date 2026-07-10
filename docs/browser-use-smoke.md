# Browser Use Smoke Suite

This markdown file is the source of truth for Waxon's repeatable local product
smoke. Run it with the project-level `run-browser-use-suite` skill and the
official Codex in-app Browser.

## Scope

Prove that the local TCLV/Tiago user can:

1. see deterministic smoke questions in Library;
2. open current Library question details;
3. answer one Review question correctly and one incorrectly;
4. see scores `10` and `2` with their expected feedback; and
5. find the resulting deterministic answer-evaluation traces in Admin.

This suite does not test Clerk sign-in, Learn, question generation, deletion,
archiving, tagging, or production deployment.

## Safety contract

The app normally uses the current shared production database during local
testing. The fixture setup endpoint deletes and recreates only these two
questions for the local test user:

```text
Browser smoke correct card: what exact token proves this answer is correct?
Browser smoke incorrect card: what exact token is intentionally omitted?
```

Do not invoke fixture setup until the user has explicitly authorized replacing
those two fixture records in the configured database. Never delete or reset any
other question, course, trace, tag, attempt, or user. Do not clean up fixture
data after the run unless the user separately authorizes it.

If authorization is absent, mark tests 1-5 `skipped` and report the missing
authorization. Read-only navigation may still be checked.

## Preconditions

- Run from the repository root.
- Use the local TCLV/Tiago identity: `Tiago Silva`
  (`eng.tiago.silva@gmail.com`).
- Use the current configured database; do not substitute a database silently.
- Local test auth must be enabled.
- The user must explicitly authorize the narrowly scoped fixture replacement
  described above.
- Use an existing dev server when one already serves this worktree with both
  smoke flags enabled. Do not stop or restart an existing server.

If a suitable server is not already running, start one and keep its printed URL:

```bash
WAXON_ENABLE_BROWSER_SMOKE_SUPPORT=1 \
WAXON_BROWSER_SMOKE_EVALUATOR=1 \
pnpm dev --port auto
```

The two flags are development-only:

- `WAXON_ENABLE_BROWSER_SMOKE_SUPPORT=1` enables the guarded fixture endpoint.
- `WAXON_BROWSER_SMOKE_EVALUATOR=1` enables deterministic local grading for
  the two named smoke questions only. All other questions retain normal grading.

## Fixture contract

The sole fixture setup surface is:

```text
POST /api/test-support/browser-smoke
```

It must return status `200`, `ok: true`, and exactly the two questions above.
Any `404` means smoke support or local test auth is disabled; stop rather than
loosening the guard.

After explicit authorization, open `<base-url>/library` in the in-app Browser,
then issue the same-origin `POST` from that tab. Browser Use may evaluate a
same-origin `fetch` solely for this deterministic setup step. Assert the status
and JSON response before interacting with the UI.

Do not use the endpoint's `GET` for setup. `GET` is read-only and may be used
only to diagnose the two fixtures' persisted state.

## Stable answers

For the correct question, submit:

```text
The answer includes browser-smoke-correct-token, which is the expected token.
```

Expected result: score `10` and `Contains the expected smoke token.`

For the incorrect question, submit:

```text
This answer deliberately omits the required token.
```

Expected result: score `2` and `Missing the expected smoke token.`

## Test cases

### 1. Local identity and fixture setup

1. Open `<base-url>/library`.
2. Confirm the signed-in identity is `Tiago Silva` and
   `eng.tiago.silva@gmail.com` through the user menu.
3. Perform the authorized fixture `POST` described above.
4. Reload Library and wait for both complete smoke-question texts.

Pass when the identity and both questions are visible. Capture
`/private/tmp/waxon-browser-smoke-library.png`.

### 2. Library question details

1. In Library, scope to the list item containing the complete correct-question
   text. Do not use Review-only CSS classes.
2. Activate that row's accessible expandable control.
3. Activate `More details` within the same list item.
4. Confirm the dialog heading is `Question details`, the dialog contains the
   complete question, and its Answer section contains
   `browser-smoke-correct-token`.
5. Close it with `Close question details`.

Pass when the current Library dialog shows the seeded question and answer.
Capture `/private/tmp/waxon-browser-smoke-question-details.png`.

### 3. Correct Review grading

1. Open `<base-url>/review` and wait for the complete correct-question text.
2. Fill the single answer field labelled `Your answer` with the stable correct
   answer.
3. Activate `Submit answer`.
4. Wait for `Contains the expected smoke token.` and an accessible score of
   `Score 10 out of 10` in the resolved answer row.

Pass only when both feedback and score are visible.

### 4. Incorrect Review grading

1. Wait for the complete incorrect-question text without forcing queue state.
2. Fill `Your answer` with the stable incorrect answer and submit it.
3. Wait for `Missing the expected smoke token.` and an accessible score of
   `Score 2 out of 10` in the resolved answer row.

Pass only when both feedback and score are visible. Capture
`/private/tmp/waxon-browser-smoke-review-results.png`.

### 5. Admin trace visibility

1. Open `<base-url>/admin`.
2. Wait for the `Admin traces` heading.
3. Find an `Answer evaluation` interaction containing the complete incorrect
   smoke-question text.
4. Expand it and open the call labelled
   `Open LLM call details for evaluate_answer_browser_smoke`.
5. Confirm the detail surface identifies model
   `deterministic-browser-smoke`, status `ok`, and includes the submitted
   incorrect answer in the request payload.

Pass when the deterministic evaluation call and its scoped payload are visible.
Capture `/private/tmp/waxon-browser-smoke-admin-traces.png`.

## Browser rules

- Use the current Browser skill runtime; do not import a version-pinned cached
  `browser-client.mjs` path from this repository.
- Use the in-app Browser selected by the repository instructions.
- Prefer accessible roles, names, and text scoped to the current visible
  surface. Take a fresh DOM snapshot before changing locator strategy.
- Use `domcontentloaded` plus content-specific waits, not `networkidle`.
- A normal reload is allowed when a client route initially shows stale cached
  state.
- Do not click `Archive`, `Delete`, `Remove`, or other destructive controls.
- Expected Clerk development-key warnings are non-blocking. Any other browser
  warning or error must be reported.

## Required report

Report:

- suite path and exact base URL;
- in-app Browser usage;
- `pass`, `fail`, or `skipped` for all five tests;
- whether fixture replacement was explicitly authorized;
- visible assertions and any console warnings/errors;
- screenshot paths for passes and failures when available;
- commands run and any code changes made; and
- remaining risk or intentionally skipped coverage.
