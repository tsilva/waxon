# Browser Use Test Suite: Signed-In User Experience

Use this suite with the official OpenAI Browser Use plugin and Codex agent to test Waxon from the user's point of view. Prefer visible UI interactions and assertions over direct API calls or DOM implementation details.

## Scope

Covered:

- Signed-in app entry.
- Review shell navigation.
- Answering a card and viewing feedback.
- Previous answer details and question stats.
- Deck list browsing, search, sort, creation, rename, and review-rotation toggle.
- Deck detail view, queue sorting, and non-destructive question generation.
- Account menu, local profile dialog, and sign out.

Not covered:

- Deletion or destructive cases.
- Do not click buttons or menu items labeled `Archive`, `Delete`, or `Remove`.
- Do not clean up created decks or generated questions during this suite.

## Preconditions

1. Start the app from the repository root:

   ```bash
   pnpm dev
   ```

2. Open `http://localhost:3000`.
3. Prefer local development auth. In local dev, Waxon signs in as the test user when `NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH` is unset.
4. If real Clerk auth is enabled instead, use the available test credentials from the test environment. Do not create a personal account during this suite.
5. Use a unique suffix for created data, for example `Browser QA 2026-06-05 1530`.

## General Pass Criteria

- The app never shows an unhandled error page.
- Interactive controls visibly respond to clicks, typing, and navigation.
- Loading states resolve or provide a clear user-facing failure message.
- Navigation preserves the signed-in shell unless the test explicitly signs out.
- Created or edited names appear in the UI without requiring manual API calls.
- No deletion, archive, or remove action is exercised.

## Test 1: Signed-In Entry From Landing Page

Steps:

1. Open `/`.
2. Verify the landing page shows the `waxon` brand and primary entry actions.
3. Click `Sign in` if local auth is shown. If already signed in, click `Open app`.
4. Verify the app lands on `/review`.

Expected:

- The signed-in shell is visible.
- Header includes `waxon`, `Review`, `Decks`, a due-count summary, and a user-menu button.
- The app does not show Clerk sign-in UI when local test auth is active.

## Test 2: Account Menu and Profile

Steps:

1. From `/review`, open the user menu.
2. Verify the menu shows the signed-in user's name and email.
3. Click `Manage accounts`.
4. If local auth is active, verify the `Profile` dialog opens.
5. Verify the profile shows `Name`, `Email`, and an `Upload avatar` action.
6. Close the settings/profile dialog.

Expected:

- Local auth displays `Tiago Silva` and `eng.tiago.silva@gmail.com`.
- Profile details are readable.
- Closing the dialog returns to the review shell without navigation loss.
- Do not click `Remove`.

## Test 3: Review Page Resting or Due State

Steps:

1. Open `/review`.
2. Wait for `Loading next question...` to resolve.
3. If a due question appears, verify the page shows the deck source when available, the question, the `Your answer` textbox, voice-answer button, submit button, and `Previous answers`.
4. If no question is due, verify the resting state shows `Review complete`, `You're caught up.`, `View queue`, and `Refresh`.
5. In the resting state, click `View queue` and verify the app switches to the deck/queue area.

Expected:

- Due and resting states are both understandable from the UI.
- The user is not stranded in a permanent loading state.
- The visible due count is consistent with the state: due cards show review controls; zero due can show the caught-up state.

## Test 4: Submit an Answer

Run this test only when a due question is available. If no due question is available, record it as skipped.

Steps:

1. Copy or note the visible question text.
2. Type this answer into `Your answer`: `Browser QA answer: this is a concise test response from the signed-in user flow.`
3. Click the submit button.
4. Verify the answer is accepted and appears in `Previous answers`.
5. Wait for the row to show either a pending evaluation phase or a resolved score/feedback.
6. If another question appears, verify the answer textbox is cleared for the next card.

Expected:

- The submitted answer is visible in the user's history.
- While grading, the UI communicates progress such as queued/evaluating/saving.
- When grading resolves, a score and feedback are visible.
- If the app is missing an LLM key, a user-facing evaluation/configuration message is acceptable; an unhandled crash is not.

## Test 5: Previous Answer Details and Question Stats

Run this test when at least one previous answer row is visible.

Steps:

1. Click a previous answer row.
2. Verify the expanded row shows `Question`, `Answer`, and `Evaluation`.
3. Click `More details`.
4. Verify a question stats dialog opens.
5. Check for `Attempts`, `Average`, `Best`, `Last`, `Next due`, `Pending`, `Previous scores`, and `Answer history`.
6. Click `Generate answer` only if no LLM answer is already shown and the environment is expected to support LLM calls.
7. Close the stats dialog.

Expected:

- Expanding a previous answer is reversible and does not navigate away.
- The stats dialog is readable and tied to the selected question.
- Reference-answer generation either returns content or shows a clear unavailable message.

## Test 6: Deck List Navigation, Search, and Sort

Steps:

1. Open `/decks`.
2. Verify the `Decks` tab is selected.
3. Wait for decks to load.
4. Verify the page shows `Create deck`, `Search decks`, `Sort decks`, and the deck summary strip.
5. Change the deck sort to `Name`, then to `Due count`, then back to `Updated`.
6. Type a known visible deck name, such as `Deep Learning`, into `Search decks`.
7. Verify matching decks remain and nonmatching decks are hidden.
8. Clear the search field.

Expected:

- The deck list remains usable through sort and search changes.
- Empty search results show `No matching decks.` instead of a broken list.
- The summary strip remains visible.

## Test 7: Create and Rename a Deck

Steps:

1. On `/decks`, click `Create deck`.
2. Verify the `New deck` dialog opens.
3. Enter a unique deck name such as `Browser QA 2026-06-05 1530`.
4. Click `Save`.
5. Verify the new deck appears in the deck list.
6. Click the edit button for the new deck.
7. Rename it to the same name with ` Renamed` appended.
8. Click `Save`.
9. Verify the renamed deck appears in the list and can be found by search.

Expected:

- Deck creation and rename complete without page reload errors.
- Duplicate-name or invalid-name errors, if encountered, are shown inline in the dialog.
- Do not click the deck `Archive` button.

## Test 8: Review Rotation Toggle

Steps:

1. On `/decks`, choose a non-critical test deck if one exists, preferably the deck created in Test 7.
2. Click its review-rotation toggle once.
3. Verify the toggle changes visual state and `aria-pressed` semantics from the user's perspective if available to the Browser Use agent.
4. Click the same toggle a second time to restore the prior state.

Expected:

- The toggle state changes promptly.
- The deck summary count for `in rotation` updates if the toggled deck affects it.
- No archive or deletion action is used.

## Test 9: Deck Detail and Card Stats

Steps:

1. Open an existing deck from the deck list, preferably `Deep Learning` if present.
2. Verify the deck detail page shows the deck name, `Generate`, `Sort queue`, and either queue cards or `No active cards.`
3. Change queue sort from `Review date` to `Creation date`.
4. If a card row is present, click the card.
5. Verify the question stats dialog opens and shows summary metrics.
6. Close the stats dialog.
7. Navigate back to `/decks`.

Expected:

- The deck detail view is reachable from the deck list.
- Queue sort does not break card rendering.
- Card stats are accessible from a card row.

## Test 10: Non-Destructive Question Generation

Run this test only on a test deck created for this suite or another deck explicitly designated for QA.

Steps:

1. Open the QA deck detail page.
2. Click `Generate`.
3. Verify the `Generate questions` dialog opens at `Step 1 of 2`.
4. Enter this cover text: `Core ideas for a browser QA deck: retrieval practice, spaced repetition, and concise feedback.`
5. Set the question count to a small value, preferably `1` or `2`.
6. Click `Generate`.
7. If generation succeeds, verify the dialog advances to `Review questions`.
8. Select one generated question with the plus/status control.
9. Click `Add to Deck`.
10. Verify the dialog reports the add result or the deck queue/card count updates after closing.

Expected:

- Without an LLM key, the user sees a clear generation error and the dialog remains usable.
- With an LLM key, generated questions can be reviewed before adding.
- Adding selected questions is explicit and non-destructive.
- Do not remove generated items or archive the deck afterward.

## Test 11: Direct Route and Refresh Persistence

Steps:

1. Navigate directly to `/review`.
2. Refresh the browser page.
3. Verify the signed-in review shell returns.
4. Navigate directly to `/decks`.
5. Refresh the browser page.
6. Verify the signed-in deck list returns.
7. If a deck detail URL is available, open it directly and refresh.

Expected:

- Signed-in app routes survive refresh.
- The shell does not revert to logged-out landing UI while local test auth is active.
- Loading states resolve after refresh.

## Test 12: Sign Out

Steps:

1. Open the user menu.
2. Click `Sign out`.
3. Verify the browser returns to `/`.
4. Verify the landing page is visible.
5. In local auth, verify clicking `Sign in` can re-enter `/review`.

Expected:

- Sign out returns the user to the public landing page.
- Re-entry works in local test auth.
- No user data is deleted.

## Reporting Template

For each test, report:

- Result: `pass`, `fail`, or `skipped`.
- Route tested.
- Key visible assertions.
- Any console errors, network failures, or user-visible error messages.
- Screenshots for failures or ambiguous UI states.
