<div align="center">
  <img src="./public/brand/logo/logo-1024.png" alt="Waxon" width="512" />

  **Build knowledge. Keep it.**
</div>

Waxon is a multi-user library with adaptive Review. Learners add standalone Questions, answer from memory in their own words, and let Answer Grade history schedule each Question near the point where recall is likely to fade. Authorized MCP Clients can add and search Questions in one Learner's private Library.

## Product loop

- **Library** adds, searches, replaces, flags, archives, restores, and unflags Questions.
- **Review** derives a live due-first queue, evaluates free-text recall, accepts Answer Grade corrections, and updates per-Question scheduling state.
- **MCP** exposes the same isolated question service through `search_questions`, pre-add `check_questions`, and transactional `add_questions` tools.
- **Admin** retains model traces, latency, token use, and cost for operators.

Waxon stores standalone Questions and immutable Learning Evidence. Optional prompt-only embeddings improve advisory MCP search but are never required to add a Question.

## Install and run

```bash
git clone https://github.com/tsilva/waxon.git
cd waxon
pnpm install
keyenv doctor
keyenv run -- pnpm db:migrate
keyenv run -- pnpm dev --port auto
```

`db:migrate` expects the clean migration history. For an existing installation,
the issue #19 clean break intentionally discards all Waxon data and migration
metadata before applying the baseline:

```bash
keyenv run -- pnpm db:reset -- --confirm-clean-break
```

Run that destructive replacement once before deploying a build that contains
the clean baseline. The reset removes Waxon's application schema, migration
metadata, and named former Waxon tables in `public`; unrelated `public` objects
and extensions remain. The destructive drops, clean-baseline installation, and
matching Drizzle migration record commit atomically. An external dependency on
a former Waxon object, or any baseline installation failure, blocks and rolls
back the entire reset for explicit operator resolution. The reset has no
legacy-data upgrade path and cannot be undone after a successful commit.

Secrets declared in `.keyenv.toml`—including Neon, OpenRouter, Clerk, and Sentry credentials—remain in macOS Keychain and are injected by `keyenv run -- ...`. Do not put them in `.env` files. Application traffic uses Neon's pooled `DATABASE_URL`; migrations and maintenance scripts use `DATABASE_URL_UNPOOLED` when available.

Optional non-secret model overrides may remain in `.env.local`:

```bash
LLM_EVALUATION_MODEL=google/gemini-3.8-flash
WAXON_QUESTION_SEARCH_MODE=lexical
```

`LLM_API_KEY` is accepted when `OPENROUTER_API_KEY` is not set.

## Authentication and MCP

Production browser authentication uses Clerk and all Library and learning records are user-owned. Local development uses the configured TCLV/Tiago test identity unless `NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH=1` is set.

In the Library, open **Agent access**, create a personal token, and copy it immediately. Waxon stores only its SHA-256 hash. Configure the remote Streamable HTTP endpoint as:

```text
https://<your-waxon-host>/api/mcp
Authorization: Bearer waxon_mcp_...
```

Rotating the token invalidates the previous value; revocation disables MCP access without affecting browser sessions.

## Commands

```bash
pnpm dev --port auto  # start development on an available port
pnpm test             # run the Node test suite
pnpm lint             # run ESLint
pnpm typecheck        # check TypeScript
pnpm build            # create a production build
pnpm db:migrate       # create or verify the clean database baseline
pnpm db:reset -- --confirm-clean-break  # discard Waxon data and recreate the baseline
pnpm db:studio        # open Drizzle Studio
pnpm question-search:evaluate  # inspect/score the 120-case retrieval fixture
pnpm question-search:benchmark -- --user-id=<id>  # measure a learner's Library
```

The complete clean-break product suite lives in [`tests/browser-use-clean-break-journey.md`](./tests/browser-use-clean-break-journey.md). It uses the native Codex Desktop in-app Browser, a disposable clean database baseline, and development-only deterministic fixtures; it never calls a live model.

For a clean acceptance baseline, point both database variables at the same disposable pgvector/Postgres database and run:

```bash
DATABASE_URL="$ISSUE20_DATABASE_URL" DATABASE_URL_UNPOOLED="$ISSUE20_DATABASE_URL" pnpm db:reset -- --confirm-clean-break
APPLICATION_CONTRACT_TEST_DATABASE_URL="$ISSUE20_DATABASE_URL" QUESTION_SEARCH_TEST_DATABASE_URL="$ISSUE20_DATABASE_URL" DATABASE_URL="$ISSUE20_DATABASE_URL" DATABASE_URL_UNPOOLED="$ISSUE20_DATABASE_URL" pnpm test
DATABASE_URL="$ISSUE20_DATABASE_URL" DATABASE_URL_UNPOOLED="$ISSUE20_DATABASE_URL" pnpm db:generate
git diff --exit-code -- drizzle-v2
VERCEL_ENV=preview DATABASE_URL="$ISSUE20_DATABASE_URL" DATABASE_URL_UNPOOLED="$ISSUE20_DATABASE_URL" pnpm build
```

`ISSUE20_DATABASE_URL` must never identify production. The exact clean catalog is asserted by the database-backed tests; `db:generate` followed by the scoped diff check proves the Drizzle declaration and baseline have not drifted.

## Implementation notes

- Schema declarations live in `app/db/v2/schema.ts`; the clean baseline lives in `drizzle-v2/`.
- Questions are immutable; Learner Answers, evaluations, and Answer Grade events remain immutable Learning Evidence, while scheduling state is derived from effective grades.
- Every Learner Answer follows the same free-text evaluation workflow.
- MCP batches share Library validation, duplicate detection, limits, idempotency receipts, transactions, and user isolation.
- Library uses weighted full-text plus trigram relevance. MCP can add one compact prompt embedding and RRF, with a visible lexical fallback and no server-side LLM reranker.
- JavaScript dependency hardening is configured in `pnpm-workspace.yaml` and `.npmrc`.

## License

No license file or package license is currently included.
