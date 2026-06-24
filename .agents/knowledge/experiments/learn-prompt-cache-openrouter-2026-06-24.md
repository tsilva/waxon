---
type: Experiment Note
title: Learn prompt cache on OpenRouter Gemini
description: Real Learn course turns showed Gemini 3.1 Flash Lite serialized cache markers but returned zero cache writes; Gemini 2.5 Flash returned cache writes and reads with immutable tutor instructions cached.
tags: [learn, openrouter, prompt-cache, latency, tutor]
timestamp: 2026-06-24T16:46:51Z
status: verified
confidence: high
source:
  - file:app/lib/courseGeneration.ts
  - file:app/lib/openRouter.ts
  - file:tests/courseGeneration.test.mts
---

# Summary

Real `/api/courses/chat` Learn turns confirmed that request shape alone was not enough for prompt-cache hits. `google/gemini-3.1-flash-lite` received serialized `cache_control` blocks and a stable `session_id`, but returned `cached_tokens=0` and `cache_write_tokens=0` across baseline and larger-cacheable-prefix attempts.

# Evidence

Baseline PPO and Bayes turns on `google/gemini-3.1-flash-lite-20260507` showed `course_chat_turn` prompts with explicit `cache_control` and `stream_options.include_usage=true`, but persisted OpenRouter usage stayed at zero cache writes and reads. Example traces had prompt tokens around 1030-1524 and later 1229 after moving tutor instructions into one cacheable block, still with `cached_tokens=0` and `cache_write_tokens=0`.

Comparison turns on `google/gemini-2.5-flash` with a versioned `session_id` (`learn:<user>:course-chat-v2`) and one immutable tutor-instruction cache block produced real cache metrics. The first verified write trace reported `cached_tokens=1241`, `cache_write_tokens=1241`, `inputTokens=1457`, and `cacheHitPercent=85.18`. Later turns with course title and recent history after the cache block reported `cached_tokens=1241`, `cache_write_tokens=0`, and hit rates of `82.84%` for an initial CNN turn and `61.41%` for its continuation.

# Result

The Learn default model was changed to `google/gemini-2.5-flash`. The tutor request now keeps only immutable tutor instructions in the cacheable block, with dynamic course, milestone, progress, and recent conversation content after the breakpoint. A prompt-shape version suffix on the session ID avoids sticky routing against older incompatible cache boundaries.

# Constraints

`google/gemini-2.5-flash-lite` produced high cache metrics in one comparison, but a continuation returned `completion_tokens=0` and forced a generic server fallback, so it was rejected despite better cache percentage. `google/gemini-2.5-flash` preserved visible tutor quality in the verified continuation but is slower and more expensive than the old default on some first turns.
