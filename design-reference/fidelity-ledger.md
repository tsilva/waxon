# Waxon Design Fidelity Ledger

Reference image: `design-reference/waxon-approved-ui.png`

## Current loop

- August 26, 2026 clean baseline: authenticated navigation is `Review` / `Library`, with `Admin` visible only to operators.
- Library is one warm editorial surface for counting, adding, finding, replacing, flagging, archiving, restoring, and unflagging immutable Questions, plus learner-scoped agent access.
- Library presents Active, Flagged, and Archived filters; Question replacement is explicit.
- The Flagged filter is a distinct attention inbox with compact Waxon-validation or Learner origin labels, machine-readable reason badges rendered as readable labels, and restore, replace, or archive resolution controls; each row keeps its Flag details in a collapsed disclosure matching Answer Standard.
- Question creation asks only for the Prompt and Answer Standard.
- Review uses the approved question → compact composer → `Previous answers` list in both its static loading and hydrated states. The current Question exposes only a compact Flag action, backed by the standard responsive modal and Library attention inbox.
- Review detects and persists the learner's IANA timezone, exposes it through a compact Local Day settings dialog, and refreshes queue membership after an edit.
- The Local Day dialog uses the standard icon-first close control and keeps the timezone field self-explanatory without feature-description copy.
- Resolved Review feedback uses numeric score badges, exposes the Answer Standard and Demonstrated Gap, shows the next scheduled Local Day, and keeps the existing four-grade control available for append-only Evaluation Correction; evaluator failures use the same control for self-grading.
- Resolved-answer timestamp and schedule metadata remain in the main content flow below the answer details, so all four Answer Grade controls retain unobstructed hit targets without disabling the detail toggle.
- The approved reference’s typography, warm paper palette, subdued borders, header geometry, focused composer, and desktop/mobile rhythm remain authoritative. Its sample question and due count are not fixed requirements.

## Verification status

- Native in-app Browser verification passed for immediate live-queue membership, IANA timezone detection/edit persistence, successful free-text feedback with Answer Standard and Demonstrated Gap, future Local Day scheduling, reload reconstruction without session recovery, and removal of obsolete Review controls.
- At the 390 × 844 mobile viewport, the Review page and Local Day dialog remained horizontally contained; the final console contained no warnings or errors.
- Desktop and 390 px native in-app Browser verification passed for Library inline formulas with Greek symbols, command subscripts, relation separators, and hats; surrounding answer text wraps without horizontal overflow.
- Typecheck and lint passed after restoring the approved Review surface.
- A fresh native in-app Browser comparison is required before replacing the approved composite. Verify desktop and 390 px layouts, keyboard focus, reduced motion, 200% zoom, long prompts, formulas, dialogs, and populated/empty Library states.
- Issue #13 independent native in-app Browser acceptance passed at desktop and 390 × 844: validation-created Flagged Questions showed their attention inbox, Waxon origin and reason labels, stayed out of Review, completed restore/replace/archive paths, and remained horizontally contained with accessible actions. No console errors appeared; one unrelated pre-existing Next smooth-scroll warning remained.
- The approved reference remains authoritative for shared shell, typography, spacing, color, and interaction treatment; the current Library contract determines its controls and states.
- Issue #20 native acceptance passed at desktop and 390 x 844. The Library, Review, grade controls, and Flag modal remained contained; the Easy-control overlap was removed; native Tab/Shift+Tab wrapping, Enter/Space badge activation, Escape dismissal, and trigger-focus restoration passed; only Next's unrelated development smooth-scroll advisory appeared.
