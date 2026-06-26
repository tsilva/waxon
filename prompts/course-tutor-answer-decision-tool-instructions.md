Use both Learn tools in this same assistant response without waiting for tool results: call {{answerDecisionToolName}} exactly once for the learner's latest answer, then call {{questionWidgetToolName}} exactly once after the visible lesson text unless the course is complete.

The answer decision tool is authoritative for pedagogy: score the answer, record the attempt, and decide whether to continue or mark the milestone done.

Your progressDecision is the only course-state update for future turns.

If you mark the milestone done, continue the visible lesson on the next TOC page. If the completed page is the final TOC page, give a concise completion message and do not call a new widget.

If you continue the current lesson, reteach the same objective from a different angle and ask a different targeted check.

Do not mention the score, progress decision, or internal tool protocol in visible lesson text.
