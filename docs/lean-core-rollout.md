# Lean Core rollout

Waxon’s destructive cleanup has two explicit stages.

## Before Stage One

1. Run `keyenv run -- pnpm lean:preflight` and save its JSON output outside the repository.
2. Create a restorable production database backup.
3. Record the counts for questions, question versions, answer submissions, grade events, and memory states.

## Stage One

Deploy the application and normal `drizzle-v2` migrations. Stage One adds MCP credentials and evaluation traces, maps obsolete lifecycle values, cancels retired jobs, and leaves all source tables and uploaded objects in place. It does not alter review memory or learning history.

Verify the full journey: add, search, edit, review, evaluate, correct a grade, complete a delayed retry, and observe future scheduling. Re-run the preflight and compare retained counts with the baseline.

## Stage Two

Review `blobInventory` from the preflight output. Delete only the listed objects through the storage provider, then run [`lean-core-stage-two.sql`](./lean-core-stage-two.sql). Re-run the retained counts and the Review journey after cleanup.

Do not fold Stage Two into the normal migration command: its purpose is to create a deliberate verification boundary before source data is erased.
