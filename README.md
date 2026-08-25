<div align="center">
  <img src="./public/brand/logo/logo-1024.png" alt="Waxon" width="512" />

  **Build knowledge. Keep it.**
</div>

Waxon is a multi-user question bank with adaptive daily Review. Learners add standalone questions, answer from memory in their own words, and let FSRS schedule the questions most at risk of being forgotten. Authorized agents can add and search questions through MCP.

## Product loop

- **Library** adds, searches, edits, pauses, archives, restores, and logically removes questions.
- **Review** builds a bounded due-first daily plan, evaluates free-text recall, accepts learner grade corrections, and updates per-question memory.
- **MCP** exposes the same isolated question service through `search_questions`, pre-add `check_questions`, and transactional `add_questions` tools.
- **Admin** retains model traces, latency, token use, and cost for operators.

Waxon does not ingest documents or URLs, retain source provenance, generate questions in-app, or organize concepts. Optional prompt-only embeddings improve MCP search but are never required to add a question.

## Install and run

```bash
git clone https://github.com/tsilva/waxon.git
cd waxon
pnpm install
keyenv doctor
keyenv run -- pnpm db:migrate
keyenv run -- pnpm dev --port auto
```

Secrets declared in `.keyenv.toml`—including Neon, OpenRouter, Clerk, and Sentry credentials—remain in macOS Keychain and are injected by `keyenv run -- ...`. Do not put them in `.env` files. Application traffic uses Neon's pooled `DATABASE_URL`; migrations and maintenance scripts use `DATABASE_URL_UNPOOLED` when available.

Optional non-secret model overrides may remain in `.env.local`:

```bash
LLM_EVALUATION_MODEL=google/gemini-3.7-flash
WAXON_QUESTION_SEARCH_MODE=lexical
```

`LLM_API_KEY` is accepted when `OPENROUTER_API_KEY` is not set.

## Authentication and MCP

Production browser authentication uses Clerk and all bank and learning records are user-owned. Local development uses the configured TCLV/Tiago test identity unless `NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH=1` is set.

In Library, open **Agent access**, create a personal token, and copy it immediately. Waxon stores only its SHA-256 hash. Configure the remote Streamable HTTP endpoint as:

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
pnpm db:migrate       # apply normal Stage One migrations
pnpm db:compare       # compare exact row counts, foreign keys, and sequences
pnpm db:studio        # open Drizzle Studio
pnpm lean:preflight   # print retained counts and the blob cleanup inventory
pnpm question-search:backfill  # dry-run the repairable embedding backfill
pnpm question-search:evaluate  # inspect/score the 120-case retrieval fixture
pnpm question-search:benchmark -- --user-id=<id>  # measure a learner bank
```

The preservation-first two-stage cleanup is documented in [`docs/lean-core-rollout.md`](./docs/lean-core-rollout.md). Do not run its Stage Two SQL until the Stage One deployment, retained-count comparison, Review journey, and blob inventory have been reviewed.

The repeatable local product suite lives in [`docs/browser-use-smoke.md`](./docs/browser-use-smoke.md) and uses the native Codex in-app Browser plus a development-only deterministic evaluator.

Question-search rollout, backfill, evaluation, and latency gates are documented in [`docs/question-search-rollout.md`](./docs/question-search-rollout.md).

## Implementation notes

- Lean schema declarations live in `app/db/v2/schema.ts`; reviewed Stage One migrations live in `drizzle-v2/`.
- Question versions, submissions, evaluations, grade events, and memory states are append-only or rebuilt from immutable evidence as appropriate.
- Exact answers are graded deterministically. Semantic and rubric answers are evaluated through the durable evaluation workflow.
- MCP batches share Library validation, duplicate detection, limits, idempotency receipts, transactions, and user isolation.
- Library uses weighted full-text plus trigram relevance. MCP can add one compact prompt embedding and RRF, with a visible lexical fallback and no server-side LLM reranker.
- JavaScript dependency hardening is configured in `pnpm-workspace.yaml` and `.npmrc`.

## License

No license file or package license is currently included.
