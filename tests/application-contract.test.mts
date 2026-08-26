import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_CONTRACT_TEST_DATABASE_URL,
  withApplicationContract,
} from "./support/application-contract-harness.mts";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";

test(
  "application contract",
  {
    skip: APPLICATION_CONTRACT_TEST_DATABASE_URL
      ? false
      : "APPLICATION_CONTRACT_TEST_DATABASE_URL is not set",
  },
  async (suite) => {
    await withApplicationContract(async ({
      clock,
      databaseCatalog,
      provisionLearner,
      semanticValidation,
      setQuestionLifecycle,
    }) => {
      await suite.test(
        "the durable catalog has no plan, session, retry, capacity, or importance storage",
        async () => {
          const catalog = await databaseCatalog();
          for (const retiredTable of [
            "review_sessions",
            "review_session_items",
            "retry_obligations",
          ]) {
            assert.equal(catalog.tables.includes(retiredTable), false);
          }
          for (const retiredColumn of [
            "daily_minutes",
            "desired_retention",
            "new_items_per_day",
          ]) {
            assert.equal(
              catalog.learnerSettingColumns.includes(retiredColumn),
              false,
            );
          }
          assert.equal(catalog.questionColumns.includes("importance"), false);
          assert.equal(catalog.questionColumns.includes("creation_order"), true);
        },
      );

      await suite.test(
        "semantic validation outcomes are deterministic without defining Question behavior",
        async () => {
          for (const outcome of [
            "pass",
            "fail",
            "inconclusive",
            "unavailable",
          ] as const) {
            semanticValidation.setOutcome(outcome);
            assert.deepEqual(await semanticValidation.validateQuestion(), {
              passes: outcome === "pass",
              reasons:
                outcome === "pass"
                  ? []
                  : [`Deterministic semantic validation ${outcome}.`],
            });
          }
          semanticValidation.setOutcome("pass");
        },
      );

      await suite.test(
        "direct and Authorized MCP Client operations preserve Learner isolation",
        async () => {
          const learnerA = await provisionLearner("Contract learner A");
          const learnerB = await provisionLearner("Contract learner B");

          const added = await learnerA.direct.questionBank.add({
            idempotencyKey: "direct-add",
            items: [
              {
                prompt:
                  "What boundary keeps a Learner's Question Bank private?",
                referenceAnswer:
                  "The application contract scopes every operation to one Learner.",
              },
            ],
          });

          assert.equal(added.results[0]?.status, "created");
          assert.equal(added.results[0]?.lifecycle, "active");
          assert.deepEqual(
            (
              await learnerA.authorizedMcpClient.questionBank.list()
            ).questions.map((question) => question.id),
            [added.results[0]?.id],
          );
          assert.deepEqual(
            (
              await learnerB.authorizedMcpClient.questionBank.list()
            ).questions,
            [],
          );
          await assert.rejects(
            learnerB.direct.questionBank.archive(added.results[0]?.id ?? ""),
            /Question not found/u,
          );
          assert.deepEqual(
            (await learnerA.direct.questionBank.list()).questions.map(
              (question) => question.id,
            ),
            [added.results[0]?.id],
          );
        },
      );

      await suite.test(
        "Question Bank mutations roll back atomically when one item conflicts",
        async () => {
          const learner = await provisionLearner(
            "Transactional contract learner",
          );
          await learner.authorizedMcpClient.questionBank.add({
            idempotencyKey: "retained-question",
            items: [
              {
                prompt: "What does an application transaction preserve?",
                referenceAnswer:
                  "It preserves all-or-nothing mutation behavior.",
              },
            ],
          });

          await assert.rejects(
            learner.direct.questionBank.add({
              idempotencyKey: "rolled-back-batch",
              items: [
                {
                  prompt:
                    "Which Question should roll back with its failed batch?",
                  referenceAnswer:
                    "The first Question in the failed batch.",
                },
                {
                  prompt: "What does an application transaction preserve?",
                  referenceAnswer: "A conflicting Answer Standard.",
                },
              ],
            }),
            /already exists with a different Answer Standard/u,
          );

          assert.deepEqual(
            (await learner.direct.questionBank.list()).questions.map(
              (question) => question.prompt,
            ),
            ["What does an application transaction preserve?"],
          );
        },
      );

      await suite.test(
        "every new Active Question enters a reconstructed Review Queue immediately",
        async () => {
          const learner = await provisionLearner("Live queue learner");
          const items = Array.from({ length: 80 }, (_, index) => ({
            prompt: `Which stable creation position belongs to Question ${String(index + 1).padStart(2, "0")}?`,
            referenceAnswer: `Position ${index + 1}.`,
          }));
          const firstBatch = await learner.direct.questionBank.add({
            idempotencyKey: "large-live-queue-batch-one",
            items: items.slice(0, 50),
          });
          const secondBatch = await learner.direct.questionBank.add({
            idempotencyKey: "large-live-queue-batch-two",
            items: items.slice(50),
          });
          const added = {
            results: [...firstBatch.results, ...secondBatch.results],
          };

          assert.equal(added.results.length, 80);
          assert.equal(
            added.results.every((result) => result.lifecycle === "active"),
            true,
          );

          const opened = await learner.direct.review.open();
          assert.equal("session" in opened, false);
          assert.equal(opened.summary.queueRemaining, 80);
          assert.equal(opened.question?.questionId, added.results[0]?.id);

          const reopened = await learner.direct.review.open();
          assert.deepEqual(reopened, opened);

          const observedOrder: string[] = [];
          for (let index = 0; index < added.results.length; index += 1) {
            const current = await learner.direct.review.open();
            observedOrder.push(current.question?.questionId ?? "");
            const pending = await learner.direct.review.submitAnswer({
              questionVersionId:
                current.question?.questionVersionId ?? "",
              answer: `Position ${index + 1}.`,
              idempotencyKey: `large-live-queue-answer-${index}`,
            });
            await learner.direct.review.evaluatePending(pending.submissionId);
          }
          assert.deepEqual(
            observedOrder,
            added.results.map((result) => result.id),
          );
          assert.equal((await learner.direct.review.open()).question, null);
        },
      );

      await suite.test(
        "Review includes due and unanswered Active Questions in exact deterministic order",
        async () => {
          const learner = await provisionLearner("Ordered queue learner");

          async function addOne(key: string, prompt: string) {
            const added = await learner.direct.questionBank.add({
              idempotencyKey: key,
              items: [{ prompt, referenceAnswer: `${prompt} Answer Standard` }],
            });
            return added.results[0]?.id ?? "";
          }

          async function answerOnlyQuestion(key: string) {
            const opened = await learner.direct.review.open();
            assert.equal(opened.summary.queueRemaining, 1);
            const pending = await learner.direct.review.submitAnswer({
              questionVersionId: opened.question?.questionVersionId ?? "",
              answer: "Deterministic successful recall.",
              idempotencyKey: key,
            });
            return learner.direct.review.evaluatePending(pending.submissionId);
          }

          clock.set("2030-08-17T10:00:00.000Z");
          const oldestDue = await addOne(
            "oldest-due-question",
            "Which Question was scheduled first?",
          );
          await answerOnlyQuestion("oldest-due-answer");
          await learner.direct.questionBank.archive(oldestDue);

          clock.set("2030-08-18T10:00:00.000Z");
          const newerDue = await addOne(
            "newer-due-question",
            "Which Question was scheduled second?",
          );
          await answerOnlyQuestion("newer-due-answer");
          await learner.direct.questionBank.archive(newerDue);

          clock.set("2030-08-20T10:00:00.000Z");
          const future = await addOne(
            "future-question",
            "Which Question remains scheduled in the future?",
          );
          await answerOnlyQuestion("future-answer");

          const unanswered = await learner.direct.questionBank.add({
            idempotencyKey: "ordered-unanswered-batch",
            items: [
              {
                prompt: "Which unanswered Question was created first?",
                referenceAnswer: "The first unanswered Question.",
              },
              {
                prompt: "Which unanswered Question was created second?",
                referenceAnswer: "The second unanswered Question.",
              },
            ],
          });
          const archived = await addOne(
            "archived-queue-question",
            "Which Archived Question stays outside Review?",
          );
          await learner.direct.questionBank.archive(archived);
          const flagged = await addOne(
            "flagged-queue-question",
            "Which Flagged Question stays outside Review?",
          );
          await setQuestionLifecycle(learner.id, flagged, "flagged");
          await learner.direct.questionBank.restore(oldestDue);
          await learner.direct.questionBank.restore(newerDue);

          const expectedOrder = [
            oldestDue,
            newerDue,
            unanswered.results[0]?.id,
            unanswered.results[1]?.id,
          ];
          const observed: Array<string | undefined> = [];
          for (let index = 0; index < expectedOrder.length; index += 1) {
            const opened = await learner.direct.review.open();
            observed.push(opened.question?.questionId);
            const pending = await learner.direct.review.submitAnswer({
              questionVersionId: opened.question?.questionVersionId ?? "",
              answer: "Deterministic successful recall.",
              idempotencyKey: `ordered-queue-answer-${index}`,
            });
            await learner.direct.review.evaluatePending(pending.submissionId);
          }

          assert.deepEqual(observed, expectedOrder);
          assert.equal((await learner.direct.review.open()).question, null);
          assert.equal(
            (await learner.direct.questionBank.list()).questions.find(
              (question) => question.id === future,
            )?.dueAt !== null,
            true,
          );
        },
      );

      await suite.test(
        "unanswered status breaks equal Local Day ties before stable creation order",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const learner = await provisionLearner("Equal-day ordering learner");
          const answered = await learner.direct.questionBank.add({
            idempotencyKey: "equal-day-answered-question",
            items: [
              {
                prompt: "Which answered Question is due on the same Local Day?",
                referenceAnswer: "The previously answered Question.",
              },
            ],
          });
          const first = await learner.direct.review.open();
          const pending = await learner.direct.review.submitAnswer({
            questionVersionId: first.question?.questionVersionId ?? "",
            answer: "The previously answered Question.",
            idempotencyKey: "equal-day-answered-response",
          });
          await learner.direct.review.evaluatePending(pending.submissionId);

          clock.set("2030-08-21T10:00:00.000Z");
          const unanswered = await learner.direct.questionBank.add({
            idempotencyKey: "equal-day-unanswered-questions",
            items: [
              {
                prompt: "Which equal-day unanswered Question was created first?",
                referenceAnswer: "The first unanswered Question.",
              },
              {
                prompt: "Which equal-day unanswered Question was created second?",
                referenceAnswer: "The second unanswered Question.",
              },
            ],
          });

          const expected = [
            unanswered.results[0]?.id,
            unanswered.results[1]?.id,
            answered.results[0]?.id,
          ];
          const observed: Array<string | undefined> = [];
          for (let index = 0; index < expected.length; index += 1) {
            const opened = await learner.direct.review.open();
            observed.push(opened.question?.questionId);
            const response = await learner.direct.review.submitAnswer({
              questionVersionId:
                opened.question?.questionVersionId ?? "",
              answer: "Deterministic successful recall.",
              idempotencyKey: `equal-day-order-response-${index}`,
            });
            await learner.direct.review.evaluatePending(response.submissionId);
          }
          assert.deepEqual(observed, expected);
        },
      );

      await suite.test(
        "successful free-text recall exposes corrective feedback and reconstructs future scheduling",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const learner = await provisionLearner("Successful recall learner");
          const otherLearner = await provisionLearner("Other Review learner");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "successful-recall-question",
            items: [
              {
                prompt: "What reconstructs the live Review Queue?",
                referenceAnswer:
                  "Active Questions, the Learner's Local Day, and immutable Learning Evidence.",
              },
            ],
          });
          const questionId = added.results[0]?.id ?? "";
          const opened = await learner.direct.review.open();

          await assert.rejects(
            otherLearner.direct.review.submitAnswer({
              questionVersionId: opened.question?.questionVersionId ?? "",
              answer: "A cross-Learner answer must fail.",
              idempotencyKey: "cross-learner-review-answer",
            }),
            /no longer available in Review/u,
          );

          const answer = {
            questionVersionId: opened.question?.questionVersionId ?? "",
            answer:
              "It is derived from Active Questions, Local Day, and Learning Evidence.",
            idempotencyKey: "successful-review-answer",
          };
          const pending = await learner.direct.review.submitAnswer(answer);
          const replayed = await learner.direct.review.submitAnswer(answer);
          assert.equal(replayed.submissionId, pending.submissionId);
          const reopenedWhilePending = await learner.direct.review.open();
          assert.equal(reopenedWhilePending.question, null);
          assert.equal(reopenedWhilePending.waitingOnEvaluation, true);
          assert.equal(
            reopenedWhilePending.recentAnswers[0]?.evaluation.status,
            "pending",
          );

          const completed = await learner.direct.review.evaluatePending(
            pending.submissionId,
          );
          assert.deepEqual(
            {
              status: completed.status,
              grade: completed.grade,
              expectedAnswer: completed.expectedAnswer,
              demonstratedGap: completed.demonstratedGap,
              nextDueOn: completed.nextDueOn,
              canSelfGrade: completed.canSelfGrade,
            },
            {
              status: "complete",
              grade: "good",
              expectedAnswer:
                "Active Questions, the Learner's Local Day, and immutable Learning Evidence.",
              demonstratedGap:
                "No gap was demonstrated by this successful recall.",
              nextDueOn: "2030-08-21",
              canSelfGrade: false,
            },
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(questionId),
            {
              learnerAnswers: 1,
              evaluations: 1,
              gradeEvents: 1,
              dueAt: "2030-08-21T00:00:00.000Z",
            },
          );

          const closedOutcome = await learner.direct.review.open();
          assert.equal(closedOutcome.question, null);
          assert.deepEqual(await learner.direct.review.open(), closedOutcome);
          assert.equal(closedOutcome.summary.nextScheduledOn, "2030-08-21");
          assert.deepEqual(
            {
              prompt: closedOutcome.recentAnswers[0]?.prompt,
              answer: closedOutcome.recentAnswers[0]?.answer,
              expectedAnswer:
                closedOutcome.recentAnswers[0]?.evaluation.expectedAnswer,
              demonstratedGap:
                closedOutcome.recentAnswers[0]?.evaluation.demonstratedGap,
              nextDueOn:
                closedOutcome.recentAnswers[0]?.evaluation.nextDueOn,
            },
            {
              prompt: "What reconstructs the live Review Queue?",
              answer:
                "It is derived from Active Questions, Local Day, and Learning Evidence.",
              expectedAnswer:
                "Active Questions, the Learner's Local Day, and immutable Learning Evidence.",
              demonstratedGap:
                "No gap was demonstrated by this successful recall.",
              nextDueOn: "2030-08-21",
            },
          );

          clock.set("2030-08-21T10:00:00.000Z");
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            questionId,
          );
        },
      );

      await suite.test(
        "persisted IANA timezone edits recompute Review membership from Local Day",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const learner = await provisionLearner("Timezone learner");
          const otherLearner = await provisionLearner("Other timezone learner");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "timezone-boundary-question",
            items: [
              {
                prompt: "Which date boundary controls Review membership?",
                referenceAnswer: "The Learner's persisted IANA Local Day.",
              },
            ],
          });
          const opened = await learner.direct.review.open();
          const pending = await learner.direct.review.submitAnswer({
            questionVersionId: opened.question?.questionVersionId ?? "",
            answer: "The persisted IANA Local Day.",
            idempotencyKey: "timezone-boundary-answer",
          });
          assert.equal(
            (await learner.direct.review.evaluatePending(pending.submissionId))
              .nextDueOn,
            "2030-08-21",
          );

          clock.set("2030-08-20T23:30:00.000Z");
          assert.deepEqual(await learner.direct.settings.get(), {
            timezone: null,
          });
          assert.equal((await learner.direct.review.open()).question, null);

          assert.deepEqual(
            await learner.direct.settings.updateTimezone(
              "America/Los_Angeles",
            ),
            { timezone: "America/Los_Angeles" },
          );
          const westward = await learner.direct.review.open();
          assert.equal(westward.localDay, "2030-08-20");
          assert.equal(westward.question, null);

          await learner.direct.settings.updateTimezone("Europe/Lisbon");
          const eastward = await learner.direct.review.open();
          assert.equal(eastward.localDay, "2030-08-21");
          assert.equal(eastward.question?.questionId, added.results[0]?.id);

          await assert.rejects(
            learner.direct.settings.updateTimezone("Not/A_Timezone"),
            /valid IANA timezone/u,
          );
          assert.deepEqual(await learner.direct.settings.get(), {
            timezone: "Europe/Lisbon",
          });
          assert.deepEqual(await otherLearner.direct.settings.get(), {
            timezone: null,
          });
        },
      );

      await suite.test(
        "Question Bank add, search, archive, and restore use canonical lifecycle states",
        async () => {
          const learner = await provisionLearner("Lifecycle contract learner");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "canonical-lifecycle-question",
            items: [
              {
                prompt:
                  "How are exact normalized-Prompt duplicates retained?",
                referenceAnswer:
                  "As one Question Bank entry across every lifecycle state.",
              },
            ],
          });
          const questionId = added.results[0]?.id ?? "";
          assert.equal(added.results[0]?.lifecycle, "active");

          await learner.direct.questionBank.archive(questionId);
          const duplicate = await learner.direct.questionBank.add({
            idempotencyKey: "archived-normalized-duplicate",
            items: [
              {
                prompt:
                  "  HOW ARE EXACT NORMALIZED-PROMPT DUPLICATES RETAINED?  ",
                referenceAnswer:
                  "As one Question Bank entry across every lifecycle state.",
              },
            ],
          });
          assert.deepEqual(duplicate.results, [
            { id: questionId, status: "existing", lifecycle: "archived" },
          ]);

          const archived = await learner.direct.questionBank.list({
            lifecycle: "archived",
            search: "How are exact normalized-Prompt duplicates retained?",
          });
          assert.deepEqual(Object.keys(archived.counts).sort(), [
            "active",
            "archived",
            "flagged",
          ]);
          assert.deepEqual(
            archived.questions.map((question) => question.id),
            [questionId],
          );
          assert.deepEqual(
            (await learner.direct.questionBank.list({ lifecycle: "active" }))
              .questions,
            [],
          );

          await learner.direct.questionBank.restore(questionId);
          assert.deepEqual(
            (
              await learner.direct.questionBank.list({ lifecycle: "active" })
            ).questions.map((question) => ({
              id: question.id,
              lifecycle: question.lifecycle,
            })),
            [{ id: questionId, lifecycle: "active" }],
          );
        },
      );

      await suite.test(
        "immutable replacement archives the original and resets the new Question",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const learner = await provisionLearner("Evidence contract learner");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "evidence-question",
            items: [
              {
                prompt: "What must remain immutable after Question mutation?",
                referenceAnswer:
                  "Learner Answers, evaluations, and Answer Grade history.",
              },
            ],
          });
          const questionId = added.results[0]?.id ?? "";
          const review = await learner.direct.review.open();
          assert.equal(review.question?.questionId, questionId);

          const pending = await learner.direct.review.submitAnswer({
            questionVersionId: review.question?.questionVersionId ?? "",
            answer: "Answers, evaluations, and grades stay immutable.",
            idempotencyKey: "immutable-evidence-answer",
          });
          assert.equal(pending.status, "pending");
          const completed = await learner.direct.review.evaluatePending(
            pending.submissionId,
          );
          assert.deepEqual(
            {
              status: completed.status,
              grade: completed.grade,
              feedback: completed.feedback,
              expectedAnswer: completed.expectedAnswer,
              demonstratedGap: completed.demonstratedGap,
            },
            {
              status: "complete",
              grade: "good",
              feedback: "The deterministic evaluator accepted the answer.",
              expectedAnswer:
                "Learner Answers, evaluations, and Answer Grade history.",
              demonstratedGap:
                "No gap was demonstrated by this successful recall.",
            },
          );
          assert.equal(completed.nextDueOn, "2030-08-21");

          const evidenceBefore = await learner.direct.questionBank.evidence(
            questionId,
          );
          assert.deepEqual(evidenceBefore, {
            learnerAnswers: 1,
            evaluations: 1,
            gradeEvents: 1,
            dueAt: "2030-08-21T00:00:00.000Z",
          });

          const answerReplacement = await learner.direct.questionBank.replace({
            questionId,
            prompt: "What must remain immutable after Question mutation?",
            referenceAnswer:
              "Every Learner Answer, evaluation, grade event, and derived history.",
          });
          assert.notEqual(answerReplacement.questionId, questionId);
          assert.equal(answerReplacement.lifecycle, "active");

          const afterAnswerReplacement = (
            await learner.direct.questionBank.list()
          ).questions;
          const replacementQuestion = afterAnswerReplacement.find(
            (question) => question.id === answerReplacement.questionId,
          );
          const archivedOriginal = afterAnswerReplacement.find(
            (question) => question.id === questionId,
          );
          assert.deepEqual(
            replacementQuestion && {
              lifecycle: replacementQuestion.lifecycle,
              prompt: replacementQuestion.prompt,
              referenceAnswer: replacementQuestion.referenceAnswer,
              dueAt: replacementQuestion.dueAt,
            },
            {
              lifecycle: "active",
              prompt: "What must remain immutable after Question mutation?",
              referenceAnswer:
                "Every Learner Answer, evaluation, grade event, and derived history.",
              dueAt: null,
            },
          );
          assert.deepEqual(
            archivedOriginal && {
              lifecycle: archivedOriginal.lifecycle,
              prompt: archivedOriginal.prompt,
              referenceAnswer: archivedOriginal.referenceAnswer,
              dueAt: archivedOriginal.dueAt,
            },
            {
              lifecycle: "archived",
              prompt: "What must remain immutable after Question mutation?",
              referenceAnswer:
                "Learner Answers, evaluations, and Answer Grade history.",
              dueAt: "2030-08-21T00:00:00.000Z",
            },
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(questionId),
            evidenceBefore,
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(
              answerReplacement.questionId,
            ),
            {
              learnerAnswers: 0,
              evaluations: 0,
              gradeEvents: 0,
              dueAt: null,
            },
          );
          assert.deepEqual(
            await learner.direct.review.getEvaluation(pending.submissionId),
            completed,
          );

          const promptReplacement = await learner.direct.questionBank.replace({
            questionId: answerReplacement.questionId,
            prompt:
              "Which records remain immutable after Question replacement?",
            referenceAnswer:
              "Every Learner Answer, evaluation, grade event, and derived history.",
          });
          assert.notEqual(
            promptReplacement.questionId,
            answerReplacement.questionId,
          );
          assert.equal(promptReplacement.lifecycle, "active");
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            promptReplacement.questionId,
          );
        },
      );

      await suite.test(
        "unchanged restoration preserves Learning Evidence and Review schedule",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const learner = await provisionLearner("Restore contract learner");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "restored-evidence-question",
            items: [
              {
                prompt: "What does unchanged Question restoration preserve?",
                referenceAnswer: "Its Learning Evidence and derived schedule.",
              },
            ],
          });
          const questionId = added.results[0]?.id ?? "";
          const review = await learner.direct.review.open();
          const pending = await learner.direct.review.submitAnswer({
            questionVersionId: review.question?.questionVersionId ?? "",
            answer: "Its evidence and schedule.",
            idempotencyKey: "restore-evidence-answer",
          });
          const completed = await learner.direct.review.evaluatePending(
            pending.submissionId,
          );
          const evidenceBefore = await learner.direct.questionBank.evidence(
            questionId,
          );

          await learner.direct.questionBank.archive(questionId);
          assert.equal(
            (await learner.direct.questionBank.list()).questions[0]?.lifecycle,
            "archived",
          );
          assert.notEqual((await learner.direct.review.open()).question?.questionId, questionId);

          await learner.direct.questionBank.restore(questionId);
          const restored = (await learner.direct.questionBank.list())
            .questions[0];
          assert.equal(restored?.lifecycle, "active");
          assert.equal(restored?.dueAt, "2030-08-21T00:00:00.000Z");
          assert.deepEqual(
            await learner.direct.questionBank.evidence(questionId),
            evidenceBefore,
          );
          assert.deepEqual(
            await learner.direct.review.getEvaluation(pending.submissionId),
            completed,
          );
          clock.set("2030-08-21T10:00:00.000Z");
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            questionId,
          );
          clock.set("2030-08-20T10:00:00.000Z");
        },
      );

      await suite.test(
        "replacement is isolated, ignores normalized no-ops, and rolls back after mutation",
        async () => {
          const learnerA = await provisionLearner("Replacement learner A");
          const learnerB = await provisionLearner("Replacement learner B");
          const source = await learnerA.direct.questionBank.add({
            idempotencyKey: "replacement-source",
            items: [
              {
                prompt: "Which Question remains after replacement rollback?",
                referenceAnswer: "The original Active Question.",
              },
            ],
          });
          await learnerA.direct.questionBank.add({
            idempotencyKey: "replacement-conflict",
            items: [
              {
                prompt: "Which Prompt blocks duplicate replacement?",
                referenceAnswer: "This exact normalized Prompt.",
              },
            ],
          });
          const sourceId = source.results[0]?.id ?? "";

          await assert.rejects(
            learnerB.direct.questionBank.replace({
              questionId: sourceId,
              prompt: "Why must a cross-Learner replacement fail?",
              referenceAnswer: "Learner ownership prevents it.",
            }),
            /Question not found/u,
          );
          await assert.rejects(
            learnerA.direct.questionBank.replace({
              questionId: sourceId,
              prompt: "  WHICH PROMPT BLOCKS DUPLICATE REPLACEMENT?  ",
              referenceAnswer: "A conflicting Answer Standard.",
            }),
            /already uses this prompt/u,
          );

          const unchanged = await learnerA.direct.questionBank.replace({
            questionId: sourceId,
            prompt: "  WHICH QUESTION remains after replacement rollback?  ",
            referenceAnswer: "  The original Active Question.  ",
          });
          assert.deepEqual(unchanged, {
            questionId: sourceId,
            archivedQuestionId: null,
            lifecycle: "active",
            status: "unchanged",
          });

          const failedPrompt =
            "Which Question survives a post-archive replacement failure?";
          const failureTargetKey = questionPromptKey(failedPrompt);
          const { getV2Client } = await import("../app/db/v2/client.ts");
          const { pool } = getV2Client();
          await pool.query(
            `CREATE OR REPLACE FUNCTION waxon_v2.test_fail_question_replacement()
             RETURNS trigger
             LANGUAGE plpgsql
             AS $$
             BEGIN
               RAISE EXCEPTION 'Injected replacement failure after archive';
             END;
             $$;
             CREATE TRIGGER test_fail_question_replacement
             BEFORE INSERT ON waxon_v2.questions
             FOR EACH ROW
             WHEN (NEW.target_key = '${failureTargetKey}')
             EXECUTE FUNCTION waxon_v2.test_fail_question_replacement();`,
          );
          try {
            await assert.rejects(
              learnerA.direct.questionBank.replace({
                questionId: sourceId,
                prompt: failedPrompt,
                referenceAnswer:
                  "The transaction restores the original Active Question.",
              }),
              (error: unknown) =>
                error instanceof Error &&
                error.cause instanceof Error &&
                /Injected replacement failure after archive/u.test(
                  error.cause.message,
                ),
            );
          } finally {
            await pool.query(
              `DROP TRIGGER IF EXISTS test_fail_question_replacement
                 ON waxon_v2.questions;
               DROP FUNCTION IF EXISTS waxon_v2.test_fail_question_replacement();`,
            );
          }

          const questions = (await learnerA.direct.questionBank.list())
            .questions;
          assert.equal(questions.length, 2);
          const retained = questions.find((question) => question.id === sourceId);
          assert.equal(retained?.lifecycle, "active");
          assert.equal(
            retained?.prompt,
            "Which Question remains after replacement rollback?",
          );
          assert.equal(
            retained?.referenceAnswer,
            "The original Active Question.",
          );
        },
      );
    });
  },
);
