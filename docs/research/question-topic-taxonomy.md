# Question topics: a scalable controlled vocabulary

## Research question

How should Waxon categorize a very large private question bank when questions may cross subject boundaries, topic assignment should be automatic, the vocabulary should remain canonical, question creation must never depend on enrichment, and question content is immutable even though classification may evolve?

## Waxon constraints used

- Each learner has one private Library rather than separate decks.
- A question may concern multiple subjects.
- A valid question must be storable even when no topic is known and without waiting for enrichment or model generation.
- Prompt and Answer Standard are immutable; replacing them creates a new question, but classification metadata may evolve independently.
- Topic handling must remain generic rather than introducing subject-specific product behavior.

## Primary-source findings

### Model concepts, not tag strings

- W3C SKOS is deliberately a semi-formal knowledge-organization model for thesauri and classification schemes. A `skos:Concept` is a unit of thought, while a `skos:ConceptScheme` aggregates concepts and their semantic links. This is a better fit than treating every spelling as a distinct tag or trying to build a reasoning-heavy formal ontology. ([SKOS Reference, §§3–4](https://www.w3.org/TR/skos-reference/#concepts), [concept schemes](https://www.w3.org/TR/skos-reference/#schemes))
- SKOS gives a concept a preferred label, alternative labels for synonyms/abbreviations, and hidden labels useful for misspellings and text matching. It permits at most one preferred label per language; the Primer recommends that preferred labels also be unique within a scheme for a language. ([SKOS Reference, §5.4](https://www.w3.org/TR/skos-reference/#labels), [SKOS Primer, §§2.2.1–2.2.3](https://www.w3.org/TR/skos-primer/#seclabel))
- A concept's meaning is not exhausted by its display name. SKOS provides definitions and scope notes, plus direct `broader`/`narrower` hierarchical links and symmetric, non-hierarchical `related` links. Direct hierarchy can be transitively expanded at query time; SKOS explicitly distinguishes that closure from asserted direct links. ([SKOS Reference, §§7–8](https://www.w3.org/TR/skos-reference/#notes), [hierarchical and associative relations](https://www.w3.org/TR/skos-reference/#semantic-relations))
- Polyhierarchy is supported: the SKOS Primer notes that one concept can have several broader concepts. This means a boundary-crossing concept need not be forced into a single tree. ([SKOS Primer, §2.3.1](https://www.w3.org/TR/skos-primer/#sechierarchy))

**Implication for Waxon:** store an opaque, stable `topicId` as the identity. Treat `Deep learning`, aliases such as `DL`, its scope note, and its parent links as mutable vocabulary metadata. A question points to one or more concept IDs, never to ungoverned strings. Renaming, moving, merging, or deprecating a topic therefore does not modify the question.

### Use postcoordinated topics and facets, not enclosed categories

- ANSI/NISO Z39.19 defines postcoordination as combining separate terms at search time. It specifically says computerized retrieval often benefits from indexing a compound subject with separate terms that a searcher can combine as needed. ([ANSI/NISO Z39.19, definition and §7.3](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=19), [compound-concept guidance](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=49))
- NISO identifies facet analysis as especially useful for interdisciplinary material, emerging fields, and cases requiring multiple hierarchies; for hundreds or thousands of vocabulary terms, facets can supply broad groupings without making every item live in one rigid hierarchy. It also treats facets as structural metadata and gives `Topic` as one possible facet of a content object. ([ANSI/NISO Z39.19, §5.3.4](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=25))
- A Library of Congress/IFLA case study illustrates the discipline needed for true facets: vocabularies have distinct scopes, and individual terms describe one aspect rather than precombining values such as a demographic group plus an occupation. ([Library of Congress paper in the IFLA repository, “Structure: Facets,” pp. 5–6](https://repository.ifla.org/bitstreams/c20a84ea-13a7-4b9b-a028-4e4a1c43a9be/download#page=5))

**Implication for Waxon:** `Topic` should initially be one composable, multi-valued facet. Assign the most specific applicable concepts, and let filtering on `Deep learning` include questions assigned to its descendants. A question spanning subjects gets multiple direct assignments, combined with `OR` or `AND` in search. Do not mix non-subject properties such as lifecycle state, difficulty, source, or “needs work” into the topic vocabulary; those are separate facets or product metadata. Do not materialize ancestor tags on every question, because hierarchy changes would create unnecessary rewrites and inconsistencies.

### Canonical vocabularies require governance and history

- NISO says vocabulary control depends on defining scope, linking synonyms, and distinguishing ambiguous homographs. It recommends choosing terms using the language of the indexed material, users, and organization (“literary, user, and organizational warrant”). ([ANSI/NISO Z39.19, §§1.2 and 5.3.5](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=12), [warrant](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=27))
- Large vocabularies are living systems: NISO notes that terminology and concepts change, recommends periodic testing, and defines a candidate-term state for proposals that have not completed acceptance. It also recommends one record per admitted term containing its scope, aliases, broader/narrower/related links, and change history. ([ANSI/NISO Z39.19, §§2.5–2.6](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=14), [§§11.1.4–11.1.6](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=104))
- NISO recommends preserving dates, previous forms, replacement reasons, and superseding cross-references rather than silently erasing vocabulary changes. ([ANSI/NISO Z39.19, §11.3.2.2](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=108))

**Implication for Waxon:** use one governed canonical concept scheme, with learner-private question-to-topic assignments. New free-text terms should search preferred and alternative labels first; an unmatched term becomes a private candidate proposal, not an immediately canonical global tag. Approval can create a concept, attach an alias to an existing concept, or reject it. Concepts need `active`, `deprecated`, and `merged` vocabulary states, plus `replacedBy` and an audit log. A merge redirects assignments to the surviving stable concept while retaining historical provenance. No private question content should be exposed as evidence for a global proposal.

### Automation should classify into the scheme and remain correctable

- The European Commission's JRC EuroVoc Indexer is a real multi-label controlled-vocabulary classifier: it learns from manually labeled data, ranks existing EuroVoc descriptors, lets users view and amend assignments, and can be retrained on those collections. It can operate interactively or fully automatically. ([JRC EuroVoc Indexer JEX](https://publications.jrc.ec.europa.eu/repository/handle/JRC67293))
- The U.S. National Library of Medicine now uses a neural model trained on millions of manually indexed citations to select MeSH descriptors, but human curators still review selected automatically indexed sets and add, delete, or correct descriptors. ([NLM, “Use of MeSH in Indexing”](https://www.nlm.nih.gov/mesh/intro_indexing.html))
- Automatic multi-label indexing does not have a perfectly objective gold standard. In an NLM study, professional review judged 70% of predictions counted as false positives against existing MeSH indexing to be acceptable. This supports retaining human correction and measuring more than exact agreement with historical labels. ([Rae et al., *Automatic MeSH Indexing*, abstract](https://pubmed.ncbi.nlm.nih.gov/33936479/))
- NISO permits machines to identify candidate terms and compare them with the existing vocabulary, but reserves admission and semantic relationship decisions for verification; it recommends marking candidates until approval. ([ANSI/NISO Z39.19, §§11.1.3–11.1.6](https://groups.niso.org/higherlogic/ws/public/download/12591/z39-19-2005r2010.pdf#page=103))

**Implication for Waxon:** the classifier should be a non-blocking, multi-label enrichment step that may select only active canonical `topicId`s. It should never mint canonical concepts from model text. Store its suggestions and provenance separately, allow the learner to accept, remove, or add topics, and route unknown concepts to the candidate workflow. Learner corrections are useful feedback, but should remain private and should not train a cross-learner model without a separately justified privacy design.

## Recommended domain shape

```text
TopicScheme
  id, version

TopicConcept
  id, preferredLabel, alternativeLabels[], scopeNote
  state: active | deprecated | merged
  replacedBy?, createdAt, updatedAt

TopicRelation
  subjectTopicId, relation: broader | related, objectTopicId

TopicCandidate
  id, ownerLearnerId, proposedLabel, status: pending | resolved | rejected
  resolvedTopicId?, createdAt, decidedAt?

QuestionTopicAssignment
  questionId, topicId
  state: suggested | accepted | rejected
  origin: learner | classifier
  confidence?, classifierVersion?, createdAt, decidedAt?
```

Important invariants:

- `QuestionTopicAssignment` is many-to-many and is outside the immutable question record.
- One active preferred label exists per language; aliases resolve to the same concept ID.
- `broader` stores only direct links; ancestor/descendant closure is computed for filtering.
- `related` is for discovery, not implicit inclusion in a topic filter.
- A concept cannot be both hierarchically above and merely related to the same concept; cycles and duplicate preferred labels are rejected.
- Classifier output records its model/version and confidence so assignments can be audited and selectively recomputed without changing questions.
- Candidate terms remain scoped to their proposing learner until governance resolves them, so canonical vocabulary maintenance does not disclose private Library content.
- Deleting a question-topic assignment does not delete the concept or the question; deprecating a concept does not destroy assignment history.

## Suggested automatic-classification lifecycle

1. Store the structurally valid question immediately with zero topics.
2. Asynchronously rank active canonical concepts from the immutable Prompt and Answer Standard.
3. Persist the top few candidates with scores and classifier version. Initially show them as suggestions; only auto-accept after per-topic threshold calibration demonstrates acceptable precision.
4. Let the learner confirm, reject, or search/add another canonical topic. Record the decision rather than overwriting the model event.
5. If no concept fits, let the learner continue normally and optionally submit a candidate label; topic absence never flags or blocks the question.
6. Evaluate by topic and hierarchy depth using precision, recall, correction rate, coverage, and abstention rate. Sample accepted high-confidence assignments as well as uncertain ones for review, because confidence alone does not reveal systematic omissions.
7. Retrain or recalibrate from reviewed assignments only under the applicable learner-data privacy policy; publish a new classifier version and recompute assignments as enrichment, not as question edits.

## Practical rollout

1. **Phase 1 — controlled topics:** stable concept IDs, preferred/alternative labels, scope notes, many-to-many manual assignment, and descendant-aware filtering.
2. **Phase 2 — lightweight thesaurus:** broader and related links, candidate/merge/deprecation workflow, history, and vocabulary-quality reports for duplicates, cycles, orphans, and unused concepts.
3. **Phase 3 — assisted classification:** top-k suggestions from existing concepts with accept/reject UX and assignment provenance.
4. **Phase 4 — selective automation:** calibrated per-topic thresholds, safe abstention, learner correction, periodic audits, and versioned reclassification.

## Conclusion

Use “tags” as the learner-facing interaction but implement them as assignments to a controlled SKOS-like topic scheme. The scalable unit is a stable concept with labels and semantic relationships, not a deck and not a raw string. Multiple direct concepts plus hierarchy-aware filtering handle cross-disciplinary questions; candidate governance keeps the vocabulary canonical; and a correctable, versioned classifier makes categorization automatic without making question creation or question identity depend on it.
