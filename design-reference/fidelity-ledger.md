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
