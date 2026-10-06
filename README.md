<p align="center">
  <img src="./public/brand/logo/logo-1024.png" alt="Waxon" width="360" />
  <br />
  <!-- repo-tagline:start -->
  <strong>🧠 Build knowledge and keep it 🔁</strong>
  <!-- repo-tagline:end -->
</p>

<p align="center">
  <a href="https://github.com/tsilva/waxon/actions/workflows/ci.yml"><img src="https://github.com/tsilva/waxon/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="https://github.com/tsilva/waxon/blob/main/package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522.5.0-blue" alt="Node.js 22.5.0 or newer" /></a>
</p>

Waxon is a web app for learners who want to remember what they study. Add questions and answer standards to your private question bank, then practice answering from memory in your own words. Waxon evaluates each answer and schedules future reviews from your recall history.

Use **Library** to manage and find questions through text search and related subject tags. Open **Review** to practice due questions, read feedback, and correct an evaluation when needed. You can also authorize an agent to search and add questions through MCP.

## Install

Requires Node.js **22.5.0+**, **pnpm 10.33.0**, a PostgreSQL database with **pgvector** and **pg_trgm**, and the **Infisical** CLI with a human login. Configure database, OpenRouter, Clerk, and Sentry credentials before running the app; see the [local setup guide](./docs/local-development.md).

```bash
git clone https://github.com/tsilva/waxon.git
cd waxon
pnpm install --frozen-lockfile
infisical login --domain https://app.infisical.com
pnpm secrets:check
pnpm db:migrate:secrets
pnpm dev --port auto
```

Open the local URL printed by the server. Development uses the configured test learner by default; production sign-in uses Clerk.

For installations that still use the legacy schema, read the [destructive clean-break procedure](./docs/local-development.md#legacy-database-reset) before migrating or deploying.

## Commands

Run commands from the repository root. Default `pnpm dev` reads development credentials from Infisical. Use `pnpm build:secrets` for a local build. Maintenance commands can use `infisical run --env dev --path / -- pnpm <command>` after verifying this checkout’s project configuration.

```bash
pnpm dev --port auto  # start development on an available port
pnpm test            # run tests; database suites need test URLs
pnpm lint            # run ESLint
pnpm typecheck       # check TypeScript
pnpm build           # create a production build
pnpm start --port auto  # serve the production build
pnpm db:migrate      # apply database migrations
pnpm db:studio       # open Drizzle Studio
pnpm security:check  # check dependency sources and audit packages
```

See the [local setup guide](./docs/local-development.md#verification) for database-backed verification, browser acceptance, and retrieval tools. The [question quality experiment](./docs/question-quality-experiment.md) tests questions with model answers without writing learning history.

## MCP

In Library, open **Agent access**, create a personal token, and copy it immediately. Configure your MCP client with the remote Streamable HTTP endpoint and bearer header:

```text
https://<your-waxon-host>/api/mcp
Authorization: Bearer waxon_mcp_...
```

The tools are `search_questions`, pre-add `check_questions`, and `add_questions`. Access is limited to your private bank and uses the same validation and duplicate prevention as the app. Waxon stores only the token's SHA-256 hash; rotating it invalidates the previous value, and revoking it leaves browser sessions intact.

## Notes

- Questions contain a standalone prompt and answer standard. Editing creates a new question with reset mastery and archives the original with its history.
- Active questions enter Review; Flagged and Archived questions stay out until restored. New Active questions are due immediately, and missed questions return the same day.
- Tags describe subject matter. Relatedness is calculated from compatible embeddings and prompt matches; tags do not change review scheduling. Adding questions does not require embeddings or a model call.
- Review evaluates free-text answers through OpenRouter. Feedback explains what you got right and what needs work; evaluation corrections rebuild scheduling while preserving the original evidence.
- Application secrets live in Infisical `waxon`, Development `/`, and separately in `waxon-production`, Production `/`, automatically synced to Vercel Production. Redeploy after changes. Original `.keyenv.toml` references and Keychain entries remain available for verified migration/rollback. Keep only non-secret overrides in `.env.local`; configuration and deployment details are in the [setup guide](./docs/local-development.md#configuration).
- Built with Next.js, React, TypeScript, Drizzle, PostgreSQL, and FSRS scheduling. Admin provides model traces, latency, token use, and cost.
- No license is currently declared.
