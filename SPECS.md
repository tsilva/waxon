## PROJECT PURPOSE

Waxon is a multi-user system for turning anything a learner studies into a durable, continuously maintainable body of knowledge. Learners capture questions or source material about any topic, answer from memory in their own words, and rely on Waxon to maintain question quality, coverage, organization, and an adaptive daily Review plan that preserves recall and repairs incomplete understanding with the least necessary practice and administration.

## PROJECT REQUIREMENTS

- Waxon must support questions about any topic without specializing behavior for current test topics.
- Production must provide functional user authentication and isolate each learner's learning data.
- Waxon must maintain one question bank per learner; topics, concepts, sources, and saved views may organize or filter questions but must not require exclusive deck placement.
- Learners must be able to add questions directly or submit a document, URL, pasted material, or topic request as a source from which Waxon prepares coverage analysis and question drafts.
- Source-to-question preparation must use a bounded, resumable background agentic workflow informed by the learner’s existing question bank and demonstrated performance to produce the smallest non-redundant question set that provides defensible evidence of source-defined mastery without sacrificing atomicity, provenance, or material coverage.
- Every active question must be self-contained, atomic, recall-oriented, answerable from a stored reference answer or rubric, and linked to its available source provenance.
- Saving source material or a question draft must not be blocked by concept, provenance, embedding, or other enrichment work.
- Waxon must make question coverage auditable for each source and concept, surfacing material gaps, weak coverage, likely overlap, and unresolved source residuals without equating question count with coverage or labeling a source fully audited while material scope remains unmapped or unexcluded.
- Waxon must detect exact and semantic duplicates before activation, keep uncertain negative judgments inactive, and provide a merge path that retains the canonical question's combined sources, concepts, attempts, and learning history.
- Editing, splitting, merging, pausing, archiving, or restoring a question must never silently discard learning evidence or apply old mastery to a materially different recall target.
- Removing a question must create a reversible logical tombstone that preserves its immutable learning history and shared provenance; erasing source/provenance data is a separate explicitly previewed operation.
- Library must be the sole bank-management surface; Review must contain only free-text recall practice selected by the daily plan, including retention-due questions and capacity-admitted first exposures.
- Every active question must remain eligible for future Review according to the learner's past performance; drafts, paused questions, archived questions, and learner-visible questions explicitly suspended for quality, unavailable support, or safety must not create review work.
- Adding or importing questions must not automatically create an unbounded same-day Review backlog; Waxon must admit new material into practice according to learner capacity and priority.
- Review must prioritize retention-due bank questions before capacity-admitted first exposures and accept only free-text recall answers.
- Waxon must introduce source-derived questions in a pedagogical order, withholding first exposure to downstream questions until required prerequisite targets have been recalled successfully, without changing retention-driven scheduling for already-introduced questions.
- Every automated evaluation must provide enough corrective feedback to understand the expected answer and any demonstrated gap, and the learner must be able to correct a wrong evaluation without corrupting scheduling history.
- Review must lengthen intervals after repeated correct answers and shorten them after failed or weak answers.
- A failed first presentation must receive exactly one delayed retry in the same resumable session; the retry must follow at least one different question, or—when no different eligible question exists—an explicit minimum ten-minute delay that counts as non-immediate. The only waiver is a recorded learner-requested pause/archive/logical removal or a support/safety invalidation that makes the question ineligible before exposure; later restoration schedules an ordinary conservative-Due presentation rather than resurrecting the waived retry. A failed retry must not recurse into unbounded same-day drilling.
- Review must build a bounded daily plan that chooses topics, practice volume, and timing for the learner according to a retention target and available capacity, prioritizing forgetting risk, uncertainty, importance, and evidence of incomplete understanding rather than fixed or equal rotation.
- Waxon must tell the learner when the selected retention target cannot be sustained by the available practice capacity rather than representing all overdue material as an undifferentiated debt total.
- Waxon must probe only gaps or misconceptions demonstrated by the learner's answer and add validated repair questions to the same bank without creating redundant or unbounded practice.
