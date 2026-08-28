# FSRS rating semantics and automatic grading

## Question

Should Waxon derive `Again`, `Hard`, `Good`, and `Easy` deterministically from the semantic gap between a free-text answer and its answer standard?

## Primary-source findings

- The official Anki review rubric makes the two axes explicit: `Again` is incorrect or unrecalled; `Hard` is correct but doubtful or slow; `Good` is correct with some mental effort; and `Easy` is correct with no mental effort. It places partial correctness at the pass/fail boundary according to whether the answer would fail in its real-world context, and explicitly permits binary `Again`/`Good` use for incorrect/correct answers. ([Anki manual, lines 56–77](https://github.com/ankitects/anki/blob/c03a747a190f3c04d40c39ec4dcbe6ec1b07c6b5/docs-site/manual/studying.mdx#L56-L77))
- FSRS's decisive boundary is recall failure versus recall success. Its official tutorial says `Again` is a fail, while `Hard`, `Good`, and `Easy` are passes; it warns that `Hard` means the learner recalled correctly, albeit with substantial hesitation and effort, and that using `Hard` for forgotten material produces unreasonably long intervals. ([FSRS tutorial, lines 33 and 107–112](https://github.com/open-spaced-repetition/fsrs4anki/blob/ff7c85cee735472d1c9cec0b9252d184087f74d8/docs/tutorial.md#L33), [lines 107–112](https://github.com/open-spaced-repetition/fsrs4anki/blob/ff7c85cee735472d1c9cec0b9252d184087f74d8/docs/tutorial.md#L107-L112))
- Within successful recall, the rating represents experienced retrieval ease, not answer completeness or a desired interval. The tutorial tells learners to rate only how easy the card was to answer and reserves `Hard` for recall after substantial hesitation. The optimizer's input schema likewise calls the rating subjective and based on how well the learner believes they remembered. ([FSRS tutorial, lines 239–245](https://github.com/open-spaced-repetition/fsrs4anki/blob/ff7c85cee735472d1c9cec0b9252d184087f74d8/docs/tutorial.md#L239-L245), [FSRS optimizer schema, lines 15–21](https://github.com/open-spaced-repetition/fsrs-optimizer/blob/ac2a82d222c4ea809985236e2a52e058da524c40/README.md#L15-L21))
- FSRS supports a binary habit: the official integration table maps Pass to `Good` and Fail to `Again`, and the tutorial says using mostly `Again` and `Good` works and may be slightly more accurate than frequent four-button use. The latter is an official project claim, but the tutorial does not link its underlying analysis, so it is supporting rather than independently auditable evidence. ([FSRS4Anki README, lines 63–68](https://github.com/open-spaced-repetition/fsrs4anki/blob/ff7c85cee735472d1c9cec0b9252d184087f74d8/README.md#L63-L68), [FSRS tutorial, lines 229–235](https://github.com/open-spaced-repetition/fsrs4anki/blob/ff7c85cee735472d1c9cec0b9252d184087f74d8/docs/tutorial.md#L229-L235))
- The four values are not cosmetic labels. FSRS uses the numeric grade to update memory difficulty and stability, and it follows separate successful- and failed-review paths. Systematic overuse of `Easy` or misuse of `Hard` therefore changes later scheduling and personalized parameters. ([official algorithm](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm), [FSRS tutorial, lines 235–245](https://github.com/open-spaced-repetition/fsrs4anki/blob/ff7c85cee735472d1c9cec0b9252d184087f74d8/docs/tutorial.md#L235-L245))

## Assessment of gap-to-grade derivation

The proposed mapping `no gap → Easy`, `minor gap → Good`, `major gap → Hard`, `core failure → Again` has one strong idea and one fundamental semantic error.

The strong idea is to make contradictory evaluations unrepresentable: one structured assessment should own the recovered points and demonstrated gaps, with feedback derived from that assessment. This improves explainability, persistence consistency, validation, and regression testing.

The error is treating FSRS's four ratings as four levels of semantic correctness:

| Mapping | Benefit | Problem under FSRS semantics |
| --- | --- | --- |
| No semantic gap → `Easy` | Deterministic and simple | A fully correct answer may have required prolonged, effortful recall; content alone cannot justify `Easy`, so this can overextend intervals. |
| Minor gap → `Good` | Keeps a mostly correct answer as a pass | Whether an omission is compatible with successful recall is a product rubric decision, not an FSRS definition. |
| Major gap → `Hard` | Preserves four-way granularity | `Hard` is a successful recall signal, not a near-failure signal; this is exactly the category error the FSRS tutorial warns against. |
| Core failure → `Again` | Matches failure semantics | Sound, provided the answer standard defines the failed recall target clearly. |

It would also create false precision. A text evaluator can observe what the learner wrote, but normally cannot observe whether correct retrieval was immediate, hesitant, reconstructed, or mentally effortless. Response duration is at most a noisy proxy because typing length, interruptions, accessibility, and answer length confound it; notably, the optimizer schema stores review duration separately from the subjective rating. ([FSRS optimizer schema, lines 15–32](https://github.com/open-spaced-repetition/fsrs-optimizer/blob/ac2a82d222c4ea809985236e2a52e058da524c40/README.md#L15-L32))

## Better design

Keep the structured, invariant-preserving semantic assessment, but do not derive all four FSRS ratings from it:

1. Determine a defensible binary scheduling outcome from answer content: failed recall → `Again`; successful recall → `Good`.
2. Derive the expected answer, recovered points, demonstrated gaps, and feedback from that same assessment so persistence cannot say both “no gap” and “a precision omission.”
3. Treat `Hard` and `Easy` as learner-supplied retrieval-experience corrections, not model claims about content. The original automated evaluation remains immutable; the latest effective learner-selected grade drives scheduling, consistent with Waxon's existing correction requirement.
4. If Waxon later predicts retrieval difficulty from additional signals, validate that prediction separately against learner ratings and calibration outcomes before allowing it to alter scheduling. Do not silently equate response time or wording with effort.

A compact boundary could be:

```ts
type SemanticAssessment =
  | { recall: "failed"; issues: [Issue, ...Issue[]] }
  | { recall: "successful"; issues: Issue[] };

const automatedGrade = assessment.recall === "failed" ? "again" : "good";
const effectiveGrade = learnerCorrection ?? automatedGrade;
```

This design gives the automatic grader the two distinctions it can defend from answer content, preserves all four FSRS signals when the learner has the missing experiential evidence, and retains the valuable consistency invariants from the original proposal.

## Conclusion

The original solution is directionally right about a single authoritative assessment and deterministic invariants, but its four-way derivation is not aligned with FSRS. The safer default is automated `Again`/`Good`, with learner correction to `Hard`/`Easy`; semantic gap severity should explain correctness, not impersonate retrieval difficulty. Applied to the motivating screenshot, “no demonstrated gap” establishes a pass, not effortless recall, so `Good` is the defensible automatic default and `Easy` requires learner evidence about effort.
