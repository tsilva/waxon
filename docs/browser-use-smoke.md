# Browser Use Smoke Suite

This is the repeatable local Browser-plugin smoke flow for Waxon.

## Purpose

Exercise the real local UI with the installed Codex Browser plugin:

- local test-user auth
- review queue answering
- correct and incorrect evaluation states
- deck queue question details
- admin trace visibility

The suite uses a disposable `Browser Smoke` deck and deterministic local scoring.
It does not mutate the `Deep Learning` deck.

## Local Server

Run the app with smoke support enabled:

```bash
WAXON_ENABLE_BROWSER_SMOKE_SUPPORT=1 WAXON_BROWSER_SMOKE_EVALUATOR=1 pnpm dev
```

These flags only work in local development with local test auth enabled.

## Browser Plugin Invocation

From Codex with the installed Browser plugin and node REPL tool available:

```js
const { setupBrowserRuntime } = await import("/Users/tsilva/.codex/plugins/cache/openai-bundled/browser/26.602.40724/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
globalThis.browser = await agent.browsers.get("iab");
const { runWaxonBrowserSmoke } = await import("./scripts/browser-use-smoke.mjs");
const result = await runWaxonBrowserSmoke();
nodeRepl.write(JSON.stringify(result, null, 2));
```

## Stable Test Data

Setup endpoint:

```text
POST /api/test-support/browser-smoke
```

Deck:

```text
id: browser-smoke
name: Browser Smoke
slug: browser-smoke
```

Questions:

```text
Browser smoke correct card: what exact token proves this answer is correct?
Browser smoke incorrect card: what exact token is intentionally omitted?
```

Correct answer must include:

```text
browser-smoke-correct-token
```

Expected scores:

```text
correct: 10
incorrect: 2
```

## Lessons Learned

- Wait for content-specific text such as `Deep Learning` or `Browser Smoke`, not
  the generic deck shell; the shell can render before `/api/decks` finishes.
- The deck detail page uses the queue panel, so `.review-stage` is hidden on
  `/decks/:slug`; wait on queue/deck text instead.
- Browser runtime supports `domcontentloaded` reliably here; avoid `networkidle`.
- Use local deterministic scoring for browser smoke tests. OpenRouter-backed
  grading is useful for product behavior but is too slow, costly, and model-
  variable for CI-style local smoke assertions.
