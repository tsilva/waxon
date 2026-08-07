<div align="center">
  <img src="./public/brand/logo/logo-1024.png" alt="Waxon" width="512" />

  **Build knowledge. Keep it.**
</div>

Waxon is a multi-user question bank and adaptive review system. Learners answer
in their own words, get concise model feedback, and rely on Review to schedule
the next recall attempt from past performance.

## Product flow

- **Review** grades typed recall answers and schedules the next review from the
  learner's performance.
- **Library** provides the unified question bank, with source and concept
  metadata, concept-tag organization, and bank-management tools.
- **Admin** exposes model traces, latency, token use, and cost for operators.

## Install

```bash
git clone https://github.com/tsilva/waxon.git
cd waxon
pnpm install
keyenv doctor
```

Private values declared in `.keyenv.toml`, including the pooled Neon connection,
OpenRouter key, Clerk secret, Blob token, and Sentry token, live in macOS
Keychain. Launch commands through `keyenv run -- ...`; Node reads the injected
values normally from `process.env`.

If migrations require a separate `DATABASE_URL_UNPOOLED`, declare it in
`.keyenv.toml` and store it with `keyenv set DATABASE_URL_UNPOOLED`; do not put
it in `.env`.

Apply migrations before running Waxon against a new database:

```bash
keyenv run -- pnpm db:migrate
```

Non-secret model overrides may remain in `.env.local`:

```bash
LLM_MODEL=google/gemini-3.6-flash
LLM_EVALUATION_MODEL=google/gemini-3.6-flash
```

`LLM_API_KEY` is accepted when `OPENROUTER_API_KEY` is not set. The model
variables are optional; generic chat and answer evaluation currently
default to `google/gemini-3.6-flash`.

Start a development server on an available port:

```bash
keyenv run -- pnpm dev --port auto
```

For linked Vercel development environments, use no-file injection:

```bash
vercel env run -e development -- keyenv run -- pnpm dev --port auto
```

Open the URL printed by the command.

## Authentication

Production sign-in and sign-up use Clerk. Keep only its public client settings
in `.env.local`; `CLERK_SECRET_KEY` is supplied by `keyenv` locally and by the
deployment provider in hosted environments:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your-clerk-publishable-key
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
```

Local development uses the TCLV/Tiago test identity so product flows can be
tested without a Clerk browser session:

```text
Tiago Silva
eng.tiago.silva@gmail.com
```

When that email already exists in the configured database, Waxon reuses the
existing app user so their questions remain visible. Otherwise it
creates a local fallback user. To exercise the real Clerk flow locally, disable
the local test identity:

```bash
NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH=1
```

## Commands

```bash
pnpm dev --port auto     # start development on an available port
pnpm build               # create a production build
pnpm start --port auto   # run the production build on an available port
pnpm test                # run the Node test suite
pnpm lint                # run ESLint
pnpm typecheck           # run TypeScript without emitting files
pnpm db:migrate          # apply pending migrations
pnpm db:studio           # open Drizzle Studio
```

The repeatable local product smoke flow lives in
[`docs/browser-use-smoke.md`](./docs/browser-use-smoke.md). It uses the current
Codex in-app Browser and a development-only deterministic evaluator.

## Implementation notes

- Postgres schema declarations live in `app/db/schema.ts`; reviewed SQL
  migrations and their ordered journal live in `drizzle/`.
- Drizzle's schema snapshot baseline was restored at migration `0033`. Use
  `drizzle-kit generate` for schema changes, then review generated SQL and keep
  data-only or extension-specific SQL explicit in the migration file.
- Questions are user-owned. `question_attempts` stores resolved answers and
  scores, while the question row stores current scheduling state.
- Pending and resolved answer-evaluation status is persisted in
  `answer_evaluations`; model work begins after the submit response.
- API routes use the Node.js runtime and are dynamic where request-time state is
  required.
- If no model API key is configured, model-backed operations return a clear
  configuration failure rather than silently producing model output.
- JavaScript dependency hardening is configured in `pnpm-workspace.yaml` and
  `.npmrc`.

## License

No license file or package license is currently included.
