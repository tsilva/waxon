# Waxon product overhaul

## Product decision

Keep one question bank. Do not bring decks back as containers that own cards or
schedules.

The bank should have five independent kinds of structure:

1. **Sources** record where knowledge came from: a paper, book, URL, note,
   lecture, or direct entry.
2. **Coverage targets** are atomic knowledge claims linked to source evidence.
3. **Concepts** are canonical semantic labels with aliases and optional broader
   or narrower relationships.
4. **Questions** are atomic retrieval prompts, with one active canonical
   question per target.
5. **Saved views** are reusable searches such as “Vision transformers”,
   “Japanese”, or “weak this month”. They behave like playlists, not folders.

This preserves the simplicity of one bank while avoiding the impossible choice
of where a cross-cutting question belongs.

## Reality check

No finite system can guarantee that an infinitely growing bank is remembered
forever with finite practice time. Waxon can make a meaningful conditional
promise instead:

> If the learner completes the bounded plan and the selected retention target
> is feasible within their available capacity, Waxon keeps modeled recall near
> that target and identifies knowledge whose retention is at risk.

When the promise is not feasible, the product must reduce new-item admission
and offer explicit choices to pause lower-priority material or increase
capacity. It must not silently change learner scope or hide the conflict behind
an ever-growing due count.

## Current evidence

The July 22, 2026 live audit found:

- 467 questions due now, compared with 22 reviews completed in the previous 14
  days.
- 302 concept tags for 467 questions; 301 are active and 48 questions use the
  `needs-concept-tagging` fallback.
- Only 156 of 467 questions appear in the embedding map.
- Near-duplicate active questions are visible in Library, including two prompts
  about the shape of unreduced `CrossEntropyLoss` output for the same tensor
  shapes.
- A due question can have no attempts, no reference answer, and no provenance,
  yet remains eligible for model grading.
- Generated source text is used while assigning a concept tag but is not stored
  as question provenance.
- New questions are written with `next_due` equal to the current time, so every
  intake batch immediately becomes review debt.
- The scheduler uses fixed score thresholds and interval multipliers. It does
  not estimate a question's difficulty, memory stability, retrievability, or a
  learner-selected retention target.
- A score of 8 is described as good recall but is always scheduled for the next
  day; only scores 9 and 10 can grow to longer intervals.
- Library can generate and search questions, manage tags, and flag questions,
  but it cannot directly create, edit, split, merge, pause, archive, or restore
  questions.
- Semantic deduplication rejects incoming candidates, but rejected duplicates
  cannot transfer provenance or learning history to an existing canonical
  question.
- The current map is an unlabeled projection. It visualizes embedded questions
  but does not answer whether a source or concept has adequate coverage.
- Stats counts all unflagged questions while Review also applies active-concept
  eligibility, producing inconsistent due totals.
- At 390 px, the authenticated header clips and overlaps navigation. The Review
  surface itself remains readable, but Library begins with a tall wall of
  management controls before the first question.

## What is already worth preserving

- Free-text retrieval is the right core interaction for conceptual AI/ML
  knowledge.
- The quiet editorial visual system makes long technical questions and formulas
  pleasant to read.
- Background evaluation lets the next question appear without waiting on an
  LLM response.
- Attempt history is append-only and user-scoped.
- Semantic search, embeddings, source-aware generation prompts, and duplicate
  judgment are useful foundations.
- Same-session retry avoids showing a failed item immediately again.
- The one-bank direction is correct.

## The redesigned flywheel

### 1. Capture

The main Library action becomes **Add knowledge**. It accepts:

- a direct question;
- pasted notes or text;
- a URL;
- one or more supported documents; or
- a short topic request such as “fill my gaps in vision transformers”.

Capture returns immediately. Parsing, chunking, embedding, source extraction,
and question preparation run as an observable background job. The source is
stored before enrichment, so a transient model failure never loses the input.

### 2. Build a coverage manifest

Before generating questions, Waxon extracts a compact set of recall targets
from the source. A target is a claim, distinction, formula, procedure,
derivation, prerequisite, or failure mode that the learner may need to recall.

Each target stores source evidence and one of these states:

- covered by an active question;
- covered but weak or ambiguous;
- missing;
- intentionally ignored; or
- blocked because the source is insufficient.

Coverage is therefore based on knowledge targets, not card count or an
embedding scatter plot. Existing questions can cover new sources without being
duplicated.

The manifest also keeps a visible section residual: every material source span
must map to a target, have an explicit exclusion and reason, or remain
unresolved. One extracted target never makes the rest of a section disappear,
and Waxon does not call a source fully audited while residual items remain.

### 3. Prepare question drafts

Generation works from uncovered or weak targets and produces drafts containing:

- the question;
- a full reference answer or scoring rubric;
- a concise display answer;
- cited source evidence;
- canonical concepts;
- expected answer mode;
- the exact recall target; and
- quality and duplicate confidence.

The quality gate checks atomicity, self-containment, ambiguity, answerability,
scope, unsupported claims, and overlap. A broad question is split before it
enters Review. High-confidence drafts may be accepted automatically according
to the learner's preference; ambiguous cases go to a small Inbox rather than
requiring manual approval of every generated item.

### 4. Admit questions into learning

Accepted questions enter the bank as **new**, not **due**. The daily planner
introduces a bounded number only when the projected review workload can sustain
the selected retention target.

Question state is explicit:

- draft;
- new;
- learning;
- review;
- paused;
- archived;
- suspended, with a visible quality, unsupported-evidence, or safety reason;
- superseded; or
- deleted, as a reversible logical tombstone shown only in Trash.

Library size and daily Review size are no longer the same thing.
Flagging or losing required support moves an otherwise active question into
the explicit non-active suspended state. It cannot silently disappear from
Review while still appearing active, and it returns only after the shared
quality/evidence gate passes.
Removing a question never silently erases its attempts, mastery evidence, or
shared provenance. Restoring a removal preserves the same question identity;
if removal waived a queued retry, restoration creates an ordinary
conservative-due presentation instead of reviving that retry. Source or
provenance erasure is a separate impact-previewed action.

### 5. Review and repair

The default session asks the learner for a time budget, or remembers one. It
shows a bounded plan such as “12 questions · about 8 minutes”, not the total
historical backlog.

After an answer, the evaluator returns separate signals:

- scheduling grade: forgot, hard recall, good recall, or easy recall;
- coverage of required rubric points;
- the learner's answer summary;
- the expected answer;
- demonstrated gaps or misconceptions; and
- evaluator confidence.

The UI keeps feedback brief by default but makes the evidence visible. The
learner can correct the grade. Scheduling uses the corrected grade while the
original model evaluation remains in the audit trail.

If an answer exposes a precise gap, Waxon creates a repair draft tied to the
attempt, source evidence, and parent question. It does not probe adjacent topics
or add a card merely because the model can invent one. A failed question can
return exactly once later in the same resumable session. It follows another
question, or waits at least ten minutes when no alternative exists; a failed
retry does not recurse into repeated same-day drilling.

### 6. Maintain continuously

The Library surfaces a small health queue ordered by impact:

- duplicates likely wasting review time;
- questions without a usable reference answer;
- broad questions that should be split;
- unsupported or source-less questions;
- conflicting reference answers;
- concepts with alias collisions; and
- sources with material uncovered targets.

Most maintenance is proposed as a one-click patch with a reversible preview.
The learner should curate exceptions, not administer the database.

## Scheduling redesign

Replace fixed interval multiplication with a memory model that estimates at
least per-question difficulty, stability, and current retrievability. Use a
learner-selected desired retention and fit parameters from review history when
enough evidence exists; use conservative defaults otherwise.

Keep the 0–10 score only if it is useful as explanatory feedback. Scheduling
should use a stable ordinal outcome rather than treating model-generated score
differences such as 8 versus 9 as precise measurements.

The planner should:

1. maintain indexed risk projections and score a bounded candidate set;
2. reserve capacity for failed-item repair;
3. select the smallest set needed to protect the retention target;
4. introduce new items only from remaining capacity;
5. disperse closely related sibling questions;
6. keep forecast and scheduling windows identical; launch with no inter-day
   shifting, then add bounded early load-balancing only after empirical
   validation; and
7. report material at risk when capacity is insufficient.

Waxon v2 launches on a clean database. There is no legacy question, attempt,
schedule, tag, source, or embedding migration and no compatibility layer. The
new scheduler begins from conservative default parameters and learns from v2
graded-presentation history. Build and validate the new schema in a fresh database before the
deployment is pointed at it; purge the old database only after the empty-bank
flow and production smoke tests pass.

## Question lifecycle rules

### Edit

- Wording-only edits create a candidate version. The old version remains active
  until the exact new prompt passes the same quality, evidence, and policy gate
  as activation and a version-bound bidirectional comparison proves the same
  target, retrieval direction, scope, cueing/difficulty, rubric, truth, and
  answer mode; only then does one atomic pointer switch retain learning state.
  Any difference or uncertainty uses conservative scope replacement.
- A changed recall target creates a new learning item; old attempts stay with
  the old target.
- The edit preview states which case Waxon believes applies.

### Merge duplicates

Merging is transactional and evidence-preserving:

1. choose or create the canonical wording and rubric;
2. union every source/span attribution and concept at the canonical target, then
   select a bounded exact support subset for every compatible prompt/target-
   meaning and answer/rubric evidence requirement in a new immutable canonical
   question version, without discarding overflow provenance;
3. preserve answer submissions and grades on their original question
   identifiers and redirect pending evaluations without duplicating effects;
4. replay the canonical question's combined chronological grade streams to
   rebuild memory state;
5. retain the removed identifiers as aliases or redirects; and
6. mark the redundant questions superseded instead of hard-deleting them.

Only prompts that test the same atomic recall target qualify. Similar topic,
different direction, a contrasting case, or a materially different reasoning
step does not.

An exact merge undo is safe only while the canonical component has had no
post-merge attempt or other mutation. After combined evidence, concepts, edits,
or learning events exist, separating the prompts creates conservative new
learning states while preserving the combined history; Waxon must not pretend
that later mastery can be losslessly divided.

### Split

Splitting retires the broad parent and creates atomic children linked by
`split_from`. Parent attempts are evidence that the area was practiced, but are
not copied as full mastery to every child. Children begin from a conservative
prior and earn their own state.

### Archive and restore

Archive removes an item from planning without deleting sources, versions, or
attempts. Restore folds the authoritative submission and grade history to
recover state.

## Concept organization

Do not expose raw model-generated tags as the primary ontology.

Concepts should have:

- one canonical name;
- aliases such as `cross-entropy` and `cross-entropy-loss`;
- optional broader and narrower relationships;
- a domain or subject when disambiguation is necessary; and
- merge history.

Automatic assignment should prefer an existing canonical concept. Creating a
new concept requires a stronger novelty threshold than assigning one. A broad
area such as `deep-learning` may be useful for navigation, but it should not be
attached redundantly to nearly every question when narrower concepts already
provide the relationship.

The learner normally browses sources, concepts, weak areas, or saved views. The
302-row tag manager becomes an exception-management surface.

## Domain support

The bank remains domain-neutral, but evaluation contracts should not assume
that every item behaves like an AI explanation.

Start with three answer modes:

- semantic free recall for explanations and derivations;
- exact or normalized recall for vocabulary, symbols, and short facts; and
- rubric recall for multi-point procedures or comparisons.

This supports most AI/ML content and basic Japanese vocabulary without separate
products. Audio prompts, handwriting, pronunciation scoring, and executable
code answers can be added later as answer modalities without changing bank,
source, concept, or scheduling ownership.

## Data ownership

Canonical knowledge, learner decisions, attempts, corrections, issued Review
sessions, and external-work intents must survive retries and rebuilds.
Embeddings, search documents, coverage assessments, memory projections, current
risk, and maintenance recommendations are derived and rebuildable.

The exact v2 data model, ownership boundaries, state transitions, and
verification gates live only in
[the canonical implementation plan](./implementation-plan.md).

## Delivery plan

The ordered milestones, dependencies, acceptance gates, performance budgets,
security checks, and clean cutover procedure live only in
[the canonical implementation plan](./implementation-plan.md). Keeping one
implementation roadmap prevents the rationale and execution plan from drifting.

## Product metrics

Primary:

- importance-weighted observed recall against the selected retention target;
- retained important knowledge per actual learner-minute;
- planned minutes versus actual minutes; and
- percentage of active items whose retention is at risk.

Quality:

- active questions with a grounded rubric and provenance;
- duplicate review time avoided;
- coverage targets that are covered, weak, missing, or intentionally ignored;
- evaluator override rate; and
- repair questions that improve later recall.

Guardrails:

- new items admitted per day;
- maintenance suggestions awaiting human judgment;
- generation acceptance and rollback rates;
- grading latency and failure rate; and
- inconsistent due counts across surfaces, which must remain zero.

Do not optimize total question count, total generated questions, raw tag count,
or daily streak length. Those can all improve while durable knowledge gets
worse.

## Recommended build order

Follow the critical path in
[the canonical implementation plan](./implementation-plan.md). With legacy data
intentionally discarded, no backlog recovery or historical schedule migration
is required.

The current UI should be evolved rather than replaced. Its Review surface is a
good visual foundation; the overhaul is primarily about state ownership,
admission control, and transparent product promises.
