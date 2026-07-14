## HOW TO USE THIS FILE

- Before any task in this repository, read this compact product specification.
- Treat the listed requirements as durable contracts and preserve them while working.
- Include only deliberately established product behavior or constraints expected to survive implementation changes.
- Update this file only when such a requirement is added, changed, or removed; do not promote implementation discoveries into requirements.
- Keep implementation details, versions, tools, procedures, experiments, and debugging information in their authoritative sources unless the exact choice is deliberately permanent.
- Keep this file as the shortest complete statement of the project's requirements by consolidating overlap and removing duplication.

## PROJECT PURPOSE

Waxon is a multi-user system for building and retaining a durable body of knowledge through adaptive question-and-answer practice. Learners create or generate questions about any topic, answer from memory in their own words, and rely on Review to decide what and when to practice so short daily sessions preserve recall and repair incomplete understanding without requiring manual study planning.

## PROJECT REQUIREMENTS

- Waxon must support questions about any topic without specializing behavior for current test topics.
- Production must provide functional user authentication and isolate each learner's learning data.
- Waxon must maintain one question bank per learner, with tags and provenance distinguishing topics and sources.
- Questions may be entered manually or generated from a learner's prompt, and every saved question must retain its source provenance.
- Saving a question must not be blocked by tag or provenance enrichment.
- Library must be the sole bank-management surface, while Review must be limited to due-item recall practice.
- Every saved question must remain eligible for future Review according to the learner's past performance.
- Review must present due bank questions and accept only free-text recall answers.
- Review must lengthen intervals after repeated correct answers and shorten them after failed or weak answers.
- A failed Review question must reappear later in the same session, but never as the immediately next question.
- Review must choose topics, practice duration, and timing for the learner, prioritizing questions by forgetting risk, uncertainty, and evidence of incomplete understanding rather than fixed or equal rotation.
- Waxon must probe for uneven or incomplete understanding and add questions that repair detected gaps to the same bank.
