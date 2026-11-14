# Isolated startup comparison

This diagnostic branch replaces only its copy of the existing manual Lighthouse workflow. It must not be merged into main: normal production Lighthouse configuration and delivery remain authoritative there. Run `gh workflow run lighthouse-ci.yml --ref codex/lighthouse-comparison-20261114` against this repository. The job accepts only that exact branch and uses contents-read permission without environments, secrets, migrations or deployment steps.

The baseline is an immutable application commit. A reviewed source patch is applied only inside a disposable runner directory. Frozen installs and inert builds run sequentially with synthetic settings and a loopback monitoring collector; hosted source-map upload and production monitoring settings are unchanged.

Before each counterbalanced cohort, the runner must pass three consecutive idle readings (at least 85% idle, at most 1% steal, normalized load at most0.75), bounded to 180seconds. A failed admission stops measurement. Sixteen samples and every admission reading are retained. Diagnostic timings are not normal production Lighthouse scores and never trigger publication.

The catalogue job uses a separate Brave Stable process for every sample with its Chromium sandbox enabled, an isolated locked browser driver and identical 100ms JavaScript fixture latency. It measures startup LCP and cold Breakout-detail readiness and checks all 34 cards. The proxy job runs fresh the maintained Node 24 line (exact version recorded) production servers sequentially, recording first/warm/warm anonymous response timing and header policy. Fixtures do not establish real authentication, production ingestion or full end-to-end application certification.

The seven-day startup-comparison artifact retains synthetic logs, samples, runner conditions and catalogue screenshots. Disposable builds and dependency trees are removed before upload. Keep all samples; compare each cohort separately and reject contradictory timing conclusions. A promising result still needs repository regression gates, authorized exact-commit delivery and the unchanged normal production audit.

Output containment is checked before creation; differing anonymous response policies fail acceptance. Monitoring, Vercel configuration and dependency-lock hashes are verified unchanged.
