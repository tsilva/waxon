---
type: Experiment Note
title: Learn answer evaluator cache on OpenRouter Mercury
description: Real Learn turns showed the compact Mercury evaluator can use explicit cache-control text blocks for partial prompt-cache hits, while padded Gemini evaluator prompts cached more tokens but were slower.
tags: [learn, openrouter, prompt-cache, latency, evaluator]
timestamp: 2026-06-24T18:35:00Z
status: verified
confidence: high
source:
  - file:app/lib/courseGeneration.ts
  - file:tests/courseGeneration.test.mts
---

# Summary

The `course_answer_decision` evaluator initially stayed on `inception/mercury-2` after real Learn turns and controlled OpenRouter probes. The durable request-shape change is a versioned evaluator `session_id`, a cacheable system text block, and a non-cacheable dynamic user text block. The volatile course, widget, learner answer, and lesson context remain after the cacheable system prompt.

# Evidence

Baseline real Learn turns on Mercury used the default user-id session key, no serialized `cache_control`, and string message content. Two SQL answer turns reported about 630-681 input tokens, 195-199 output tokens, 614-618 ms trace latency, and only 4-6 cached prompt tokens.

Controlled probes using the latest real evaluator prompt found that Gemini 2.5 Flash with the short evaluator prompt stayed below the 1024-token cache eligibility floor and returned 0 cached tokens. Padding the stable Gemini evaluator rubric to about 2,119 prompt tokens produced cache hits up to 1,959 tokens, but latency stayed about 2.4-2.6 s. Gemini 2.5 Flash Lite with the padded prompt returned 1,792 cached tokens on repeat and about 955 ms latency, still slower than Mercury for the user-facing evaluator.

After changing the Mercury evaluator request shape, real Learn answer turns persisted explicit `cache_control`, versioned `session_id` values such as `learn:<user>:course-answer-decision-v2`, system/user content as OpenRouter text-block arrays, and `max_tokens=320`. Measured examples included 189 cached tokens out of 626 input tokens with 569 ms latency and a correct linear-regression answer scored 9 with the justification "Accurately captures prediction and relationship summarization." Wrong or off-target answers in Bayes/PPO/linear-regression turns scored 2-4 and did not advance the milestone.

# Result

This note is evidence for latency/cache tradeoffs. A later explicit experiment on 2026-06-24 confirmed `google/gemini-3.1-flash-lite` serialized `cache_control` and stable Learn session IDs but still returned zero cached prompt tokens and zero cache-write tokens. A controlled large-block probe also showed `google/gemini-2.5-flash` returning zero cache writes, while `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-4.5`, `qwen/qwen3-coder-flash`, and `qwen/qwen3-coder-plus` returned nonzero `cache_write_tokens` and repeat `cached_tokens`. The app defaults were changed to `anthropic/claude-haiku-4.5` for cacheable generic chat and Learn tutor turns, while keeping `inception/mercury-2` for compact answer evaluation. A real Learn continuation on the v8 tutor prompt shape reported 185 cached evaluator tokens out of 691 input tokens with 585 ms latency. Do not pad the evaluator prompt solely to cross provider cache thresholds unless real Learn turns show better wall-clock latency and preserved grading quality. For compact evaluator prompts, explicit cache markers and stable session routing improve request shape and sometimes reduce prompt cost, but provider cache reads are not guaranteed on every turn.
