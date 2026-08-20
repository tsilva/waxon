## PROJECT PURPOSE

Waxon is a multi-user question bank and adaptive review system. Learners and their authorized agents add questions about anything they are learning, learners answer from memory in their own words, and Waxon determines the bounded daily practice that best preserves recall over time.

## PROJECT REQUIREMENTS

- Waxon must support questions about any topic without specializing behavior for current test topics.
- Production must provide functional user authentication and isolate each learner's learning data.
- Waxon must maintain one question bank per learner.
- Learners must be able to add, find, edit, pause, archive, restore, and logically remove questions directly.
- Authorized MCP clients must be able to search a learner's question bank and add questions through the same validation and isolation rules as the application.
- Waxon must not ingest, parse, update, or retain documents, URLs, pasted source material, source provenance, or source coverage.
- Waxon must not automatically generate bank questions from source material or learner answers; new questions enter through direct learner entry or an authorized MCP client.
- Every active question must be self-contained, atomic, recall-oriented, and answerable from a stored reference answer or rubric.
- Adding a valid question must not depend on concepts, provenance, embeddings, enrichment, or model generation.
- Retried add requests and exact duplicate questions must not create duplicate bank entries.
- Editing or changing a question's lifecycle must not silently discard learning evidence or apply old mastery to a materially different recall target.
- Removing a question must remain reversible and preserve its immutable learning history.
- Library must be the sole bank-management surface; Review must contain only free-text recall practice selected by the daily plan.
- Every active question must remain eligible for future Review according to the learner's past performance; paused, archived, and logically removed questions must not create review work.
- Adding questions through either the application or MCP must not automatically create an unbounded same-day Review backlog.
- Review must prioritize retention-due questions before capacity-admitted first exposures.
- Every automated evaluation must provide enough corrective feedback to understand the expected answer and demonstrated gap, and the learner must be able to correct a wrong evaluation without corrupting scheduling history.
- Review must lengthen intervals after repeated correct answers and shorten them after failed or weak answers.
- A failed first presentation must receive exactly one delayed retry in the same resumable session; it must follow another question or wait at least ten minutes when no other question is eligible, and a failed retry must not recurse into same-day drilling.
- Review must build a bounded daily plan according to the learner's retention target and available capacity, prioritizing forgetting risk, uncertainty, importance, and incomplete understanding.
- Waxon must tell the learner when the selected retention target cannot be sustained by the available practice capacity.
