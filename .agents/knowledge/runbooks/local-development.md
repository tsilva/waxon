---
type: Runbook
title: Local development
description: Waxon local setup uses pnpm, Next.js, Neon Postgres, optional Clerk keys, and OpenRouter-compatible LLM keys.
resource: README.md
tags: [setup, development, pnpm, nextjs, database]
timestamp: 2026-06-13T17:26:41Z
status: verified
confidence: high
source:
  - file:README.md
  - file:package.json
  - file:scripts/next-server.mjs
  - file:pnpm-workspace.yaml
  - file:.npmrc
---

# Local Development

Install dependencies with `pnpm install`. The project package manager is `pnpm@10.33.0`, and Node must be `>=22.5.0`.

When starting the dev server as an agent, follow the repo instruction to avoid fixed ports:

```bash
pnpm dev --port auto
```

The wrapper in `scripts/next-server.mjs` converts `--port auto` or `--port=auto` into a random available port and prints the selected port. With pnpm 10, do not add an extra `--`; `pnpm dev -- --port auto` can pass `--port` through as a positional directory to Next.

# Environment

Database storage uses Neon Postgres through Drizzle.

Required for database-backed app behavior:

```bash
DATABASE_URL=your-pooled-neon-connection-string
```

Preferred for migrations:

```bash
DATABASE_URL_UNPOOLED=your-direct-neon-connection-string
```

Required for LLM grading:

```bash
OPENROUTER_API_KEY=your-api-key
LLM_MODEL=google/gemini-3.5-flash
```

`LLM_MODEL` is optional. The app also accepts `LLM_API_KEY` if `OPENROUTER_API_KEY` is not set.

For deployed auth, configure Clerk:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your-clerk-publishable-key
CLERK_SECRET_KEY=your-clerk-secret-key
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
```

Local development login and signup buttons automatically enter the app as a test user unless `NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH=1` is set.

# Commands

```bash
pnpm dev --port auto
pnpm build
pnpm db:generate
pnpm db:migrate
pnpm db:studio
pnpm start
pnpm lint
pnpm typecheck
pnpm test
```

# Supply Chain Notes

Dependency hardening is enabled in both `pnpm-workspace.yaml` and `.npmrc`:

* `minimumReleaseAge: 10080`
* `blockExoticSubdeps: true`
* `minimum-release-age=10080`
* `block-exotic-subdeps=true`

# Citations

* `README.md` install, environment, commands, and notes.
* `package.json` package manager, engines, scripts, and dependencies.
* `scripts/next-server.mjs` automatic port behavior.
* `pnpm-workspace.yaml` and `.npmrc` supply-chain hardening.
