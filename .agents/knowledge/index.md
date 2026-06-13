---
okf_version: "0.1"
---

# Waxon Project Knowledge

This is the shared, repo-local OKF knowledge bundle for agents working on Waxon. Read this index at the start of every task, then open only the concept files relevant to the work. At task end, explicitly check whether the work produced durable new knowledge or invalidated existing knowledge; if so, update this bundle before handing control back.

## Highest-Value Concepts

* [Project goal and product boundaries](/codebase/project-goal-and-boundaries.md) - Waxon's durable learning goal and constraints future changes must preserve.
* [Application architecture overview](/codebase/application-architecture-overview.md) - High-level Next.js, database, auth, queue, and LLM grading flow.
* [Local development runbook](/runbooks/local-development.md) - Setup, environment variables, commands, and dev-server behavior.
* [Project knowledge bundle decision](/decisions/project-knowledge-bundle.md) - Decision to keep shared agent memory in `.agents/knowledge/`.

## Directories

* [Codebase](/codebase/) - Verified architecture notes, module boundaries, and behavioral constraints.
* [Decisions](/decisions/) - Decision records and rationale that should guide future work.
* [Runbooks](/runbooks/) - Repeated setup, test, debugging, and operational workflows.
* [Experiments](/experiments/) - Experiment records and results when they become useful.
* [Data](/data/) - Schemas, datasets, metrics, and data contracts.
* [References](/references/) - Summarized or mirrored source references.
* [Inbox](/inbox/) - Draft or uncertain notes awaiting verification.

## Maintenance Rules

Add or update knowledge only when it is durable, evidence-backed, and useful to future agents. Prefer updating existing concepts over creating duplicates. At the end of every task, review whether any relevant concept, directory index, or `log.md` entry needs to change. Put uncertain notes in `inbox/` with `status: draft`, then promote them after verification. Do not store secrets, credentials, chain-of-thought, private customer data, or large raw logs.
