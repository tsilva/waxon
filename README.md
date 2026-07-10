<div align="center">
  <img src="./public/brand/logo/logo-1024.png" alt="Waxon" width="512" />

  **Learn anything. Remember it.**
</div>

Waxon is a multi-user, chat-first LLM tutor. A learner describes a goal, and
Waxon turns it into an adaptive course that teaches one section at a time,
checks understanding, and advances when the learner is ready.

Every answered Learn question also becomes a free-text recall item in one
question bank. Review schedules those items around the point when the learner
is likely to forget them, so short daily sessions make knowledge durable.

## Product flow

- **Learn** builds a course outline, teaches through one continuous tutor
  conversation, and adapts to the learner's answers.
- **Review** grades typed recall answers and schedules the next review from the
  learner's performance.
- **Library** provides the unified question bank, with source and concept
  metadata.
- **Tags** organizes questions by concept.
- **Admin** exposes model traces, latency, token use, and cost for operators.

## Install

```bash
git clone https://github.com/tsilva/waxon.git
cd waxon
pnpm install
```

Create `.env` with the pooled Neon Postgres connection used by the app:

```bash
DATABASE_URL=your-pooled-neon-connection-string
```

For migrations, add Neon's direct connection string too:

```bash
DATABASE_URL_UNPOOLED=your-direct-neon-connection-string
```

Apply migrations before running Waxon against a new database:

```bash
pnpm db:migrate
```

Create `.env.local` with an OpenRouter-compatible API key:

```bash
OPENROUTER_API_KEY=your-api-key

# Optional model overrides
LLM_MODEL=google/gemini-3.5-flash
LLM_LEARN_MODEL=google/gemini-3.5-flash
LLM_EVALUATION_MODEL=google/gemini-3.5-flash
LLM_CONTEXT_WINDOW_TOKENS=1000000
```

`LLM_API_KEY` is accepted when `OPENROUTER_API_KEY` is not set. The model
variables are optional; generic chat, Learn, and answer evaluation currently
default to `google/gemini-3.5-flash`.

Start a development server on an available port:

```bash
pnpm dev --port auto
```

Open the URL printed by the command.

## Authentication

Production sign-in and sign-up use Clerk. Create a Clerk application and add
its keys to `.env.local`:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=your-clerk-publishable-key
CLERK_SECRET_KEY=your-clerk-secret-key
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
existing app user so their courses and questions remain visible. Otherwise it
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
- Migration authoring is intentionally SQL-first because the checked-in Drizzle
  snapshot lineage stops before the current custom migrations. Add the next SQL
  file and matching `drizzle/meta/_journal.json` entry together. Do not use
  `drizzle-kit generate` until the snapshot lineage has been rebuilt and
  verified against a scratch database.
- Questions are user-owned. `question_attempts` stores resolved answers and
  scores, while the question row stores current scheduling state.
- Review queue state and pending evaluations are kept in memory for the current
  server process.
- API routes use the Node.js runtime and are dynamic where request-time state is
  required.
- If no model API key is configured, model-backed operations return a clear
  configuration failure rather than silently producing model output.
- JavaScript dependency hardening is configured in `pnpm-workspace.yaml` and
  `.npmrc`.

## License

No license file or package license is currently included.
