# Waxon Design Fidelity Ledger

Reference image: `design-reference/waxon-approved-ui.png`

## Current Loop

- Typography mismatch: the implemented question text was rendering as Georgia, which made it heavier, wider, and less editorial than the approved design. Fixed by defining a Baskerville-first question font stack, lowering mobile weight to 400, and tightening question line-height.
- UI chrome font mismatch: the app depended on an `Inter` family name that may not exist locally, causing inconsistent fallback behavior. Fixed by switching the app chrome to a native Apple/SF-style sans stack.
- Verified computed desktop question font after fix: `Baskerville, "Libre Baskerville", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif`; `font-weight: 400`.
- Verified computed mobile question font after fix: same Baskerville-first stack; `font-weight: 400`.
- Question-row geometry mismatch: the implemented target icon and question text were too close together, which made the corrected serif still read unlike the design. Fixed by widening the desktop icon-to-question gap so the question begins at the same visual column as the approved desktop panel.
- Header alignment mismatch: the brand/title group was slightly too far right. Fixed by tightening desktop header horizontal padding.

## Remaining Comparison Notes

- The reference image is a composite showing both desktop and mobile states. The app implements the active viewport only, so desktop verification compares against the desktop panel in the composite and mobile verification compares against the mobile panel.
- The live app question content comes from the local review queue, so screenshots may show a shorter real question than the long example in the concept. The layout still supports long questions and formulas through the existing markdown/math renderer.
- Wide desktop drift: the app shell was allowed to expand past the approved desktop panel, making the UI feel sparse and unlike the reference. Fixed by constraining the desktop shell to 1200px and reducing outer page padding to the reference rhythm.
- Empty-state drift: the approved design has previous-answer rows, but reloads could show an empty placeholder. Fixed by rendering a reviewed historical answer when there is no current-session answer.
