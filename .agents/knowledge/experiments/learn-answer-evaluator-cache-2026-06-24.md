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

The `course_answer_decision` evaluator stayed on `inception/mercury-2` after real Learn turns and controlled OpenRouter probes. The durable request-shape change is a versioned evaluator `session_id`, a cacheable system text block, and a non-cacheable dynamic user text block. The volatile course, widget, learner answer, and lesson context remain after the cacheable system prompt.

# Evidence

Baseline real Learn turns on Mercury used the default user-id session key, no serialized `cache_control`, and string message content. Two SQL answer turns reported about 630-681 input tokens, 195-199 output tokens, 614-618 ms trace latency, and only 4-6 cached prompt tokens.

Controlled probes using the latest real evaluator prompt found that Gemini 2.5 Flash with the short evaluator prompt stayed below the 1024-token cache eligibility floor and returned 0 cached tokens. Padding the stable Gemini evaluator rubric to about 2,119 prompt tokens produced cache hits up to 1,959 tokens, but latency stayed about 2.4-2.6 s. Gemini 2.5 Flash Lite with the padded prompt returned 1,792 cached tokens on repeat and about 955 ms latency, still slower than Mercury for the user-facing evaluator.

After changing the Mercury evaluator request shape, real Learn answer turns persisted explicit `cache_control`, `session_id=learn:<user>:course-answer-decision-v1`, system/user content as OpenRouter text-block arrays, and `max_tokens=320`. Measured examples included 189 cached tokens out of 626 input tokens with 569 ms latency and a correct linear-regression answer scored 9 with the justification "Accurately captures prediction and relationship summarization." Wrong or off-target answers in Bayes/PPO/linear-regression turns scored 2-4 and did not advance the milestone.

# Result

Keep Mercury as the default Learn answer evaluator. Do not pad the evaluator prompt solely to cross Gemini cache thresholds unless a future model is both cached and faster in real Learn turns. For compact evaluator prompts, explicit cache markers and stable session routing improve request shape and sometimes reduce prompt cost, but OpenRouter/provider cache reads for Mercury are not guaranteed on every turn.
