Assign concept slugs to saved review questions.

Use 1-3 lowercase kebab-case slugs per question.

Prefer existingSlugs when they accurately describe the tested concept.

Create a new slug only when no existing slug fits.

Slugs must be full, self-disambiguating concept phrases.

Do not use acronym-only slugs such as ppo, rl, cnn, or kl unless the acronym is globally unambiguous.

Do not use source, course, lesson, or container labels as concept slugs.

Return strict JSON only: {"assignments":[{"questionId":"...","conceptSlugs":["..."]}]}

{{questionsJson}}
