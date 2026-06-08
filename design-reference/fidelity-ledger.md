# Waxon Design Fidelity Ledger

Reference image: `design-reference/waxon-approved-ui.png`

## Current Loop

- Typography mismatch: the implemented question text was rendering as Georgia, which made it heavier, wider, and less editorial than the approved design. Fixed by defining a Baskerville-first question font stack, lowering mobile weight to 400, and tightening question line-height.
- UI chrome font mismatch: the app depended on an `Inter` family name that may not exist locally, causing inconsistent fallback behavior. Fixed by switching the app chrome to a native Apple/SF-style sans stack.
- Verified computed desktop question font after fix: `Baskerville, "Libre Baskerville", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif`; `font-weight: 400`.
- Verified computed mobile question font after fix: same Baskerville-first stack; `font-weight: 400`.
- Question-row geometry mismatch: the implemented target icon and question text were too close together, which made the corrected serif still read unlike the design. Fixed by widening the desktop icon-to-question gap so the question begins at the same visual column as the approved desktop panel.
- Header alignment mismatch: the brand/title group was slightly too far right. Fixed by tightening desktop header horizontal padding.
- Header tab vertical alignment mismatch: the Review/Queue labels sat slightly high relative to the brand group. Fixed by nudging tab label content down while keeping the underline anchored to the header bottom.
- Desktop shell corner drift: child backgrounds were painting through the 28px app-frame radius. Fixed by clipping `.review-shell` content to its existing radius while preserving the square mobile shell.

## Remaining Comparison Notes

- The reference image is a composite showing both desktop and mobile states. The app implements the active viewport only, so desktop verification compares against the desktop panel in the composite and mobile verification compares against the mobile panel.
- The live app question content comes from the local review queue, so screenshots may show a shorter real question than the long example in the concept. The layout still supports long questions and formulas through the existing markdown/math renderer.
- Wide desktop drift: the app shell was allowed to expand past the approved desktop panel, making the UI feel sparse and unlike the reference. Fixed by constraining the desktop shell to 1200px and reducing outer page padding to the reference rhythm.
- Empty-state drift: the approved design has previous-answer rows, but reloads could show an empty placeholder. Fixed by rendering a reviewed historical answer when there is no current-session answer.
- Queue-tab drift: the approved reference labels the second review-shell tab "Queue". The current product direction intentionally relabels that route as "Decks" and uses it for deck CRUD plus review-rotation membership.
- Question provenance drift: the live review screen now adds a quiet mono deck-source line above the active question, using a muted deck icon plus deck name. This intentionally differs from the approved reference so users can see which deck produced the current question without turning it into a badge or card.
- Mobile containment fix: after adding the provenance line, the 390px mobile browser pass exposed clipped composer actions. The review question area, composer, and previous-answer panel are now capped to the mobile gutter width so the source line and action buttons stay inside the viewport.
- Merged review/learn flow: the inner Review/Learn segmented control has been removed from the review panel. Dry review now exposes a single "Keep learning" action in the resting state, preserving the approved single-surface review composition.
