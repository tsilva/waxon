# Waxon Design Fidelity Ledger

Reference image: `design-reference/waxon-approved-ui.png`

## Current Loop

- Refreshed `design-reference/waxon-approved-ui.png` on June 8, 2026 from the live local app at `http://localhost:3001/review`.
- The new composite uses a 1440x900 desktop capture and a 390x844 mobile capture stitched side by side.
- The refreshed baseline reflects the current product UI: `Learn` / `Decks` navigation, current waxon mark, warm brown accent, deck provenance above the active question, microphone and submit composer actions, and the admin-visible mobile toolbar state.
- Current live data at capture time showed `181 due` and a Deep Learning question. Treat the exact due count and question text as sample content, not a fixed design requirement.

## Remaining Comparison Notes

- The reference image is a composite showing both desktop and mobile states. The app implements the active viewport only, so desktop verification compares against the desktop panel in the composite and mobile verification compares against the mobile panel.
- The live app question content comes from the local review queue, so screenshots may show different real questions across verification runs. The layout should still support long questions and formulas through the existing markdown/math renderer.
- Mobile captures in a local admin-enabled session may include the `Admin` toolbar link. Non-admin sessions can compare layout, spacing, typography, and control treatment while ignoring that role-specific link.
- Previous-answer rows are data-dependent. Empty or populated history states should preserve the same section spacing, border rhythm, and fixed composer geometry as the refreshed baseline.
- June 8, 2026 queue update: deck-detail queue toolbars now include a compact semantic card search field between `Generate` and `Sort by`. Compare it as an intentional product delta from the approved reference; desktop keeps the single-row toolbar and mobile stacks the search field full-width with no horizontal overflow.
- June 9, 2026 queue update: deck-detail embedding maps moved out of the inline queue surface and into a `Map` modal launched from the deck detail header. Compare the missing inline plot as intentional; the modal should preserve the warm framed plot treatment, close affordance, and no horizontal overflow on desktop and mobile.
- June 9, 2026 review update: previous-answer rows may show a discreet `eval $...` label in the lower-right metadata area when trace cost data is available. Treat this as an intentional addition that should stay low-contrast and avoid crowding the timestamp/expand control.
- June 9, 2026 review update: formula-like inline snippets now use a muted formula color treatment and baseline alignment distinct from ordinary inline code. Treat the warmer formula highlight as intentional when comparing formula-heavy questions.
