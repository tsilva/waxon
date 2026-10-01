# Review welcome verification

Date: 2026-09-30. Final result: **passed**.

## Findings

No actionable P0/P1/P2 design findings remain after the spacing correction.

- Resolved [P2]: The first implementation placed the welcome content about 40 px too low relative to the selected mockup. Reduced stage top padding, kicker gap, heading line height, and paragraph gap in `app/(app)/app-globals.css`. The revised production capture aligns the illustration, heading, supporting text, CTA, and final note with the target.
- Accepted differences: the existing Bradford LL serif and Red Hat Mono preserve Waxon's type system; the real account avatar replaces the mockup's generic avatar; the brown CTA is darker for readable white text; the cream background uses the existing product palette. The generated illustration follows the same two study cards and green leaves art direction, with small natural differences in the card edges and leaves.

## Evidence and comparison history

Source visual truth: `/Users/tsilva/.codex/generated_images/01a0f26d-cba9-77c0-8aaa-e8c8fb6c3fd4/exec-ed947a3b-e544-417b-9d97-ae52bfca7d33.png`.

Evidence folder: `/Users/tsilva/.codex/visualizations/2026/09/30/01a0f26d-cba9-77c0-8aaa-e8c8fb6c3fd4`.

- Source: 1100 × 1430 px, normalized to 656 × 853 px in `selected-design-656x853.png`.
- Implementation: `04-live-welcome-final.png`, 656 × 853 px at a 656 × 853 CSS viewport, 1:1 screenshot density.
- State: authenticated learner, genuinely empty Library, Review selected, no dialog open, light theme.
- First comparison: `comparison-initial.png`, source and `03-live-welcome-initial.png` together; result blocked by the P2 vertical spacing drift.
- Fixed comparison: `comparison-final.png`, source on the left and final implementation on the right at equal scale; result passed. The final heading starts at y=355.94 and the illustration at y=140.31 CSS px.
- Additional captures: `05-live-welcome-mobile.png` at 390 × 844 CSS px and `06-live-welcome-desktop.png` at 1440 × 1024 CSS px.
- Separate focused-region crops were unnecessary: the full comparison shows all text, controls, illustration edges, navigation, and spacing clearly at readable scale.

Production: https://waxon.tsilva.eu/review. Vercel deployment `dpl_AJhU7V8BziH4nbEHZSM3mLoUVDhP` is Ready and aliased to the production domain. Code commits: `db79459`, `f0edd0d`.

## Required fidelity surfaces

| Surface | Assessment |
| --- | --- |
| Fonts and typography | Existing Bradford LL display/body serif and Red Hat Mono UI text match the intended serif/mono hierarchy. Two-line heading, line height, weight, tracking, wrapping, and supporting copy remain readable. No truncation. Small mockup font differences are accepted within the existing product type system. |
| Spacing and layout rhythm | Centered illustration and content, generous margins, compact heading-to-copy gap, CTA spacing, and final note align after the second capture. Existing navigation is preserved. No overlapping or clipped controls. |
| Colors and tokens | Warm cream, muted brown type, green leaves, brown CTA, and subtle card shadow follow the target. Solid product colors replace the generated mockup's slight texture. Darker CTA is intentional. |
| Image quality | Transparent 1536 × 1024 PNG generated with imagegen, displayed at about 240 × 160 CSS px. Correct two-card/leaf subject, clean edges, soft ground shadow, no visible checkerboard or disruptive halo. No CSS or SVG approximation of the illustration. |
| Copy and content | Kicker, title, Library instructions, CTA, and final note match the selected concept. The screen offers one clear next step. Empty previous-answer history and zero-due status are hidden only on this welcome state. |

## Browser and interaction checks

Tested in the native Codex in-app browser using the learner's signed-in production account.

- Fresh production navigation renders the final welcome and loads the image successfully.
- “Open Library” activated with Return navigates to `/library`.
- “Add your first question” opens the existing dialog containing Prompt, Answer standard, Cancel, and Add to Library. Cancel closes it successfully. No production question was submitted.
- At 390 × 844, the CTA is 244 × 46 CSS px and fully visible. At 656 × 853 and 1440 × 1024, the welcome and persistent controls fit without horizontal overflow. Document scroll height equals viewport height in all three captures.
- The decorative illustration has empty alt text and is excluded from the accessibility tree. The CTA is a semantic link, and the title is a heading.
- Browser console logs checked after the final deployment: empty, no reported errors.
- Browser viewport restored and the tab returned to Review.

## Code validation and limits

- `pnpm typecheck`, `pnpm lint`, and `keyenv run -- pnpm build` passed.
- New contract assertions passed for an empty learner, a learner with a newly added question, and a learner whose bank contains only flagged questions.
- The full test run was not green: 162 tests reported, 155 pass, 6 failures including a parent suite, 1 skip. Scheduling, stale migration expectations, and the Library footer assertion also failed on untouched main. A correction-chain assertion failed in the changed tree but passed on baseline repeats; its cause remains unresolved, and its implementation was not changed here. Logs are retained in the evidence folder. This report passes the welcome design and tested navigation, not the entire application's behavior.
- Bank creation submission, populated Review, and answer evaluation were not exercised on the production account. Those are outside this empty-state change's live browser checks.
- Root SPECS.md was reread before handoff. No new project-wide requirement or specification edit was needed; question creation remains in Library.

## Open questions

None blocking this welcome implementation. The broader test failures require separate investigation.

## Implementation checklist

- [x] Implement the selected centered welcome with generated study-card art.
- [x] Keep all bank-management actions in Library.
- [x] Distinguish a truly empty bank from a nonempty bank with no due questions.
- [x] Fix the initial spacing drift and compare the revised production capture.
- [x] Verify phone, reference-size, and desktop layouts.
- [x] Verify the primary link and dialog open/cancel on the live domain.
- [x] Deploy the final change and confirm the production alias.

## Follow-up polish

No P3 work required for handoff.

final result: passed

---

# Logged-out landing page — option 1

Date: 2026-09-30. This report covers the landing-page redesign and preserves the earlier report above.

## Findings

No actionable P0/P1/P2 visual findings remain.

- Resolved [P2], typography and section height: the initial 600-weight headings were heavier than the selected mock, and the middle step wrapped, pushing the footer below the reference frame. Used Bradford LL at its native 450 weight, adjusted step type size/tracking and column padding, and reduced footer padding. The three desktop step headings now occupy one line, the steps begin at y=800.45 and end at y=1030.49, and the page fits the 1106px reference height.
- Resolved [P2], mobile copy: hiding the desktop line break could join “feedback.” and “Return” without a space. Added an explicit space and verified the rendered phone copy.
- Resolved accessibility detail: text links and wordmark links have at least 44px-high targets and visible 2px rust keyboard-focus outlines. The rust token was slightly darkened for normal-text contrast.
- Resolved framework warning: declared the existing smooth-scroll behavior on the root HTML element so Next.js can handle route transitions correctly.
- Accepted differences: the existing Bradford LL/Red Hat Mono font system is retained; the generated illustration has small natural differences in card edges, leaf shapes, and crop; the base page uses solid cream rather than the mock's faint paper texture. The study-card scene is a raster illustration, while navigation, headline, copy, CTA, steps, and footer remain semantic HTML. The illustrated answer is not an input control.

## Evidence and comparison history

Source visual truth: `/Users/tsilva/.codex/generated_images/01a0f3f6-0532-7390-aec5-a040cd0e2878/exec-390b86c3-46d8-4ac8-912e-6a6aaa008069.png` — the first displayed ideation image selected by the user.

Evidence folder: `/Users/tsilva/.codex/visualizations/2026/09/30/01a0f3f6-0532-7390-aec5-a040cd0e2878`.

- State: logged out, `/`, light theme, no overlay, reference viewport 1422 × 1106 CSS px.
- Source: 1422 × 1106 pixels. Final browser capture: `landing-desktop-final.png`, 1411 × 1106 pixels at 1:1 content density. The in-app browser excludes its 11px scrollbar strip from capture. `landing-desktop-normalized.png` pads only that strip to 1422 × 1106 without scaling or stretching content.
- Initial evidence: `landing-desktop-initial.png` and `landing-comparison-initial.png`; result blocked by heavier typography and the wrapped middle step. The first overview downscaled the taller capture, so proportional judgments were subsequently checked against the unscaled second comparison.
- Second evidence: `landing-desktop-second.png` and `landing-comparison-second.png`, source and implementation at their native pixel scale; lighter typography fixed the weight, but the middle heading still wrapped.
- Post-fix evidence: `landing-desktop-third.png`, then `landing-desktop-final.png` after wordmark sizing, focus targets, and contrast adjustments. `landing-comparison-final.png` places the source and normalized final implementation together at equal scale; result passed.
- Focused paired comparisons: `landing-comparison-hero-copy.png`, `landing-comparison-hero-art.png`, and `landing-comparison-steps.png`; inspected at readable scale for typography, illustration text/edges, CTA treatment, and column alignment.
- Responsive evidence: `landing-mobile-final.png` at 390 × 844 CSS px; `landing-small-phone.png` at 320 × 740; `landing-tablet.png` at 1024 × 900. Content scrolls vertically on smaller viewports; headings, navigation, CTA, illustration, and footer remain usable without horizontal overflow. The phone steps stack with horizontal dividers.

## Required fidelity surfaces

| Surface | Assessment |
| --- | --- |
| Fonts and typography | Bradford LL 450 headline and section titles with Red Hat Mono UI/body copy preserve the selected serif/mono hierarchy. Two-line headline and all three desktop step headings remain intact. Smaller screens wrap supporting copy naturally. |
| Spacing and layout rhythm | 90px header, approximately 710px hero, 230px step section, and 75px footer match the reference proportions after repair. Fine dividers, generous margins, and the paired CTA treatment remain aligned. |
| Colors and tokens | Cream `#fef9ed`, forest `#08332d`, rust `#ba522c`, and warm rules `#e3dac4`. Main text contrast is 13.13:1 and muted copy 7.59:1; CTA foreground/background is 13.26:1. Rust is darkened slightly relative to the mock for small-text readability. |
| Image quality | Built-in imagegen produced `public/landing/practice-journal-hero.png`, 1342 × 1172 PNG with genuine alpha. Card, olive branch, pencil, cup, Correct feedback, and scheduled-review text match the approved art direction. Next Image preserves aspect ratio and serves a responsive optimized image with eager loading/high fetch priority. |
| Copy and content | Headline, supporting copy, both CTAs, three numbered steps, and footer match the selected direction. No numeric score, source ingestion, pricing promise, fabricated proof, or fixed review interval is introduced. |

## Browser and interaction checks

Verified through the native Codex in-app browser and its documented browser-client APIs.

- “How it works” and “See how it works” navigate to `#how-it-works`.
- Privacy and Terms links navigate to their existing pages and render their headings.
- The primary CTA navigates to `/sign-up`; the visible Sign in link targets `/sign-in`. Existing local test authentication still routes Sign in to Review.
- Keyboard Tab reaches the secondary hero link and displays the 2px focus outline.
- The hero image loads, has descriptive alternative text, and does not create a fake interactive form.
- Final landing-page reload produced no new console errors or warnings. Earlier logs included the smooth-scroll warning, a transient development HMR/router error, and the credential failure described below; these are not omitted from the verification history.
- Temporary viewport overrides were reset; the preview tab is marked as a deliverable and left open.

## Validation and limits

- `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `git diff --check` passed. This is a presentation change; no application data, scheduling, dependencies, or auth-provider implementation was changed.
- Preview: `http://localhost:57403/`, started with `NEXT_PUBLIC_WAXON_DISABLE_LOCAL_TEST_AUTH=1 pnpm dev --port auto`. The existing Keychain launcher could not start noninteractively, so this preview has no injected credentials.
- Authentication-form verification is blocked locally: navigating to the existing signup route reports Clerk's “Missing secretKey.” The link destination was verified, but no authentication form was completed and no account was created. This report passes the landing design and tested public navigation, not an end-to-end signup flow.
- Root SPECS.md was reread. The redesign adds no new project-wide requirement; no specification edits were needed.
- No push or deployment was performed.

## Open questions

None blocking the landing implementation. A credential-authorized preview is needed to exercise the existing Clerk forms.

## Implementation checklist

- [x] Implement the selected option in the existing landing route.
- [x] Generate and place the separate hero asset; retain its prompt alongside it.
- [x] Restore a real logged-out Sign in link and route Get started to existing signup.
- [x] Repair typography, wrapping, footer spacing, and mobile copy.
- [x] Compare full-page and focused source/implementation pairs.
- [x] Verify desktop, tablet, phone, and narrow-phone layouts, public links, focus, and final console state.
- [x] Pass lint, typecheck, production build, and diff checks.

## Follow-up polish

Minor natural differences in the generated card illustration and mock font metrics remain acceptable. No P3 refinement is required for handoff.

final result: passed
