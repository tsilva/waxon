# Waxon Learning

Waxon models the questions a learner wants to remember and the evidence used to decide when each question should be reviewed.

## People and ownership

**Learner**:
An authenticated person who owns exactly one private Library.
_Avoid_: User, account, student

**Authorized MCP Client**:
A revocably authorized agent that may search and add Questions in exactly one Learner's Library.
_Avoid_: Agent user, shared learner

**Library**:
The private collection of Questions owned by one Learner. A Library is neither shared nor transferred between Learners.
_Avoid_: Deck, collection

## Questions

**Question**:
An immutable Prompt and Answer Standard testing one Recall Target. Editing either part creates a new Question and archives the existing Question.
_Avoid_: Card, flashcard, item

**Recall Target**:
The specific knowledge a Question asks the Learner to retrieve. Mastery belongs only to the Question that produced its Learning Evidence, even when another Question has a similar Recall Target.
_Avoid_: Topic, concept, target

**Answer Standard**:
The stored evidence against which a Learner Answer is evaluated. It may be prose or explicit criteria but does not select a separate evaluation mode.
_Avoid_: Answer mode, expected output

**Active Question**:
A Question that passed quality assessment and participates in Review. Every structurally and semantically valid newly added Question is Active immediately; a semantically questionable candidate is Flagged instead.
_Avoid_: New question, live card

**Flagged Question**:
A Question withheld from Review because the Learner or Waxon identified something that needs attention. It remains in the Library until the Learner restores, replaces, or archives it and may have zero or more Flag Reasons.
_Avoid_: Paused question, deferred question

**Flag Reason**:
A concise optional explanation of why a Question needs attention before returning to Review. A Flag Reason may come from the Learner or from Waxon's question-quality validation.
_Avoid_: Suspension reason, validation error

**Archived Question**:
A reversible, out-of-circulation Question that creates no Review work until restored.
_Avoid_: Paused question, deleted question, trashed question, flagged question

## Organization

**Tag**:
A learner-specific English subject-matter query identified by a canonical label, optional aliases, and a concise semantic description. Waxon uses that content to rank semantically related Questions without partitioning the Library. A Tag is not assigned to a Question and does not change its Recall Target, identity, Learning Evidence, or Review behavior.
_Avoid_: Deck, category, topic hierarchy, Recall Target

**Embedding Space**:
A declared compatible representation shared by Question and Tag embeddings. Waxon compares embeddings only within one Embedding Space and never combines scores across spaces.
_Avoid_: Model name, dimension count, compatible-enough embedding

**Related Tag**:
A Tag near a Question in their active Embedding Space. Relatedness is calculated when read and is neither stored membership nor part of the Question.
_Avoid_: Assigned Tag, category membership, Recall Target

## Review and learning

**Review Queue**:
The live set of Active Questions scheduled on or before the Learner's Local Day, including every newly added Active Question. It is derived from Learning Evidence rather than stored as a session or plan.
_Avoid_: Capacity-limited plan, durable session, study deck

**Learner Answer**:
The Learner's free-text attempt to recall an Active Question.
_Avoid_: Response mode, answer type

**Recall Result**:
The effective classification of how fully one Learner Answer recovered its Recall Target: Incorrect, Partial, or Correct. It describes the current answer, not Review scheduling.
_Avoid_: Answer Grade, difficulty, mastery

**Answer Grade**:
The scheduling signal derived from a Recall Result and prior Learning Evidence. Its values Again, Hard, Good, and Easy are not correctness labels.
_Avoid_: Recall Result, correctness score, mastery score

**Learning Evidence**:
The immutable history of Learner Answers, automated evaluations, and corrections used to derive Review scheduling.
_Avoid_: Mutable mastery, current score

**Evaluation Correction**:
An immutable replacement of the effective Recall Result for one Learner Answer. The original automated evaluation remains part of Learning Evidence.
_Avoid_: Evaluation edit, grade overwrite

**Local Day**:
The calendar day in the Learner's persisted IANA timezone. The timezone is detected automatically and remains editable by the Learner.
_Avoid_: UTC day, server day
