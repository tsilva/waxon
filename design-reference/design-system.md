# Waxon Design System

Use this reference before making visual, layout, interaction, or styling changes to the Waxon app.

## Product Feel

Waxon is a focused flashcard review workspace for deep technical questions. The UI should feel editorial, quiet, and study-oriented: generous reading space, restrained controls, clear review state, and no marketing-page treatment.

Prefer:

- Dense but calm application surfaces.
- Large serif question text with enough measure for formulas and long prompts.
- Compact mono UI labels and controls.
- Warm off-white surfaces, subtle borders, and low-contrast shadows.
- Icon-first controls for repeated actions, using `lucide-react` when an icon exists.

Avoid:

- Landing-page heroes, oversized promotional copy, decorative blobs, or generic SaaS cards.
- New component libraries or design-token frameworks unless explicitly requested.
- One-off colors, fonts, or radius values when existing CSS variables and patterns apply.
- Text that explains UI features in the interface.

## Source Files

- Public landing UI: `app/page.tsx`
- Authenticated app UI: `app/(app)/review/ReviewApp.tsx`, `app/(app)/learn/LearnPageClient.tsx`, `app/(app)/library/LibraryPageClient.tsx`
- Public/authenticated styling: `app/globals.css`, `app/(app)/app-globals.css`, `app/(auth)/auth-globals.css`
- Approved visual reference: `design-reference/waxon-approved-ui.png`
- Visual comparison notes: `design-reference/fidelity-ledger.md`
- Brand assets: `public/brand/`

## Tokens

Use the CSS variables in `app/globals.css` as the source of truth:

- Backgrounds: `--bg`, `--surface`, `--surface-soft`, `--accent-soft`
- Text: `--ink`, `--ink-soft`, `--muted`, `--muted-strong`
- Borders: `--line`, `--line-soft`
- Actions and states: `--accent`, `--accent-hover`, `--pending`, `--danger`, `--success`, `--success-soft`
- Depth: `--shadow`

Do not introduce a new dominant palette. If a new state color is needed, add it as a root variable and keep it compatible with the warm paper palette.

## Typography

The app deliberately separates reading text from UI chrome.

- Question and long reading text use `--font-question`: Bradford first, with Iowan/Baskerville/Palatino/Georgia-style fallbacks.
- UI chrome, labels, buttons, stats, and metadata use `--font-ui`: Red Hat Mono and monospace fallbacks.
- Keep `letter-spacing: 0` on display text. Do not scale type directly with viewport width except through existing `clamp()` patterns.
- Math fragments use the custom markdown/math renderer in `app/page.tsx`; preserve inline wrapping behavior for formulas and code.

## Layout

The approved layout is a single centered review shell, not a dashboard.

- Desktop shell: `width: min(1200px, 100%)`, rounded outer container, subtle border and shadow.
- Inner content: question, composer, previous answers, and queue content align to `width: min(1080px, 100%)`.
- Header is compact and functional: brand, tabs, due count, user menu.
- Mobile removes the outer frame: full-width shell, no shadow, no rounded page container.

When changing layout, verify both desktop and mobile against `waxon-approved-ui.png`. The reference image is a composite: compare the desktop app to the left panel and the mobile app to the right panel.

## Component Patterns

- Tabs are text controls with a small accent underline.
- Primary circular actions use `--accent` and white icons.
- Secondary circular actions use warm soft surfaces and accent icons.
- Repeated list rows use 8px radius, subtle borders, and compact spacing.
- Modals are the main valid place for framed panels; avoid cards inside cards.
- Score indicators are circular, fixed-size, and color-coded by result.
- Focus states should be visible, warm, and close to the existing outline style.

Keep fixed-format UI elements stable with explicit dimensions, grid tracks, or responsive constraints so hover, loading, and dynamic text states do not shift the layout.

## Responsive Rules

The breakpoint is currently `@media (max-width: 760px)`.

- Mobile header height is 58px with compressed spacing.
- Mobile question text is about 23-28px with weight 400 and relaxed line-height.
- Composer and previous-answer rows become full-width and tighter.
- Queue and modal layouts collapse to one column.

After changing mobile rules, inspect long questions, long feedback, pending rows, and modal content for overflow or overlap.

## Design Workflow

1. Read this file and, for visual fidelity work, `design-reference/fidelity-ledger.md`.
2. Inspect the relevant `app/page.tsx` structure and existing CSS selectors before editing.
3. Prefer adjusting existing classes and tokens over adding new styling systems.
4. Preserve accessibility attributes, focus states, disabled states, loading states, and reduced-motion behavior.
5. After UI changes, run lint/typecheck when feasible and use the official OpenAI Browser Use plugin for browser verification at desktop and mobile sizes.
6. If the change affects fidelity to the approved UI, update `design-reference/fidelity-ledger.md` with the new comparison note.
