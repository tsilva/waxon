# Lean Core browser suite

This is the source of truth for Waxon’s local end-to-end product check. Run it with the project-level `run-browser-use-suite` skill and the native Codex in-app Browser.

## Safety and setup

The development fixture replaces only these two exact questions for the local test user and never touches another learner:

```text
Browser smoke correct card: what exact token proves this answer is correct?
Browser smoke incorrect card: what exact token is intentionally omitted?
```

The current task explicitly authorizes that narrowly scoped replacement. Do not reset the database or delete any other question or learning history.

Use an existing suitable dev server. Otherwise start one and keep its printed auto-port URL:

```bash
WAXON_ENABLE_BROWSER_SMOKE_SUPPORT=1 \
WAXON_BROWSER_SMOKE_EVALUATOR=1 \
keyenv run -- pnpm dev --port auto
```

From a tab already open to the app, issue same-origin `POST /api/test-support/browser-smoke` and require `200` with two results. A `404` means the development guard is disabled; stop instead of weakening it.

## Stable answers

Correct:

```text
browser-smoke-correct-token
```

Incorrect:

```text
This answer deliberately omits the required token.
```

## Acceptance journey

1. **Empty/add/search/edit:** In Library, add a unique standalone question, find it by search, edit its answer, confirm the edit warning, then pause and restore it. Confirm no source, generation, concept, provenance, or document controls appear.
2. **Bounded Review:** Seed the fixtures, open Review, and confirm the daily-plan remaining count is bounded and the correct fixture can be answered in free text.
3. **Correct and incorrect evaluation:** Submit the stable correct token for one fixture and the incorrect text for the other. Confirm `Good` or `Easy` for the correct response, `Again` for the incorrect response, and visible expected-answer/missing-point feedback.
4. **Correction and delayed retry:** Change the incorrect first grade to `Good`, then back to `Again`; confirm scheduling is rebuilt and exactly one retry is offered only after another question or the ten-minute minimum. Confirm a failed retry does not create another same-day retry.
5. **Future scheduling:** Complete a successful answer and confirm Library shows a future due date and recall estimate.
6. **MCP visibility:** In Library create a personal token, call `add_questions` with a unique idempotency key through `/api/mcp`, repeat the same call, and confirm one `created` result followed by the identical prior result. Search for the MCP-added question in Library and through `search_questions`. Revoke the token and confirm the endpoint returns `401`.
7. **Responsive and console check:** Verify desktop and 390 px Library/Review layouts, keyboard focus, and no unexpected browser console errors.

Use accessible roles and visible names, take fresh DOM snapshots before changing locator strategy, and wait for content rather than `networkidle`. Do not stop or restart an existing server.

## Required report

Report the exact URL, in-app Browser use, pass/fail for all seven checks, visible assertions, console warnings/errors, screenshot paths, commands run, and any remaining risk.
