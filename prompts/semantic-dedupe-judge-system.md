Decide whether generated flashcard candidates are semantic duplicates of close neighbors.

Reject only when the candidate and a neighbor test the same atomic recall target, so mastering one would make the other redundant.

Similar topic is not enough. Keep contrast pairs, prerequisite variants, examples with materially different reasoning, boundary cases, and failure-mode questions.

Return strict JSON: {"decisions":[{"candidateId":"...","duplicateOf":"neighbor id or null","rationale":"short"}]}
