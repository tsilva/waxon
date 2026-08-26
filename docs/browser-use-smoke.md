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

After applying a responsive viewport override, reload the route and wait for visible Review or Library content before capturing a screenshot; capturing before the in-app Browser repaints can produce a blank image despite a populated DOM.

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

1. **Empty/add/search/edit:** In Library, add a unique standalone question, find it by search, edit its answer, confirm the edit warning, then archive and restore it. Confirm no source, generation, concept, provenance, or document controls appear.
2. **Live Review Queue:** Seed the fixtures, open Review, and confirm every Active unanswered fixture appears immediately in the queue count and can be answered in unrestricted free text. Confirm no daily-plan, session, daily-minute, capacity, new-item, importance, retention-target, flag, skip, or retry control or warning appears.
3. **Successful evaluation feedback:** Submit the stable correct token for one fixture. Confirm `Good` or `Easy`, visible Answer Standard and Demonstrated Gap feedback, and a visible future scheduled Local Day.
4. **Local Day:** Confirm Review automatically persists a detected IANA timezone. Edit it through Local Day settings, save, reopen the dialog, and confirm the saved value remains while Review refreshes.
5. **Reconstruction:** Reload or close and reopen Review after successful recall. Confirm the answered Question stays out of the current queue and the same future schedule is reconstructed without a session-recovery prompt.
6. **MCP visibility:** In Library create a personal token, call `check_questions` with a unique candidate and confirm its per-item coverage/advisory, then call `add_questions` with a unique idempotency key. Repeat the add and confirm one `created` result followed by the identical prior result. Check the same prompt again and require `exact_duplicate`, including its full stored answer and lifecycle. Search for the MCP-added question in Library and through ranked `search_questions`. Revoke the token and confirm the endpoint returns `401`.
7. **Responsive and console check:** Verify desktop and 390 px Library/Review layouts, keyboard focus, timezone dialog containment, and no unexpected browser console errors.

Use accessible roles and visible names, take fresh DOM snapshots before changing locator strategy, and wait for content rather than `networkidle`. Do not stop or restart an existing server.

## Required report

Report the exact URL, in-app Browser use, pass/fail for all seven checks, visible assertions, console warnings/errors, screenshot paths, commands run, and any remaining risk.
