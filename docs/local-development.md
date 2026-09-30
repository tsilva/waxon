# Local development

Run commands from the repository root. Use Node.js 22.5.0 or newer and pnpm 10.33.0, as declared in `package.json`.

## Configuration

The current local credential workflow uses the macOS `keyenv` CLI. It must be installed and configured before the README setup commands can run. `.keyenv.toml` declares these required credentials:

- `DATABASE_URL`: the pooled Neon/PostgreSQL connection used by application traffic.
- `DATABASE_URL_UNPOOLED`: the direct connection preferred by migrations and maintenance scripts.
- `OPENROUTER_API_KEY`: model evaluation and embedding requests.
- `CLERK_SECRET_KEY`: Clerk browser authentication.
- `SENTRY_AUTH_TOKEN`: Sentry build integration.

Store credentials through `keyenv set <name>` and follow its authorization procedure for this checkout. `keyenv doctor` checks configuration without reading Keychain. `keyenv run -- <command>` injects credentials into the child process. Do not put secrets in `.env` files.

The database must support the `vector` and `pg_trgm` extensions, which migrations create. Fresh databases use `keyenv run -- pnpm db:migrate`; databases already using the clean migration history use that same command for subsequent migrations.

Set the public Clerk application key as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in `.env.local`. Optional non-secret overrides may also remain there:

```dotenv
LLM_EVALUATION_MODEL=google/gemini-3.8-flash
WAXON_QUESTION_SEARCH_MODE=lexical
```

`LLM_API_KEY` is accepted when `OPENROUTER_API_KEY` is not set. MCP search defaults to lexical retrieval. Optional hybrid search combines lexical and prompt-embedding ranks, exposes a lexical fallback when embeddings are unavailable, and uses no server-side model reranker. Search embeddings remain advisory and are never required to add a question.

Development uses the configured Tiago test identity unless `NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH=1` is set. Production uses Clerk, and each learner's bank and learning records are isolated.

The build script applies migrations when `VERCEL_ENV` is `preview` or `production`, before building Next.js. Setting `WAXON_BACKFILL_SEMANTIC_TAGS=1` also runs the semantic-tag backfill after migrations.

## Legacy database reset

The [clean-break decision](./adr/0001-remove-legacy-source-data-with-a-clean-break.md) removes all legacy Waxon data instead of upgrading it. For an existing installation with the legacy schema, run this destructive replacement once before deploying a build with the clean baseline:

```bash
keyenv run -- pnpm db:reset -- --confirm-clean-break
```

The reset discards all Waxon data and migration metadata, installs the clean baseline and subsequent migrations, and records the matching Drizzle migration history. It removes Waxon's application schema, migration metadata, and named former Waxon tables in `public`; unrelated `public` objects and extensions remain.

All drops, migrations, and migration records commit atomically. An external dependency on a former Waxon object, or any migration failure, blocks and rolls back the entire reset for explicit operator resolution. There is no legacy-data upgrade path, and a successful reset cannot be undone.

## Verification

`pnpm test` runs the Node test suite. Database suites skip when their test URLs are unset. To run them, provision a disposable PostgreSQL database with pgvector and pg_trgm, then export its URL as `WAXON_TEST_DATABASE_URL`. Never point this variable at production or a bank you want to retain.

The following commands destroy Waxon data in that database. The guard requires a nonempty URL before any command runs:

```bash
: "${WAXON_TEST_DATABASE_URL:?Set this to a disposable test database}"
export DATABASE_URL="$WAXON_TEST_DATABASE_URL"
export DATABASE_URL_UNPOOLED="$WAXON_TEST_DATABASE_URL"
export APPLICATION_CONTRACT_TEST_DATABASE_URL="$WAXON_TEST_DATABASE_URL"
export QUESTION_SEARCH_TEST_DATABASE_URL="$WAXON_TEST_DATABASE_URL"
export TAGS_TEST_DATABASE_URL="$WAXON_TEST_DATABASE_URL"

pnpm db:reset -- --confirm-clean-break
pnpm test
pnpm lint
pnpm typecheck
pnpm security:check
pnpm db:generate
git diff --exit-code -- drizzle-v2
VERCEL_ENV=preview pnpm build
```

Use a dedicated shell for these exports. The database-backed tests assert the clean catalog; `db:generate` followed by the scoped diff check detects drift between the Drizzle declarations and migrations. The repository's [CI workflow](../.github/workflows/ci.yml) provisions a disposable pgvector/PostgreSQL service and runs its verification commands.

The [browser acceptance suite](../tests/browser-use-clean-break-journey.md) uses the native Codex Desktop in-app Browser, a disposable clean database, and development-only deterministic fixtures. It never calls a live model. Follow the suite's dedicated learner and server setup instructions before running it. Recorded clean-break results are in the [acceptance evidence](./issue-20-clean-break-evidence.md).

## Retrieval tools

Export the learner's ID as `WAXON_LEARNER_ID` before benchmarking.

```bash
pnpm question-search:evaluate  # inspect/score the 120-case retrieval fixture
: "${WAXON_LEARNER_ID:?Set this to the learner ID to benchmark}"
keyenv run -- pnpm question-search:benchmark -- --user-id="$WAXON_LEARNER_ID"
```

Library text search uses weighted full-text and trigram relevance. Related tags and tag-filtered questions use compatible embeddings plus whole-token or consecutive-phrase prompt matches; see the [semantic-tag decision](./adr/0005-retrieve-questions-through-semantic-tags.md) and [lexical-evidence decision](./adr/0006-augment-semantic-tags-with-lexical-evidence.md).

## Question quality experiment

The [experiment guide](./question-quality-experiment.md) covers full-bank runs, concurrency, resuming, and learner selection. For a two-question pilot and a local report:

```bash
keyenv run -- pnpm question-quality:experiment --limit 2
pnpm question-quality:report
```

Each question is independently answered by DeepSeek and graded by the production evaluator. Results stay under ignored `test-results/question-quality/`; the tools do not write learning history. Applying question flags requires `--apply-flags`.
