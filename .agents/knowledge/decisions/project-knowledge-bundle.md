---
type: Decision Record
title: Project knowledge bundle
description: Shared agent memory for Waxon lives in `.agents/knowledge/` and follows OKF v0.1 conventions.
resource: .agents/knowledge/
tags: [agents, knowledge, okf]
timestamp: 2026-06-13T17:26:41Z
status: verified
confidence: high
source:
  - user-request: "Start using agent-project-knowledge to keep track of the purpose of this project, its goals how the project works, etc."
  - file:AGENTS.md
---

# Decision

Waxon uses `.agents/knowledge/` as a repo-local shared project knowledge bundle for agents.

# Rationale

The user explicitly requested durable project memory because prior agents were losing the project purpose and restoring bugs after forgetting intended behavior. Keeping concise, evidence-backed knowledge in the repo gives future agents a stable starting point before editing code.

# Operating Rules

* At task start, read `.agents/knowledge/index.md` and any relevant concept files.
* During work, update knowledge only for durable discoveries that future agents should reuse.
* At task end, explicitly check whether new durable knowledge should be added or existing knowledge should be corrected, superseded, or removed.
* Store uncertain observations in `.agents/knowledge/inbox/` with `status: draft`.
* Promote notes only after verification through code, tests, docs, user confirmation, issues, commits, or other concrete evidence.
* Do not store secrets, credentials, chain-of-thought, private customer data, or large raw logs.

# Related Concepts

* [Project goal and product boundaries](/codebase/project-goal-and-boundaries.md)
* [Application architecture overview](/codebase/application-architecture-overview.md)
