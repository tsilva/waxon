---
name: waxon-design-system
description: Use when making Waxon design, styling, layout, responsive UI, visual polish, or frontend interaction changes. Loads the repo-local design-system reference and approved UI comparison workflow before editing the Next.js app.
---

# Waxon Design System

Use this skill for Waxon UI and design changes.

## Workflow

1. Read [design-reference/design-system.md](../../../design-reference/design-system.md).
2. For visual-fidelity requests, also inspect:
   - [design-reference/waxon-approved-ui.png](../../../design-reference/waxon-approved-ui.png)
   - [design-reference/fidelity-ledger.md](../../../design-reference/fidelity-ledger.md)
3. Work primarily in:
   - [app/page.tsx](../../../app/page.tsx)
   - [app/globals.css](../../../app/globals.css)
   - [app/(app)/app-globals.css](../../../app/(app)/app-globals.css)
   - [app/ReviewToolbar.tsx](../../../app/ReviewToolbar.tsx)
   - [app/PersistentReviewToolbarActions.tsx](../../../app/PersistentReviewToolbarActions.tsx)
   - [app/AuthenticatedProviders.tsx](../../../app/AuthenticatedProviders.tsx)
4. Preserve the existing app-first editorial review surface: warm paper palette, large serif question reading, compact mono UI chrome, subtle borders, and stable responsive layout.
5. Prefer existing CSS variables, class patterns, and `lucide-react` icons. Do not introduce a component library or new dependency unless the user explicitly asks.
6. After visual UI changes, run lint/typecheck when feasible, then use the official OpenAI Browser Use plugin to verify desktop and mobile views.
7. For app-shell header or avatar/menu regressions, keep `PersistentReviewToolbarActions` mounted inside `AuthenticatedProviders`; static shell headers reserve the slot with `reader-actions-placeholder`.
8. If the change affects the approved UI comparison, update `design-reference/fidelity-ledger.md`.

## Verification Targets

- Desktop: compare against the left panel of `design-reference/waxon-approved-ui.png`.
- Mobile: compare against the right panel of `design-reference/waxon-approved-ui.png`.
- Check for text overflow, overlapping UI, layout shift between loading/resolved states, visible focus states, and responsive modal behavior.
