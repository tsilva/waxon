# Waxon Design Fidelity Ledger

Reference image: `design-reference/waxon-approved-ui.png`

## Current Loop

- Refreshed `design-reference/waxon-approved-ui.png` on June 8, 2026 from the live local app at `http://localhost:3001/review`.
- The new composite uses a 1440x900 desktop capture and a 390x844 mobile capture stitched side by side.
- The reference predates the July 17, 2026 navigation simplification. Current authenticated navigation is `Review` / `Library`, with `Admin` added for operators; ignore the archived `Learn` and `Tags` tabs when comparing shell spacing.
- Current live data at capture time showed `181 due` and a Deep Learning question. Treat the exact due count and question text as sample content, not a fixed design requirement.

## Remaining Comparison Notes

- The reference image is a composite showing both desktop and mobile states. The app implements the active viewport only, so desktop verification compares against the desktop panel in the composite and mobile verification compares against the mobile panel.
- The live app question content comes from the local review queue, so screenshots may show different real questions across verification runs. The layout should still support long questions and formulas through the existing markdown/math renderer.
- Mobile captures in a local admin-enabled session may include the `Admin` toolbar link. Non-admin sessions can compare layout, spacing, typography, and control treatment while ignoring that role-specific link.
- Previous-answer rows are data-dependent. Empty or populated history states should preserve the same section spacing, border rhythm, and fixed composer geometry as the refreshed baseline.
- June 8-9, 2026 queue updates were superseded by the current Library-backed queue surface. Compare semantic search, generated-question actions, and embedding-map modal behavior against the live Library/Review UI rather than the removed deck-detail concept references.
- June 9, 2026 review update: previous-answer rows may show a discreet `eval $...` label in the lower-right metadata area when trace cost data is available. Treat this as an intentional addition that should stay low-contrast and avoid crowding the timestamp/expand control.
- June 9, 2026 review update: backticked formula-like inline snippets now share the same warm mono inline-code chip treatment as ordinary identifiers such as `target_logit`. Treat matching formula/code chips as intentional when comparing formula-heavy questions.
- June 13, 2026 mobile shell update: authenticated app pages use an icon-only brand mark in the mobile header so the tab strip and due-count actions fit without clipping. Treat the missing visible `waxon` wordmark in mobile app chrome as intentional; the desktop header still shows the full wordmark.
- July 14, 2026 scope update: the course experience and its navigation tab are intentionally absent while work focuses on question-bank and Review milestones.
- June 27, 2026 tag update: concept tag badges use squared 4px corners instead of pill corners across Review, Library, and question detail surfaces.
- July 17, 2026 Library update: concept-tag activation, renaming, merging, and question inspection live in the Library `Tags` modal. The old standalone Tags tab is intentionally absent, and `/tags` redirects to `/library` for old bookmarks.
- July 17, 2026 shell/details ownership update: authenticated toolbar actions and local account settings are mounted once at the app-layout boundary, active tabs are derived from the route, and Review/Library share one question-details dialog. These are ownership changes only; preserve the approved header geometry, modal treatment, and responsive behavior.
