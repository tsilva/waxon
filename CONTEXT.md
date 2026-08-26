# Waxon Learning

Waxon models the questions a learner wants to remember and the evidence used to decide when each question should be reviewed.

## People and ownership

**Learner**:
An authenticated person who owns exactly one private Question Bank.
_Avoid_: User, account, student

**Authorized MCP Client**:
A revocably authorized agent that may search and add Questions in exactly one Learner's Question Bank.
_Avoid_: Agent user, shared learner

**Question Bank**:
The private collection of Questions owned by one Learner. A Question Bank is neither shared nor transferred between Learners.
_Avoid_: Library, deck, collection

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
A Question that participates in Review. Every newly added Question is active immediately.
_Avoid_: New question, live card

**Flagged Question**:
A Question withheld from Review because the Learner or Waxon identified something that needs attention. It remains in the Question Bank until the Learner restores, replaces, or archives it and may have zero or more Flag Reasons.
_Avoid_: Paused question, deferred question

**Flag Reason**:
A concise optional explanation of why a Question needs attention before returning to Review. A Flag Reason may come from the Learner or from Waxon's question-quality validation.
_Avoid_: Suspension reason, validation error

**Archived Question**:
A reversible, out-of-circulation Question that creates no Review work until restored.
_Avoid_: Paused question, deleted question, trashed question, flagged question

## Review and learning

**Review Queue**:
The live set of Active Questions scheduled on or before the Learner's Local Day, including every newly added Active Question. It is derived from Learning Evidence rather than stored as a session or plan.
_Avoid_: Capacity-limited plan, durable session, study deck

**Learner Answer**:
The Learner's free-text attempt to recall an Active Question.
_Avoid_: Response mode, answer type

**Answer Grade**:
The effective assessment of a Learner Answer. Answer Grade history is the sole evidence used to schedule future Review.
_Avoid_: Priority signal, mastery score

**Learning Evidence**:
The immutable history of Learner Answers, automated evaluations, and corrections used to derive Review scheduling.
_Avoid_: Mutable mastery, current score

**Evaluation Correction**:
An immutable replacement of the effective Answer Grade for one Learner Answer. The original evaluation remains part of Learning Evidence.
_Avoid_: Evaluation edit, grade overwrite

**Local Day**:
The calendar day in the Learner's persisted IANA timezone. The timezone is detected automatically and remains editable by the Learner.
_Avoid_: UTC day, server day
