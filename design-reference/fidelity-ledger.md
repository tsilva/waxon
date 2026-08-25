# Waxon Design Fidelity Ledger

Reference image: `design-reference/waxon-approved-ui.png`

## Current loop

- August 20, 2026 Lean Core: authenticated navigation remains `Review` / `Library`, with `Admin` visible only to operators.
- Library is now one warm editorial question-bank surface: count, add, search, lifecycle filters, restrained row actions, and agent access. Source capture, concept organization, generation, maps, saved views, and provenance are intentionally absent.
- Library question creation now asks only for the recall prompt, reference answer, and importance; answer-mode classification is intentionally absent.
- Review now uses the approved question → compact composer → `Previous answers` list in both its static loading and hydrated states. The centered recall card and sticky daily-plan header are intentionally absent; capacity warnings, feedback, grade correction, and delayed retry remain.
- Review question prompts now include two restrained icon controls above the reading text: flag for later and move to the next queued question. Their loading placeholders preserve the approved question/composer rhythm.
- Resolved Review feedback uses numeric score badges and exposes the correction scale directly in its buttons: Again (0), Hard (2), Good (3), and Easy (4).
- Resolved Review feedback shows the persisted next-review schedule beneath its submission recency, with a compact relative label and exact local date/time metadata.
- The approved reference’s typography, warm paper palette, subdued borders, header geometry, focused composer, and desktop/mobile rhythm remain authoritative. Its sample question and due count are not fixed requirements.

## Verification status

- Desktop native in-app Browser verification passed for question presentation, answer submission, expandable list feedback, and learner grade correction. The loading and hydrated surfaces now share the same layout, eliminating the old-to-new UI swap.
- Desktop and 390 px native in-app Browser verification passed for numeric feedback badges and labeled grade-correction values, with the four buttons remaining readable and contained at the mobile breakpoint.
- Desktop and 390 px native in-app Browser verification passed for persisted next-review labels, exact schedule metadata, expanded feedback layout, and horizontal containment.
- Desktop and 390 px native in-app Browser verification passed for the icon-only flag/next controls, queue rotation, flagged Library classification, and restoration.
- Desktop and 390 px native in-app Browser verification passed for Library inline formulas with Greek symbols, command subscripts, relation separators, and hats; surrounding answer text wraps without horizontal overflow.
- Typecheck and lint passed after restoring the approved Review surface.
- A fresh native in-app Browser comparison is required before replacing the approved composite. Verify desktop and 390 px layouts, keyboard focus, reduced motion, 200% zoom, long prompts, formulas, dialogs, and populated/empty bank states.
- The reference predates the lean Library, so compare shared shell, typography, spacing, color, and interaction treatment rather than removed controls.
