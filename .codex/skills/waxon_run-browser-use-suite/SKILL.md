---
name: waxon_run-browser-use-suite
description: Run a Waxon browser-use test suite from a markdown file. Use when the user asks to run, rerun, execute, validate, or fix a Browser Use or signed-in user experience suite and provides or references a `.md` test-suite file such as `tests/browser-use-clean-break-journey.md`.
---

# Run Browser Use Suite

## Input

Require one markdown suite path. If the user does not provide it, ask for the path before starting.

Treat the markdown file as the source of truth for scope, preconditions, destructive-action limits, skip rules, expected results, and reporting format.

## Workflow

1. Read the suite markdown fully.
2. Follow the global Browser Use and Testing policy for local browser testing. Read the bundled Browser runtime instructions, initialize `browser-client`, select Brave Stable’s Agents profile with `agent.browsers.get("brave")` unless the user explicitly requests another browser, and use documented APIs. If Brave is unavailable, report the connection problem without switching browsers.
3. Reuse an existing local dev server at the suite's target URL when one is already running. Do not kill or restart existing servers. If no server is running, start one with:

   ```bash
   pnpm dev --port auto
   ```

   Report the printed URL. If automatic ports are unsupported or startup fails, stop and warn the user.
4. Open the app with the configured agent browser and perform the suite through visible UI interactions. Prefer DOM snapshots and scoped locators from the current visible page. Use direct API or shell checks only as diagnostics when the configured agent browser cannot inspect the needed state.
5. Record each test as `pass`, `fail`, or `skipped`, including route, visible assertions, console warnings/errors, and screenshots for failures or ambiguous states.
6. When a real app bug is found, make the smallest focused fix, reload the page, and rerun the failing test plus any affected nearby flow. Do not clean up data if the suite says not to.
7. After code changes, run:

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

8. Store useful future-run notes in a repo file if the run reveals Browser/runtime quirks or app setup requirements. Prefer updating an existing runbook such as `docs/browser-use-smoke.md` when relevant.

## Browser Use Notes

- Capture screenshots under `/private/tmp` with names that include the suite or state, for example `/private/tmp/waxon-signed-in-question-bank.png`.
- If `fill("")` does not clear an input in the configured agent browser, click the input, press `ControlOrMeta+A`, then press `Backspace`.
- If exact locators fail because rendered markdown splits text across inline elements, take a fresh DOM snapshot and use the accessible name shown there.
- For Next.js local apps, use `domcontentloaded` waits and content-specific text waits. Avoid relying on `networkidle`.
- Treat expected Clerk development-key warnings as non-blocking, but report them. Explain any other warnings or errors.

## Waxon-Specific Checks

- Local auth should show `Tiago Silva` and `eng.tiago.silva@gmail.com`.
- The Question Bank should be visible locally for the test user.
- Do not click destructive controls such as `Archive`, `Delete`, or `Remove` unless the suite explicitly requires it.
- If a route first renders stale cached state, verify whether a normal remount or reload recovers it. If stale loaded flags cause persistent incorrect UI, fix the cache/load guards and retest direct route and refresh persistence.

## Final Report

Lead with findings if bugs were found. Then include:

- suite path and URL
- configured agent browser and profile used, with any explicitly approved fallback noted
- pass/fail/skipped table for every test
- fixes made with file links
- commands run
- relevant console warnings/errors
- screenshot evidence as local image links
- remaining risk or intentionally skipped coverage
