import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_CONTRACT_TEST_DATABASE_URL,
  withApplicationContract,
} from "./support/application-contract-harness.mts";

test(
  "application contract",
  {
    skip: APPLICATION_CONTRACT_TEST_DATABASE_URL
      ? false
      : "APPLICATION_CONTRACT_TEST_DATABASE_URL is not set",
  },
  async (suite) => {
    await withApplicationContract(async ({
      provisionLearner,
      semanticValidation,
    }) => {
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
            /already exists with a different reference answer/u,
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
        "Learning Evidence remains available across lifecycle mutations",
        async () => {
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
          assert.equal(review.item?.questionId, questionId);

          const pending = await learner.direct.review.submitAnswer({
            itemId: review.item?.itemId ?? "",
            answer: "Answers, evaluations, and grades stay immutable.",
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
              demonstratedGap: null,
            },
          );
          assert.equal(completed.nextDueAt, "2030-08-20T10:10:00.000Z");

          await learner.direct.questionBank.archive(questionId);
          assert.deepEqual(
            await learner.direct.review.getEvaluation(pending.submissionId),
            completed,
          );
          await learner.direct.questionBank.restore(questionId);
          assert.deepEqual(
            await learner.direct.review.getEvaluation(pending.submissionId),
            completed,
          );
          const restored = (await learner.direct.questionBank.list())
            .questions[0];
          assert.equal(restored?.dueAt, completed.nextDueAt);
          assert.equal(restored?.updatedAt, "2030-08-20T10:00:00.000Z");
        },
      );
    });
  },
);
