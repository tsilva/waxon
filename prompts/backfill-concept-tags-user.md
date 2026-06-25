Generate concept slugs for existing review questions.

Use 1-3 lowercase kebab-case slugs for each question.

Each slug must be a full, self-disambiguating concept phrase.

Prefer candidateExistingSlugs when one accurately describes the tested concept.

Create a new slug only when no candidate fits.

Never return course titles, lesson titles, source labels, or broad container labels.

Do not use acronym-only slugs such as ppo, rl, cnn, or kl unless globally unambiguous.

Return strict JSON only: {"assignments":[{"questionId":"...","conceptSlugs":["..."]}]}

{{questionsJson}}
