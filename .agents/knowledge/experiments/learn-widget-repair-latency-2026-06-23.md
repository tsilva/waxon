---
type: Experiment Note
title: Learn widget repair and tutor latency
description: Native-browser Learn evaluation found partial hidden widget comments could swallow fallback widgets and dead-end the course.
tags: [learn, browser-evaluation, latency, tutor, widgets]
timestamp: 2026-06-23T16:50:00Z
status: verified
confidence: high
source:
  - file:app/lib/courseChatTurn.ts
  - file:app/lib/courseGeneration.ts
  - file:tests/courseGeneration.test.mts
---

# Summary

During a native Codex Desktop in-app Browser evaluation of a beginner CNN Learn course, `google/gemini-3.5-flash` repeatedly hit the tutor stream token cap while starting a hidden `waxon:question-widget` comment. The server appended a fallback widget, but the earlier partial widget comment consumed the fallback closing marker during parsing, leaving the learner with an interrupted tutor message and no usable answer widget.

# Evidence

The raw stored assistant message contained an unfinished encoded widget comment followed by the fallback widget. The rendered Learn UI showed "This tutor message was interrupted before the final question finished." and no answer control. Persisted traces showed `course_answer_decision` was not the bottleneck (`inception/mercury-2`, about 0.8-1.6s), while `course_chat_turn` hit the tutor token cap (`google/gemini-3.5-flash`, 2,196 output tokens, about 11.5-19.0s).

# Result

`ensureCourseChatTurnHasLearnerQuestion()` now strips partial widget comments before appending fallback content, strips leaked widget-JSON and tutor self-evaluation paragraphs, drops capped trailing paragraph/sentence fragments when the tutor hits the token budget, removes non-capped dangling sentence fragments before fallback, and sanitizes visible content even when the model produced a complete hidden widget. The tutor prompt kept encoded widget comments; compact raw JSON widget comments were rejected because browser testing showed visible escaped JSON in the rendered lesson. Browser passes also showed Gemini could leak word-count compliance commentary ("Total words..." / "Perfect. Fits..."), planning labels (`Goal: Test...`), broken markdown fragments (`:**`, `**,`), and visible widget-planning prose ("Let's use a multiple-choice question..." / `Question: "..."`), so the tutor prompt now forbids word-count, token-count, compliance-check, self-evaluation, and planning-label commentary. Final CNN browser verification on `c8fc7fe0-9cb8-4977-b747-bacee88e0e7c` showed no interrupted warning, a usable fallback widget after answer submission, no leaked JSON or tutor meta commentary, no dangling first-turn or next-turn fragments after the server `done` replacement, `course_answer_decision` latency of 1.1s, and `course_chat_turn` latencies of 7.7s then 7.6s.

Additional PPO and SQL browser reruns on June 24 verified the complete-widget sanitizer across non-CNN topics. PPO course `b07dc596-87de-43d3-87d4-033c7a2b2ba8` had clean final stored output after waiting for the server `done` replacement, despite transient streamed fragments. SQL course `8648bc38-4408-4655-b108-7c17d9d270e0` completed two answer turns with no interrupted warning, leaked JSON, planning labels, visible widget-planning prose, or dangling fragments. Recent trace latencies stayed evaluator-light and tutor-dominated: `course_answer_decision` about 0.45-1.38s, and `course_chat_turn` about 5.8-8.1s in the PPO/SQL passes.

# Follow-Up

The next bottleneck is tutor compliance with concise lesson and widget generation. The flow is no longer blocked, but Gemini still often requires server-side fallback/cleanup, so future tuning should focus on earlier valid widget emission and less fallback dependence rather than weakening the repair path.
