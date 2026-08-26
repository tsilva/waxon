import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_CONTRACT_TEST_DATABASE_URL,
  withApplicationContract,
} from "./support/application-contract-harness.mts";
import { questionPromptKey } from "../app/lib/v2/questionInput.ts";
import { authorizeMcpRequest } from "../app/lib/v2/mcpAuthorization.ts";
import {
  revokeMcpCredential,
  rotateMcpCredential,
} from "../app/lib/v2/mcpCredentials.ts";
import {
  toMcpAddResponse,
  toMcpRankedQuestion,
  toMcpStoredQuestion,
} from "../app/lib/v2/mcpContract.ts";

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
      provisionLearner,
      provisionDefaultLearner,
      semanticValidation,
    }) => {
      await suite.test(
        "semantic validation pass activates while fail, inconclusive, and unavailable quarantine",
        async () => {
          const learner = await provisionLearner("Validation contract learner");
          const expectations = [
            { outcome: "pass", lifecycle: "active", reasons: [] },
            { outcome: "fail", lifecycle: "flagged", reasons: ["not_atomic"] },
            {
              outcome: "inconclusive",
              lifecycle: "flagged",
              reasons: ["semantic_validation_inconclusive"],
            },
            {
              outcome: "unavailable",
              lifecycle: "flagged",
              reasons: ["semantic_validation_unavailable"],
            },
          ] as const;

          for (const expectation of expectations) {
            const { outcome } = expectation;
            semanticValidation.setOutcome(outcome);
            const added = await learner.direct.questionBank.add({
              idempotencyKey: `semantic-validation-${outcome}`,
              items: [
                {
                  prompt: `What is the ${outcome} semantic validation outcome?`,
                  referenceAnswer: `The deterministic outcome is ${outcome}.`,
                },
              ],
            });

            assert.equal(added.results[0]?.status, "created");
            assert.equal(added.results[0]?.lifecycle, expectation.lifecycle);
            assert.deepEqual(added.results[0]?.flags, expectation.reasons.length === 0
              ? []
              : [{ origin: "waxon_validation", reasons: expectation.reasons }]);
          }

          const questions = (await learner.direct.questionBank.list()).questions;
          for (const expectation of expectations) {
            const question = questions.find((candidate) =>
              candidate.prompt.includes(expectation.outcome),
            );
            assert.equal(question?.lifecycle, expectation.lifecycle);
            assert.deepEqual(
              question?.flags.map(({ origin, reasons }) => ({ origin, reasons })),
              expectation.reasons.length === 0
                ? []
                : [{ origin: "waxon_validation", reasons: expectation.reasons }],
            );
          }

          semanticValidation.setOutcome("pass");
        },
      );

      await suite.test(
        "production default activates a clear valid Question without a model",
        async () => {
          const learner = await provisionDefaultLearner(
            "Default validation learner",
          );
          const active = await learner.direct.questionBank.add({
            idempotencyKey: "default-valid-question",
            items: [
              {
                prompt: "What is the capital of Portugal?",
                referenceAnswer: "Lisbon.",
              },
            ],
          });
          assert.deepEqual(active.results[0] && {
            lifecycle: active.results[0].lifecycle,
            flags: active.results[0].flags,
          }, { lifecycle: "active", flags: [] });
          assert.equal(
            (await learner.direct.review.open()).item?.questionId,
            active.results[0]?.id,
          );

          const questionable = await learner.direct.questionBank.add({
            idempotencyKey: "default-questionable-question",
            items: [
              {
                prompt: "What color is it?",
                referenceAnswer: "Blue.",
              },
            ],
          });
          assert.deepEqual(questionable.results[0]?.flags, [
            {
              origin: "waxon_validation",
              reasons: ["not_self_contained"],
            },
          ]);
          assert.equal(questionable.results[0]?.lifecycle, "flagged");
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
        "revoked MCP credentials receive an unauthorized response",
        async () => {
          const learner = await provisionLearner("MCP credential learner");
          const { token } = await rotateMcpCredential(learner.id);
          const request = () =>
            new Request("https://waxon.example/api/mcp", {
              headers: { authorization: `Bearer ${token}` },
            });

          const authorized = await authorizeMcpRequest(request());
          assert.deepEqual(authorized, {
            authorized: true,
            userId: learner.id,
          });

          await revokeMcpCredential(learner.id);
          const revoked = await authorizeMcpRequest(request());
          assert.equal(revoked.authorized, false);
          if (revoked.authorized) return;
          assert.equal(revoked.response.status, 401);
          assert.equal(
            revoked.response.headers.get("www-authenticate"),
            'Bearer realm="Waxon MCP"',
          );
        },
      );

      await suite.test(
        "Authorized MCP Client add shares validation quarantine and durable visibility",
        async () => {
          const learner = await provisionLearner("MCP validation learner");
          const expectations = [
            { outcome: "fail", reason: "not_atomic" },
            {
              outcome: "unavailable",
              reason: "semantic_validation_unavailable",
            },
          ] as const;

          for (const { outcome, reason } of expectations) {
            semanticValidation.setOutcome(outcome);
            const added = await learner.authorizedMcpClient.questionBank.add({
              idempotencyKey: `mcp-validation-${outcome}`,
              items: [
                {
                  prompt: `What is the MCP ${outcome} validation outcome?`,
                  referenceAnswer: `The deterministic outcome is ${outcome}.`,
                },
              ],
            });
            assert.equal(added.results[0]?.lifecycle, "flagged");
            assert.deepEqual(added.results[0]?.flags, [
              { origin: "waxon_validation", reasons: [reason] },
            ]);
          }

          assert.deepEqual(
            (await learner.direct.questionBank.list({ lifecycle: "flagged" }))
              .questions.map((question) => question.lifecycle),
            ["flagged", "flagged"],
          );
          semanticValidation.setOutcome("pass");
        },
      );

      await suite.test(
        "Authorized MCP Client add reports canonical creation, replay, and duplicate outcomes",
        async () => {
          const learner = await provisionLearner("MCP add outcome learner");
          const activeInput = {
            prompt: "What makes an Authorized MCP Client retry idempotent?",
            referenceAnswer:
              "The same learner-scoped idempotency key returns the retained Question.",
          };

          semanticValidation.setOutcome("pass");
          const active = await learner.authorizedMcpClient.questionBank.add({
            idempotencyKey: "mcp-active-create",
            items: [activeInput],
          });
          const activeOutput = toMcpAddResponse(active);
          assert.deepEqual(activeOutput.results[0] && {
            status: activeOutput.results[0].status,
            outcome: activeOutput.results[0].outcome,
            lifecycle: activeOutput.results[0].lifecycle,
            flags: activeOutput.results[0].flags,
            answerStandardConflict:
              activeOutput.results[0].answerStandardConflict,
          }, {
            status: "created",
            outcome: "created_active",
            lifecycle: "active",
            flags: [],
            answerStandardConflict: false,
          });

          semanticValidation.setOutcome("fail");
          const flagged = await learner.authorizedMcpClient.questionBank.add({
            idempotencyKey: "mcp-flagged-create",
            items: [
              {
                prompt: "Which outcome?",
                referenceAnswer: "A validation-Flagged Question.",
              },
            ],
          });
          assert.deepEqual(flagged.results[0] && {
            status: flagged.results[0].status,
            outcome: flagged.results[0].outcome,
            lifecycle: flagged.results[0].lifecycle,
            flags: flagged.results[0].flags,
            answerStandardConflict:
              flagged.results[0].answerStandardConflict,
          }, {
            status: "created",
            outcome: "created_flagged",
            lifecycle: "flagged",
            flags: [{ origin: "waxon_validation", reasons: ["not_atomic"] }],
            answerStandardConflict: false,
          });

          semanticValidation.setOutcome("pass");
          const replay = await learner.authorizedMcpClient.questionBank.add({
            idempotencyKey: "mcp-active-create",
            items: [activeInput],
          });
          assert.deepEqual(replay.results[0] && {
            id: replay.results[0].id,
            status: replay.results[0].status,
            outcome: replay.results[0].outcome,
            lifecycle: replay.results[0].lifecycle,
            answerStandardConflict:
              replay.results[0].answerStandardConflict,
          }, {
            id: active.results[0]?.id,
            status: "existing",
            outcome: "idempotent_replay",
            lifecycle: "active",
            answerStandardConflict: false,
          });

          await learner.direct.questionBank.archive(active.results[0]?.id ?? "");
          const archivedDuplicate =
            await learner.authorizedMcpClient.questionBank.add({
              idempotencyKey: "mcp-archived-duplicate",
              items: [
                {
                  prompt:
                    "  WHAT MAKES AN AUTHORIZED MCP CLIENT RETRY IDEMPOTENT?  ",
                  referenceAnswer: activeInput.referenceAnswer,
                },
              ],
            });
          assert.deepEqual(archivedDuplicate.results[0] && {
            id: archivedDuplicate.results[0].id,
            status: archivedDuplicate.results[0].status,
            outcome: archivedDuplicate.results[0].outcome,
            lifecycle: archivedDuplicate.results[0].lifecycle,
            answerStandardConflict:
              archivedDuplicate.results[0].answerStandardConflict,
          }, {
            id: active.results[0]?.id,
            status: "existing",
            outcome: "exact_duplicate",
            lifecycle: "archived",
            answerStandardConflict: false,
          });

          const conflictingAnswer =
            await learner.authorizedMcpClient.questionBank.add({
              idempotencyKey: "mcp-conflicting-answer",
              items: [
                {
                  prompt: activeInput.prompt,
                  referenceAnswer: "A conflicting Answer Standard.",
                },
              ],
            });
          assert.deepEqual(conflictingAnswer.results[0] && {
            id: conflictingAnswer.results[0].id,
            outcome: conflictingAnswer.results[0].outcome,
            lifecycle: conflictingAnswer.results[0].lifecycle,
            answerStandardConflict:
              conflictingAnswer.results[0].answerStandardConflict,
          }, {
            id: active.results[0]?.id,
            outcome: "exact_duplicate",
            lifecycle: "archived",
            answerStandardConflict: true,
          });

          const withinBatch =
            await learner.authorizedMcpClient.questionBank.add({
              idempotencyKey: "mcp-within-batch-duplicate",
              items: [
                {
                  prompt:
                    "Which identity is retained for a duplicate within one MCP batch?",
                  referenceAnswer: "The first Question identity.",
                },
                {
                  prompt:
                    "  WHICH IDENTITY IS RETAINED FOR A DUPLICATE WITHIN ONE MCP BATCH?  ",
                  referenceAnswer: "A conflicting Answer Standard.",
                },
              ],
            });
          assert.deepEqual(
            withinBatch.results.map((result) => ({
              id: result.id,
              outcome: result.outcome,
              answerStandardConflict: result.answerStandardConflict,
            })),
            [
              {
                id: withinBatch.results[0]?.id,
                outcome: "created_active",
                answerStandardConflict: false,
              },
              {
                id: withinBatch.results[0]?.id,
                outcome: "exact_duplicate",
                answerStandardConflict: true,
              },
            ],
          );
        },
      );

      await suite.test(
        "Authorized MCP Client concurrent adds retain one Question identity",
        async () => {
          const learner = await provisionLearner("MCP concurrent add learner");
          semanticValidation.setOutcome("pass");
          const input = {
            prompt: "Why are concurrent Authorized MCP Client adds duplicate-safe?",
            referenceAnswer:
              "The learner Question Bank serializes canonical Prompt identity decisions.",
          };
          const [first, second] = await Promise.all([
            learner.authorizedMcpClient.questionBank.add({
              idempotencyKey: "mcp-concurrent-first",
              items: [input],
            }),
            learner.authorizedMcpClient.questionBank.add({
              idempotencyKey: "mcp-concurrent-second",
              items: [{ ...input, prompt: `  ${input.prompt.toUpperCase()}  ` }],
            }),
          ]);
          const results = [first.results[0], second.results[0]];
          assert.equal(new Set(results.map((result) => result?.id)).size, 1);
          assert.deepEqual(
            results.map((result) => result?.outcome).sort(),
            ["created_active", "exact_duplicate"],
          );
          assert.equal((await learner.direct.questionBank.list()).questions.length, 1);
        },
      );

      await suite.test(
        "Authorized MCP Client search returns Flag Reasons without cross-Learner leakage",
        async () => {
          const learnerA = await provisionLearner("MCP search learner A");
          const learnerB = await provisionLearner("MCP search learner B");
          semanticValidation.setOutcome("fail");
          const prompt =
            "Which Flag Reason is visible to the owning Authorized MCP Client?";
          const addedA = await learnerA.authorizedMcpClient.questionBank.add({
            idempotencyKey: "mcp-search-flag-a",
            items: [{ prompt, referenceAnswer: "Only learner A's reason." }],
          });
          const addedB = await learnerB.authorizedMcpClient.questionBank.add({
            idempotencyKey: "mcp-search-flag-b",
            items: [{ prompt, referenceAnswer: "Only learner B's reason." }],
          });

          const searched = await learnerA.authorizedMcpClient.questionBank.check({
            items: [
              { candidateId: "flag-search", prompt, referenceAnswer: "" },
            ],
            limitPerItem: 5,
          });
          const bankMatches = searched.results[0]?.matches.filter(
            (match) => match.source === "bank",
          ).map(toMcpRankedQuestion);
          assert.deepEqual(
            bankMatches?.map((match) => ({
              id: match.id,
              lifecycle: match.lifecycle,
              flags: match.flags.map(({ origin, reasons }) => ({
                origin,
                reasons,
              })),
            })),
            [
              {
                id: addedA.results[0]?.id,
                lifecycle: "flagged",
                flags: [
                  { origin: "waxon_validation", reasons: ["not_atomic"] },
                ],
              },
            ],
          );
          assert.notEqual(addedA.results[0]?.id, addedB.results[0]?.id);
          const listed = await learnerA.authorizedMcpClient.questionBank.list({
            lifecycle: "flagged",
          });
          assert.deepEqual(
            listed.questions.map(toMcpStoredQuestion).map((question) => ({
              id: question.id,
              lifecycle: question.lifecycle,
              flags: question.flags.map(({ origin, reasons }) => ({
                origin,
                reasons,
              })),
            })),
            [
              {
                id: addedA.results[0]?.id,
                lifecycle: "flagged",
                flags: [
                  { origin: "waxon_validation", reasons: ["not_atomic"] },
                ],
              },
            ],
          );

          semanticValidation.setOutcome("pass");
          const similar = await learnerA.authorizedMcpClient.questionBank.add({
            idempotencyKey: "mcp-similar-but-distinct",
            items: [
              {
                prompt:
                  "Why are Flag Reasons visible to an owning Authorized MCP Client?",
                referenceAnswer:
                  "Similarity is advisory and this different recall target stays distinct.",
              },
            ],
          });
          assert.equal(similar.results[0]?.outcome, "created_active");
          assert.notEqual(similar.results[0]?.id, addedA.results[0]?.id);
        },
      );

      await suite.test(
        "structurally unusable candidates are rejected without storage",
        async () => {
          const learner = await provisionLearner("Structural contract learner");
          semanticValidation.setOutcome("fail");
          const candidates = [
            {
              prompt: "",
              referenceAnswer: "An empty Prompt cannot be stored.",
              error: /Add a question prompt/u,
            },
            {
              prompt: 42 as never,
              referenceAnswer: "A malformed Prompt cannot be stored.",
              error: /Question Prompt must be text/u,
            },
            {
              prompt: `${"x".repeat(16_384)}?`,
              referenceAnswer: "An out-of-bounds Prompt cannot be stored.",
              error: /at most 16384 characters/u,
            },
            {
              prompt: "Why must an empty Answer Standard be rejected?",
              referenceAnswer: "",
              error: /Add or confirm an Answer Standard/u,
            },
            {
              prompt: "Why must a malformed Answer Standard be rejected?",
              referenceAnswer: 42 as never,
              error: /Answer Standard must be text/u,
            },
            {
              prompt: "Why must an oversized Answer Standard be rejected?",
              referenceAnswer: "x".repeat(65_537),
              error: /at most 65536 characters/u,
            },
          ];

          for (const [index, candidate] of candidates.entries()) {
            await assert.rejects(
              learner.direct.questionBank.add({
                idempotencyKey: `structural-rejection-${index}`,
                items: [candidate],
              }),
              candidate.error,
            );
          }

          assert.deepEqual(
            (await learner.direct.questionBank.list()).questions,
            [],
          );
          semanticValidation.setOutcome("pass");
        },
      );

      await suite.test(
        "Flagged Questions preserve evidence through restore, replacement, and archive",
        async () => {
          const learner = await provisionLearner("Flag resolution learner");
          const otherLearner = await provisionLearner("Flag isolation learner");
          semanticValidation.setOutcome("fail");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "flag-resolution-candidates",
            items: [
              {
                prompt: "Which Flagged Question should be restored unchanged?",
                referenceAnswer: "The restoration candidate.",
              },
              {
                prompt: "Which Flagged Question should be replaced immutably?",
                referenceAnswer: "The replacement candidate.",
              },
              {
                prompt: "Which Flagged Question should be archived without replacement?",
                referenceAnswer: "The archive candidate.",
              },
              {
                prompt: "Which Flagged Prompt must remain one identity?",
                referenceAnswer: "The exact normalized duplicate candidate.",
              },
            ],
          });
          const [restoreId, replaceId, archiveId, duplicateId] = added.results.map(
            (result) => result.id,
          );

          assert.equal((await learner.direct.review.open()).item, null);
          await assert.rejects(
            otherLearner.direct.questionBank.restore(restoreId ?? ""),
            /Question not found/u,
          );

          semanticValidation.setOutcome("pass");
          const duplicate = await learner.direct.questionBank.add({
            idempotencyKey: "flag-resolution-duplicate",
            items: [
              {
                prompt: "  WHICH FLAGGED PROMPT MUST REMAIN ONE IDENTITY?  ",
                referenceAnswer: "The exact normalized duplicate candidate.",
              },
            ],
          });
          assert.deepEqual(duplicate.results, [
            {
              id: duplicateId,
              status: "existing",
              outcome: "exact_duplicate",
              lifecycle: "flagged",
              flags: [
                { origin: "waxon_validation", reasons: ["not_atomic"] },
              ],
              answerStandardConflict: false,
            },
          ]);

          await learner.direct.questionBank.restore(restoreId ?? "");
          semanticValidation.setOutcome("unavailable");
          const replacement = await learner.direct.questionBank.replace({
            questionId: replaceId ?? "",
            prompt: "What makes a resolved replacement a new Question?",
            referenceAnswer: "It has a new identity and reset mastery.",
          });
          assert.equal(replacement.lifecycle, "active");
          semanticValidation.setOutcome("pass");
          await learner.direct.questionBank.archive(archiveId ?? "");

          const questions = (await learner.direct.questionBank.list()).questions;
          const restored = questions.find((question) => question.id === restoreId);
          const replacedOriginal = questions.find(
            (question) => question.id === replaceId,
          );
          const archived = questions.find((question) => question.id === archiveId);
          const replacementQuestion = questions.find(
            (question) => question.id === replacement.questionId,
          );
          assert.equal(restored?.lifecycle, "active");
          assert.equal(replacedOriginal?.lifecycle, "archived");
          assert.equal(archived?.lifecycle, "archived");
          assert.equal(replacementQuestion?.lifecycle, "active");
          assert.deepEqual(replacementQuestion?.flags, []);
          for (const resolved of [restored, replacedOriginal, archived]) {
            assert.deepEqual(
              resolved?.flags.map(({ origin, reasons, resolvedAt }) => ({
                origin,
                reasons,
                resolved: resolvedAt !== null,
              })),
              [
                {
                  origin: "waxon_validation",
                  reasons: ["not_atomic"],
                  resolved: true,
                },
              ],
            );
          }
          assert.deepEqual(
            await learner.direct.questionBank.evidence(replacement.questionId),
            {
              learnerAnswers: 0,
              evaluations: 0,
              gradeEvents: 0,
              dueAt: null,
            },
          );
          assert.equal(
            new Set([restoreId, replacement.questionId]).has(
              (await learner.direct.review.open()).item?.questionId ?? "",
            ),
            true,
          );
          semanticValidation.setOutcome("pass");
        },
      );

      await suite.test(
        "Flag evidence distinguishes learner action from Waxon validation",
        async () => {
          const learner = await provisionLearner("Flag origin learner");
          semanticValidation.setOutcome("pass");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "learner-flag-origin",
            items: [
              {
                prompt: "Which origin identifies a learner-created Flag?",
                referenceAnswer: "The machine-readable learner origin.",
              },
            ],
          });
          const questionId = added.results[0]?.id ?? "";
          const review = await learner.direct.review.open();
          assert.equal(review.item?.questionId, questionId);

          await learner.direct.review.act({
            itemId: review.item?.itemId ?? "",
            action: "flag",
          });
          const flagged = (await learner.direct.questionBank.list({
            lifecycle: "flagged",
          })).questions[0];
          assert.equal(flagged?.id, questionId);
          assert.deepEqual(
            flagged?.flags.map(({ origin, reasons, resolvedAt }) => ({
              origin,
              reasons,
              resolvedAt,
            })),
            [{ origin: "learner", reasons: [], resolvedAt: null }],
          );
          assert.notEqual((await learner.direct.review.open()).item?.questionId, questionId);
        },
      );

      await suite.test(
        "Question Bank add returns a retained conflict without duplicating identity",
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

          const added = await learner.direct.questionBank.add({
            idempotencyKey: "retained-conflict-batch",
            items: [
              {
                prompt:
                  "Which Question commits beside a retained conflict?",
                referenceAnswer:
                  "The new Question in the same successful batch.",
              },
              {
                prompt: "What does an application transaction preserve?",
                referenceAnswer: "A conflicting Answer Standard.",
              },
            ],
          });
          assert.deepEqual(
            added.results.map((result) => ({
              outcome: result.outcome,
              answerStandardConflict: result.answerStandardConflict,
            })),
            [
              { outcome: "created_active", answerStandardConflict: false },
              { outcome: "exact_duplicate", answerStandardConflict: true },
            ],
          );

          assert.deepEqual(
            (await learner.direct.questionBank.list()).questions.map(
              (question) => question.prompt,
            ).sort(),
            [
              "What does an application transaction preserve?",
              "Which Question commits beside a retained conflict?",
            ].sort(),
          );
        },
      );

      await suite.test(
        "Authorized MCP Client add rolls back durable writes and its receipt together",
        async () => {
          const learner = await provisionLearner("MCP rollback learner");
          semanticValidation.setOutcome("pass");
          const failedPrompt =
            "Which MCP Question triggers the injected transaction failure?";
          const items = [
            {
              prompt: "Which MCP Question must roll back with its batch?",
              referenceAnswer: "The first Question inserted by the transaction.",
            },
            {
              prompt: failedPrompt,
              referenceAnswer: "The second Question triggers the test failure.",
            },
          ];
          const { getV2Client } = await import("../app/db/v2/client.ts");
          const { pool } = getV2Client();
          await pool.query(
            `CREATE OR REPLACE FUNCTION waxon_v2.test_fail_mcp_question_add()
             RETURNS trigger
             LANGUAGE plpgsql
             AS $$
             BEGIN
               IF NEW.prompt = '${failedPrompt}' THEN
                 RAISE EXCEPTION 'Injected MCP add failure';
               END IF;
               RETURN NEW;
             END;
             $$;
             CREATE TRIGGER test_fail_mcp_question_add
             BEFORE INSERT ON waxon_v2.question_versions
             FOR EACH ROW
             EXECUTE FUNCTION waxon_v2.test_fail_mcp_question_add();`,
          );
          try {
            await assert.rejects(
              learner.authorizedMcpClient.questionBank.add({
                idempotencyKey: "mcp-transaction-rollback",
                items,
              }),
              (error: unknown) =>
                error instanceof Error &&
                error.cause instanceof Error &&
                /Injected MCP add failure/u.test(error.cause.message),
            );
          } finally {
            await pool.query(
              `DROP TRIGGER IF EXISTS test_fail_mcp_question_add
                 ON waxon_v2.question_versions;
               DROP FUNCTION IF EXISTS waxon_v2.test_fail_mcp_question_add();`,
            );
          }

          assert.deepEqual(
            (await learner.direct.questionBank.list()).questions,
            [],
          );
          const retried = await learner.authorizedMcpClient.questionBank.add({
            idempotencyKey: "mcp-transaction-rollback",
            items,
          });
          assert.deepEqual(
            retried.results.map((result) => result.outcome),
            ["created_active", "created_active"],
          );
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
            {
              id: questionId,
              status: "existing",
              outcome: "exact_duplicate",
              lifecycle: "archived",
              flags: [],
              answerStandardConflict: false,
            },
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

          const evidenceBefore = await learner.direct.questionBank.evidence(
            questionId,
          );
          assert.deepEqual(evidenceBefore, {
            learnerAnswers: 1,
            evaluations: 1,
            gradeEvents: 1,
            dueAt: completed.nextDueAt,
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
              retrievability: replacementQuestion.retrievability,
            },
            {
              lifecycle: "active",
              prompt: "What must remain immutable after Question mutation?",
              referenceAnswer:
                "Every Learner Answer, evaluation, grade event, and derived history.",
              dueAt: null,
              retrievability: null,
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
              dueAt: completed.nextDueAt,
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
            (await learner.direct.review.open()).item?.questionId,
            promptReplacement.questionId,
          );
        },
      );

      await suite.test(
        "unchanged restoration preserves Learning Evidence and Review schedule",
        async () => {
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
            itemId: review.item?.itemId ?? "",
            answer: "Its evidence and schedule.",
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
          assert.notEqual((await learner.direct.review.open()).item?.questionId, questionId);

          await learner.direct.questionBank.restore(questionId);
          const restored = (await learner.direct.questionBank.list())
            .questions[0];
          assert.equal(restored?.lifecycle, "active");
          assert.equal(restored?.dueAt, completed.nextDueAt);
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
            (await learner.direct.review.open()).item?.questionId,
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
