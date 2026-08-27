## PROJECT PURPOSE

Waxon is a multi-user question bank and adaptive recall-practice system. Learners and their authorized agents add questions about anything the learner wants to remember, learners answer from memory in their own words, and Waxon uses answer-grade history to determine when each question returns to Review.

## PROJECT REQUIREMENTS

### Ownership and access

- Production must authenticate each learner and isolate all of their learning data.
- Each learner must own exactly one private question bank that cannot be shared or transferred between learners.
- A learner must be able to authorize and revoke an MCP client scoped to searching and adding questions in only that learner's bank.
- Authorized MCP clients must follow the same validation, duplicate-prevention, and isolation rules as direct learner actions.

### Question bank

- Waxon must support questions about any topic without topic-specific behavior.
- A question must be an immutable prompt and answer standard testing one recall target.
- An answer standard may contain prose or explicit criteria but must not select a separate evaluation mode.
- Editing a question must create a new question with reset mastery and archive the original question with its immutable learning evidence; the replacement's quality determines whether it starts Active or Flagged.
- Active, Flagged, and Archived must be the only question lifecycle states.
- Learners must be able to add, find, replace, flag, archive, restore, and unflag questions.
- Archived questions must remain out of Review until restored, and restoration without replacement must preserve their learning evidence.
- Flagged questions must remain out of Review until restored unchanged, replaced by a new question, or archived.
- Flagging may record zero or more structured reasons and optional free-text detail.
- Every active question must be self-contained, atomic, recall-oriented, and answerable from its stored answer standard.
- A semantically questionable but structurally valid candidate must enter the bank as Flagged with validation reasons instead of becoming active.
- Structurally unusable input must be rejected rather than stored.
- Adding a valid question must not depend on concepts, provenance, embeddings, enrichment, or model generation.
- Exact normalized-prompt duplicates across Active, Flagged, and Archived questions must not create another bank entry.
- Semantic similarity must remain advisory and must not automatically merge questions.
- Retried add requests must not create duplicate bank entries.
- Waxon must not ingest, parse, update, or retain documents, URLs, pasted source material, source provenance, or source coverage.
- Waxon must not automatically generate bank questions from source material or learner answers.
- Legacy source-oriented data, migration compatibility storage, and supporting product behavior must be removed rather than retained through a compatibility period.

### Review and scheduling

- Review must be a live queue derived from Active questions and immutable answer-grade history rather than a persisted daily plan, session, or retry workflow.
- Every newly added Active question must enter Review immediately regardless of queue size.
- Review must contain every Active question scheduled on or before the learner's current local day without daily-item or first-exposure limits.
- The learner's local day must use an automatically detected, persisted, and editable IANA timezone.
- Queued questions must be ordered by earliest scheduled date, then oldest unanswered question, then stable creation order.
- Answer-grade history must be the sole learning signal used to schedule future Review.
- Waxon must use the grades Again, Hard, Good, and Easy without requiring question authors to select an answer mode.
- Again must keep the question in the same day's queue at the end of the current ordering, becoming immediately available when it is the only queued question.
- Hard, Good, and Easy must remove the question from Review until progressively later scheduled dates.
- Repeated successful recall must lengthen future intervals, while weaker or failed recall must shorten them.
- Waxon must not ask for or model daily minutes, practice capacity, item capacity, importance, uncertainty, incomplete-understanding priority, or a selected retention target.
- Every learner answer must follow one generic free-text evaluation path.
- Every automated evaluation must explain the expected answer and demonstrated gap sufficiently for the learner to correct their understanding.
- Learners must be able to correct an evaluation; the original evaluation must remain immutable while scheduling is rebuilt from the latest effective grade for each answer.
- Review may let the learner flag a question for later attention but must provide no other bank-management actions.
