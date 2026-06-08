# Learn CLI Hiragana Scratch Test

Use this runbook to verify Learn mode from a fresh Hiragana deck.

## Prerequisites

- `.env.local` has `OPENROUTER_API_KEY` and `LLM_MODEL` set.
- The database migrations are applied.
- You are running commands from the repository root.

## 1. Start the App

In one terminal:

```bash
npm run dev -- -p 3009
```

Wait until Next.js prints that it is ready.

## 2. Run a Fresh Hiragana Deck

In another terminal:

```bash
python3 scripts/learn-cli.py \
  --base-url http://127.0.0.1:3009 \
  --deck-name "Manual Hiragana Scratch" \
  --coverage "Learn the basic Japanese hiragana gojuon characters and their standard Hepburn romanizations" \
  --reset-deck \
  --auto-answer \
  --max-answers 120
```

This creates a new deck unless one with the same name already exists. If it exists, `--reset-deck` archives the old deck and creates a fresh one.

## Expected Result

The run should end naturally before the `--max-answers` guardrail:

```text
[learn] added=0 rejected=0 done=true
No question is ready. The deck may be fully covered.
[done] no ready question remains
```

The exact `rejected` count may differ near the final cards. The important checks are:

- The CLI ends with `done=true`.
- It prints `[done] no ready question remains`.
- It does not stop with `[done] stopped after 120 answers`.
- Early cards appear in gojuon order, starting with `あ`, `い`, `う`, `え`, `お`.
- The deck does not drift into example words, particle readings, long-vowel rules, or romanization-system comparisons.

## Manual Answer Variant

To type answers yourself, remove `--auto-answer`:

```bash
python3 scripts/learn-cli.py \
  --base-url http://127.0.0.1:3009 \
  --deck-name "Manual Hiragana Scratch" \
  --coverage "Learn the basic Japanese hiragana gojuon characters and their standard Hepburn romanizations" \
  --reset-deck \
  --max-answers 120
```

Example answers:

```text
あ -> a
い -> i
う -> u
え -> e
お -> o
か -> ka
し -> shi
ち -> chi
つ -> tsu
ん -> n
```

## Troubleshooting

If the CLI reports a `429` rate limit, wait for the rate-limit window or restart the local dev server. The validation CLI submits many answers quickly.

If the run hits `--max-answers`, treat it as a failure. Inspect the generated questions for curriculum drift or duplicate-heavy loops.

If the app cannot be reached, confirm the dev server is still running on port `3009`.
