---
name: waxon-issue-threading
description: Use before any Waxon fix or behavior-changing edit, especially behavior regressions, product-flow issues, Learn/auth/deploy/UI bugs, or changes where user-stated specs or the overarching product objective could be lost. Reads SPECS.md and keeps the objective, failure, causal hypothesis, non-goals, and proof path aligned before editing.
---

# Waxon Issue Threading

Use this skill to keep Waxon fixes attached to the real product objective.

## Pre-Edit Checklist

1. Read `AGENTS.md`, `SPECS.md`, and any task-specific reference or skill they point to before any fix or behavior-changing edit.
2. Capture branch and dirty files. Preserve unrelated user changes.
3. Pin the issue thread before editing:
   - `Objective`: user-visible outcome to restore or improve.
   - `Required specs`: relevant `SPECS.md` contracts that must not regress.
   - `Failure evidence`: exact behavior, route, trace, error, screenshot, or metric proving the problem.
   - `Causal hypothesis`: why the suspected code path explains the failure.
   - `Non-goals`: tempting nearby cleanup or refactors to avoid.
   - `Proof path`: browser flow, endpoint, trace, test, deploy check, or metric that will prove the objective.
4. If the causal hypothesis is speculative, gather stronger evidence before editing.
5. Make the smallest reversible change that satisfies the objective and preserves the required specs.
6. Verify the proof path. For browser checks, use the native Codex Desktop in-app Browser per `AGENTS.md`.
7. Update `SPECS.md` when the user states a durable new spec or the fix reveals a durable product requirement. Keep it compact.

## Reporting

Finish with:

- Objective addressed.
- Files changed.
- Proof run and result.
- `SPECS.md` update made, or `none`.
- Remaining risk or follow-up, if any.
