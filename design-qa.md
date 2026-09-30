**Comparison Target**

- Source visual truth: `/var/folders/wz/x29jb7_x5rdc_5dcjr4qnhg00000gn/T/codex-clipboard-0c2b9b90-97dd-4bc0-93c5-eb3b748bb878.png`
- Rendered implementation: captured and emitted inline from the Codex in-app Browser; its runtime did not expose a persisted filesystem path.
- Viewport: 1280 × 720 CSS pixels at device pixel ratio 2.
- Dimensions and normalization: source 1654 × 302 PNG pixels; implementation browser capture 1280 × 720 JPEG pixels. Density and crop normalization were not useful because the artifacts show different data states.
- State: source shows a populated, collapsed Library row with predicted and ground-truth Tags; implementation shows the Library empty/error state because the running local server has no `DATABASE_URL` or `DATABASE_URL_UNPOOLED`.

**Findings**

- [P2] The requested unified Tag row could not be visually compared.
  Location: Library question-row metadata.
  Evidence: the source contains a populated row and two Tag groups, while the implementation capture reports zero Questions and displays the database-configuration error before any `.lean-question-row` exists.
  Impact: the browser capture cannot independently verify that matched Tags stay neutral, missing ground-truth Tags render green, extra predictions render red, or all Tags occupy one metadata row.
  Fix: capture the same Library fixture from a server started with its configured database, then compare the populated row at a matching crop.

**Fidelity Surfaces**

- Fonts and typography: the rendered Library shell uses the expected Bradford LL and Red Hat Mono hierarchy, but populated-row Tag typography cannot be compared in the missing state.
- Spacing and layout rhythm: shell proportions remain consistent; source and implementation states differ, so the single-row Tag rhythm cannot be visually judged.
- Colors and visual tokens: the implementation retains the existing cream, brown, muted red, and green design tokens. The semantic Tag colors cannot be inspected on the empty page.
- Image quality and asset fidelity: no image assets are part of the affected Tag comparison; the existing icon library remains unchanged.
- Copy and content: the separate visible `Ground Truth` label was removed by design. Accessible names describe matched, missing, and extra states without relying on color alone.

**Full-view Comparison Evidence**

- The source and the browser-rendered implementation were emitted together for direct comparison. The application shell is consistent, but the state mismatch prevents a valid question-row fidelity judgment.

**Focused Region Comparison Evidence**

- A focused Tag-region comparison was impossible because the rendered implementation contains no question rows.

**Browser Verification**

- URL: `http://localhost:65492/library`
- Primary interaction tested: Library navigation and settled data-load state.
- Changed Tag interaction: blocked because no populated question row rendered.
- Console errors checked: no browser console warnings or errors were reported.
- Visible blocker: `DATABASE_URL or DATABASE_URL_UNPOOLED is required`.

**Comparison History**

- Initial pass: source and implementation were opened together. The implementation lacked database-backed row content, so the requested visual state could not be inspected and no visual correction loop could be completed.

**Implementation Checklist**

- [x] Merge predicted and reference Tags into one ordered row.
- [x] Append missing reference Tags after predicted Tags.
- [x] Style missing reference Tags green and extra predicted Tags red.
- [x] Preserve neutral styling for matches and unscored predictions.
- [x] Expose comparison meaning through accessible names and titles.
- [x] Remove the separate ground-truth row and its obsolete styles.
- [x] Pass unit contracts, lint, and type-checking.
- [ ] Capture and compare a populated Library row against the source.

**Follow-up Polish**

- None identified outside the blocked populated-row capture.

final result: blocked

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
