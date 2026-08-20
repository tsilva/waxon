# Waxon Design Fidelity Ledger

Reference image: `design-reference/waxon-approved-ui.png`

## Current loop

- August 20, 2026 Lean Core: authenticated navigation remains `Review` / `Library`, with `Admin` visible only to operators.
- Library is now one warm editorial question-bank surface: count, add, search, lifecycle filters, restrained row actions, and agent access. Source capture, concept organization, generation, maps, saved views, and provenance are intentionally absent.
- Review now uses the approved question → compact composer → `Previous answers` list in both its static loading and hydrated states. The centered recall card and sticky daily-plan header are intentionally absent; capacity warnings, feedback, grade correction, and delayed retry remain.
- The approved reference’s typography, warm paper palette, subdued borders, header geometry, focused composer, and desktop/mobile rhythm remain authoritative. Its sample question and due count are not fixed requirements.

## Verification status

- Desktop native in-app Browser verification passed for question presentation, answer submission, expandable list feedback, and learner grade correction. The loading and hydrated surfaces now share the same layout, eliminating the old-to-new UI swap.
- Typecheck and lint passed after restoring the approved Review surface.
- A fresh native in-app Browser comparison is required before replacing the approved composite. Verify desktop and 390 px layouts, keyboard focus, reduced motion, 200% zoom, long prompts, formulas, dialogs, and populated/empty bank states.
- The reference predates the lean Library, so compare shared shell, typography, spacing, color, and interaction treatment rather than removed controls.
