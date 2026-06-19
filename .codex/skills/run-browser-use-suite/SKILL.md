---
name: run-browser-use-suite
description: Run a Waxon browser-use test suite from a markdown file. Use when the user asks to run, rerun, execute, validate, or fix a Browser Use or signed-in user experience suite and provides or references a `.md` test-suite file such as `tests/browser-use-signed-in-user-experience.md`.
---

# Run Browser Use Suite

## Input

Require one markdown suite path. If the user does not provide it, ask for the path before starting.

Treat the markdown file as the source of truth for scope, preconditions, destructive-action limits, skip rules, expected results, and reporting format.

## Workflow

1. Read the suite markdown fully.
2. Use the official OpenAI Browser Use plugin for all local browser testing. Read and follow the Browser skill before browser actions.
3. Start or reuse the local dev server at the suite's target URL. For Waxon this is normally:

   ```bash
   pnpm dev
   ```

   If sandboxing blocks local port binding, rerun the same server command with escalation. Stop only servers you started.
4. Open the app with Browser Use and perform the suite through visible UI interactions. Prefer DOM snapshots and scoped locators from the current visible page. Use direct API or shell checks only as diagnostics when Browser Use cannot inspect the needed state.
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

- Capture screenshots under `/private/tmp` with names that include the suite or state, for example `/private/tmp/waxon-signed-in-library.png`.
- If `fill("")` does not clear an input in Browser Use, click the input, press `ControlOrMeta+A`, then press `Backspace`.
- If exact locators fail because rendered markdown splits text across inline elements, take a fresh DOM snapshot and use the accessible name shown there.
- For Next.js local apps, use `domcontentloaded` waits and content-specific text waits. Avoid relying on `networkidle`.
- Treat expected Clerk development-key warnings as non-blocking, but report them. Explain any other warnings or errors.

## Waxon-Specific Checks

- Local auth should show `Tiago Silva` and `eng.tiago.silva@gmail.com`.
- The library should be visible locally for the test user.
- Do not click destructive controls such as `Archive`, `Delete`, or `Remove` unless the suite explicitly requires it.
- For generation tests without an LLM key, a clear unavailable/configuration error is acceptable.
- If a route first renders stale cached state, verify whether a normal remount or reload recovers it. If stale loaded flags cause persistent incorrect UI, fix the cache/load guards and retest direct route and refresh persistence.

## Final Report

Lead with findings if bugs were found. Then include:

- suite path and URL
- Browser Use plugin used, with fallback only if explicitly approved
- pass/fail/skipped table for every test
- fixes made with file links
- commands run
- relevant console warnings/errors
- screenshot evidence as local image links
- remaining risk or intentionally skipped coverage
