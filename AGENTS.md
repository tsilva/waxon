# Repository Instructions

## Project Goal

Do not change this section unless the user explicitly asks to update the project goal.

This project is an app for building and retaining knowledge through adaptive question-and-answer practice. Users create or generate a library, answer from memory in their own words, and rely on Review to decide what to practice and when.

Every question is stored and resurfaced later based on the user's past performance. Once a user answers a question correctly, the app should help make that knowledge durable: if the user returns daily and completes their exercises, the system should schedule reviews near the point where mastery is likely to fade. This lets users maintain a large body of knowledge through short sessions focused on the questions most at risk of being forgotten.

## Product Specifications

Before every task in this repository, use the `$specs-author` skill to read the entire root `SPECS.md`. Before finishing, reread it and check the task and conversation for new or changed stakeholder intent.

- Treat `SPECS.md` as the persistent source of stakeholder requirements that cannot be inferred reliably from code or remembered conversations.
- Apply the scope test to proposed and existing requirements: root `SPECS.md` contains only project-wide intent; scoped intent belongs in its nearest authoritative specification and must not be broadened to fit the root.
- If the task, repository, or user request contradicts, omits, or ambiguously interprets the specification, tell the user. Continue safe exploration and work that does not depend on resolving the issue, but never silently choose an interpretation.
- Never edit `SPECS.md` from inference. Propose the exact change, explain why it reflects stakeholder intent, and edit the file only after the user explicitly approves that exact change.
- Keep `SPECS.md` complete, concise, and compacted. It must contain stakeholder intent rather than implementation, architecture, operations, or transient project detail.

## Superset Provider Lock

- Use only Codex for Superset workers unless the user explicitly authorizes another provider.
- Never substitute Claude, Copilot, OpenCode, or another agent when Codex fails, is unavailable, or requires authentication. Stop and ask the user.
- Use two-stage dispatch: launch a no-write identity preflight, verify that the terminal is running Codex, and only then send the implementation task.
- Tell the user which provider was verified before implementation begins.
- For a Superset implementation of a GitHub issue, finish by pushing the worker branch and opening a pull request unless the user explicitly requests local-only work or full shipping.
- Leave the pull request unmerged until the user explicitly approves the merge, and close the issue through the merged pull request rather than before integration.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `tsilva/waxon`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels defined in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Questions

When creating, cleaning up, deduplicating, or generating knowledge-base questions and probing questions, use the shared question-quality reference in [reference/question-quality.md](reference/question-quality.md).

## UI Design

When making design, styling, layout, responsive UI, visual polish, or frontend interaction changes, use the repo design-system reference in [design-reference/design-system.md](design-reference/design-system.md). For visual fidelity work, compare against [design-reference/waxon-approved-ui.png](design-reference/waxon-approved-ui.png) and update [design-reference/fidelity-ledger.md](design-reference/fidelity-ledger.md) when the comparison changes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
