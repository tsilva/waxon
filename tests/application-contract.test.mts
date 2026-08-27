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
      databaseCatalog,
      evaluation,
      provisionLearner,
      provisionDefaultLearner,
      semanticValidation,
      setQuestionLifecycle,
    }) => {
      await suite.test(
        "the durable catalog exposes only the immutable Question and live Review contracts",
        async () => {
          const catalog = await databaseCatalog();
          for (const retiredTable of [
            "daily_plans",
            "daily_plan_items",
            "review_sessions",
            "review_session_items",
            "retry_obligations",
            "question_versions",
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
          for (const retiredColumn of [
            "prior_lifecycle",
            "suspension_reason",
            "deleted_at",
          ]) {
            assert.equal(catalog.questionColumns.includes(retiredColumn), false);
          }
          assert.equal(catalog.questionColumns.includes("prompt"), true);
          assert.equal(catalog.questionColumns.includes("reference_answer"), true);
          assert.equal(catalog.questionColumns.includes("creation_order"), true);
          assert.equal(
            catalog.answerSubmissionColumns.includes("question_version_id"),
            false,
          );
          assert.equal(
            catalog.questionSearchEmbeddingColumns.includes(
              "question_version_id",
            ),
            false,
          );
          assert.deepEqual(catalog.questionVersionIdLocations, []);
          assert.deepEqual(catalog.obsoleteContractObjects, []);
          assert.equal(catalog.evaluationColumns.includes("question_id"), true);
          assert.equal(catalog.gradeEventColumns.includes("question_id"), true);
          assert.deepEqual(catalog.enumValues.question_lifecycle, [
            "active",
            "flagged",
            "archived",
          ]);
          assert.equal("answer_mode" in catalog.enumValues, false);
          for (const retiredEnum of [
            "retry_status",
            "session_item_kind",
            "session_item_state",
            "session_kind",
            "session_status",
          ]) {
            assert.equal(retiredEnum in catalog.enumValues, false);
          }
        },
      );

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
            assert.deepEqual(
              added.results[0]?.flags,
              expectation.reasons.length === 0
                ? []
                : [{ origin: "waxon_validation", reasons: expectation.reasons }],
            );
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
          assert.deepEqual(
            active.results[0] && {
              lifecycle: active.results[0].lifecycle,
              flags: active.results[0].flags,
            },
            { lifecycle: "active", flags: [] },
          );
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
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
            (match) => match.origin === "bank",
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

          assert.equal((await learner.direct.review.open()).question, null);
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
          semanticValidation.setOutcome("pass");
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
              (await learner.direct.review.open()).question?.questionId ?? "",
            ),
            true,
          );
          semanticValidation.setOutcome("pass");
        },
      );

      await suite.test(
        "Question Bank Flagging accepts empty and detailed Learner reasons for any Active Question",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          semanticValidation.setOutcome("pass");
          evaluation.setGrade("again");
          const learner = await provisionLearner("Question Bank flag learner");
          const otherLearner = await provisionLearner(
            "Question Bank flag isolation learner",
          );
          const practiced = await learner.direct.questionBank.add({
            idempotencyKey: "question-bank-flag-practiced",
            items: [
              {
                prompt: "Which Active Question can be Flagged outside Review?",
                referenceAnswer:
                  "Any retained Active Question in the Learner's Question Bank.",
              },
            ],
          });
          const practicedQuestionId = practiced.results[0]?.id ?? "";
          const practicedOpen = await learner.direct.review.open();
          const practicedAnswer = await learner.direct.review.submitAnswer({
            questionId: practicedOpen.question?.questionId ?? "",
            answer: "Any retained Active Question in my Question Bank.",
            idempotencyKey: "question-bank-flag-practiced-answer",
          });
          await learner.direct.review.evaluatePending(
            practicedAnswer.submissionId,
          );
          const evidenceBefore = await learner.direct.questionBank.evidence(
            practicedQuestionId,
          );

          const queueHead = await learner.direct.questionBank.add({
            idempotencyKey: "question-bank-flag-current",
            items: [
              {
                prompt: "What identifies a detailed Learner Flag?",
                referenceAnswer:
                  "Its selected reasons and optional free-text detail.",
              },
            ],
          });
          const queueHeadQuestionId = queueHead.results[0]?.id ?? "";
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            queueHeadQuestionId,
          );

          await assert.rejects(
            otherLearner.direct.questionBank.flag({
              questionId: practicedQuestionId,
              reasons: ["prompt_unclear"],
              detail: "A cross-Learner attempt must not create a Flag.",
            }),
            /Question not found/u,
          );

          const emptyFlag = await learner.direct.questionBank.flag({
            questionId: practicedQuestionId,
            reasons: [],
            detail: "",
          });
          assert.deepEqual(emptyFlag, {
            questionId: practicedQuestionId,
            lifecycle: "flagged",
            flag: {
              origin: "learner",
              reasons: [],
              detail: null,
              createdAt: clock.now().toISOString(),
              resolvedAt: null,
            },
          });
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            queueHeadQuestionId,
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(practicedQuestionId),
            evidenceBefore,
          );

          await learner.direct.questionBank.flag({
            questionId: queueHeadQuestionId,
            reasons: ["prompt_unclear", "answer_standard_incorrect"],
            detail: "  The prompt and stored standard need attention.  ",
          });
          assert.equal((await learner.direct.review.open()).question, null);

          const flagged = await learner.direct.questionBank.list({
            lifecycle: "flagged",
          });
          assert.equal(flagged.counts.flagged, 2);
          assert.deepEqual(
            new Map(
              flagged.questions.map((question) => [
                question.id,
                {
                  lifecycle: question.lifecycle,
                  flags: question.flags.map(
                    ({ origin, reasons, detail, resolvedAt }) => ({
                      origin,
                      reasons,
                      detail,
                      resolvedAt,
                    }),
                  ),
                },
              ]),
            ),
            new Map([
              [
                practicedQuestionId,
                {
                  lifecycle: "flagged",
                  flags: [
                    {
                      origin: "learner",
                      reasons: [],
                      detail: null,
                      resolvedAt: null,
                    },
                  ],
                },
              ],
              [
                queueHeadQuestionId,
                {
                  lifecycle: "flagged",
                  flags: [
                    {
                      origin: "learner",
                      reasons: [
                        "prompt_unclear",
                        "answer_standard_incorrect",
                      ],
                      detail: "The prompt and stored standard need attention.",
                      resolvedAt: null,
                    },
                  ],
                },
              ],
            ]),
          );
          evaluation.setGrade("good");
        },
      );

      await suite.test(
        "Review Flagging records learner reasons, preserves evidence, isolates ownership, and removes the current Question immediately",
        async () => {
          const learner = await provisionLearner("Review flag learner");
          const otherLearner = await provisionLearner(
            "Review flag isolation learner",
          );
          const future = await learner.direct.questionBank.add({
            idempotencyKey: "review-flag-future-candidate",
            items: [
              {
                prompt: "Which future Active Question must Review refuse to Flag?",
                referenceAnswer: "A Question that is not the queue head.",
              },
            ],
          });
          const futureQuestionId = future.results[0]?.id ?? "";
          const futureOpened = await learner.direct.review.open();
          evaluation.setGrade("good");
          const futurePending = await learner.direct.review.submitAnswer({
            questionId: futureOpened.question?.questionId ?? "",
            answer: "A Question that is not the queue head.",
            idempotencyKey: "review-flag-future-answer",
          });
          await learner.direct.review.evaluatePending(futurePending.submissionId);
          assert.equal((await learner.direct.review.open()).question, null);

          const first = await learner.direct.questionBank.add({
            idempotencyKey: "review-flag-empty-candidate",
            items: [
              {
                prompt: "Which Review Question can be Flagged without a reason?",
                referenceAnswer: "The current Review Question.",
              },
            ],
          });
          const firstQuestionId = first.results[0]?.id ?? "";
          const opened = await learner.direct.review.open();
          assert.equal(opened.question?.questionId, firstQuestionId);

          await assert.rejects(
            learner.direct.review.flag({
              questionId: futureQuestionId,
              reasons: ["prompt_unclear"],
              detail: "This future Question is not currently exposed.",
            }),
            /current Review Question/u,
          );
          assert.equal(
            (await learner.direct.questionBank.list()).questions.find(
              (question) => question.id === futureQuestionId,
            )?.lifecycle,
            "active",
          );

          evaluation.setGrade("again");
          const pending = await learner.direct.review.submitAnswer({
            questionId: opened.question?.questionId ?? "",
            answer: "The current Review Question.",
            idempotencyKey: "review-flag-again-answer",
          });
          await learner.direct.review.evaluatePending(pending.submissionId);
          const evidenceBefore = await learner.direct.questionBank.evidence(
            firstQuestionId,
          );
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            firstQuestionId,
          );

          await assert.rejects(
            otherLearner.direct.review.flag({
              questionId: firstQuestionId,
              reasons: [],
              detail: null,
            }),
            /current Review Question/u,
          );

          const emptyFlag = await learner.direct.review.flag({
            questionId: firstQuestionId,
            reasons: [],
            detail: "",
          });
          assert.deepEqual(emptyFlag, {
            questionId: firstQuestionId,
            lifecycle: "flagged",
            flag: {
              origin: "learner",
              reasons: [],
              detail: null,
              createdAt: clock.now().toISOString(),
              resolvedAt: null,
            },
          });
          assert.equal((await learner.direct.review.open()).question, null);
          assert.deepEqual(
            await learner.direct.questionBank.evidence(firstQuestionId),
            evidenceBefore,
          );

          evaluation.setGrade("good");
          const second = await learner.direct.questionBank.add({
            idempotencyKey: "review-flag-reasons-candidate",
            items: [
              {
                prompt: "Which Review Flag can retain several reasons?",
                referenceAnswer: "A learner-origin Review Flag.",
              },
            ],
          });
          const secondQuestionId = second.results[0]?.id ?? "";
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            secondQuestionId,
          );
          await learner.direct.review.flag({
            questionId: secondQuestionId,
            reasons: ["prompt_unclear", "answer_standard_incorrect"],
            detail: "  The stored explanation contradicts the prompt.  ",
          });

          const flagged = await learner.direct.questionBank.list({
            lifecycle: "flagged",
          });
          assert.equal(flagged.counts.flagged, 2);
          const flaggedById = new Map(
            flagged.questions.map((question) => [
              question.id,
              {
                lifecycle: question.lifecycle,
                flags: question.flags.map(
                  ({ origin, reasons, detail, resolvedAt }) => ({
                    origin,
                    reasons,
                    detail,
                    resolvedAt,
                  }),
                ),
              },
            ]),
          );
          assert.deepEqual(
            flaggedById.get(firstQuestionId),
            {
              lifecycle: "flagged",
              flags: [
                {
                  origin: "learner",
                  reasons: [],
                  detail: null,
                  resolvedAt: null,
                },
              ],
            },
          );
          assert.deepEqual(
            flaggedById.get(secondQuestionId),
            {
              lifecycle: "flagged",
              flags: [
                {
                  origin: "learner",
                  reasons: [
                    "prompt_unclear",
                    "answer_standard_incorrect",
                  ],
                  detail: "The stored explanation contradicts the prompt.",
                  resolvedAt: null,
                },
              ],
            },
          );

          await learner.direct.questionBank.restore(firstQuestionId);
          assert.deepEqual(
            await learner.direct.questionBank.evidence(firstQuestionId),
            evidenceBefore,
          );
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            firstQuestionId,
          );
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
             BEFORE INSERT ON waxon_v2.questions
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
                 ON waxon_v2.questions;
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
              questionId:
                current.question?.questionId ?? "",
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
              questionId: opened.question?.questionId ?? "",
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

          clock.set("2030-08-21T10:00:00.000Z");
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
            unanswered.results[0]?.id,
            unanswered.results[1]?.id,
            newerDue,
          ];
          const observed: Array<string | undefined> = [];
          for (let index = 0; index < expectedOrder.length; index += 1) {
            const opened = await learner.direct.review.open();
            observed.push(opened.question?.questionId);
            const pending = await learner.direct.review.submitAnswer({
              questionId: opened.question?.questionId ?? "",
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
            questionId: first.question?.questionId ?? "",
            answer: "The previously answered Question.",
            idempotencyKey: "equal-day-answered-response",
          });
          await learner.direct.review.evaluatePending(pending.submissionId);

          clock.set("2030-08-23T10:00:00.000Z");
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
              questionId:
                opened.question?.questionId ?? "",
              answer: "Deterministic successful recall.",
              idempotencyKey: `equal-day-order-response-${index}`,
            });
            await learner.direct.review.evaluatePending(response.submissionId);
          }
          assert.deepEqual(observed, expected);
        },
      );

      await suite.test(
        "Again moves behind the current queue and returns immediately when alone after reopening Review",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          evaluation.setGrade("again");
          const learner = await provisionLearner("Same-day Again learner");
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "same-day-again-questions",
            items: [
              {
                prompt: "Which Question receives Again?",
                referenceAnswer: "The first Question.",
              },
              {
                prompt: "Which Question follows first?",
                referenceAnswer: "The second Question.",
              },
              {
                prompt: "Which Question follows second?",
                referenceAnswer: "The third Question.",
              },
            ],
          });
          const [againQuestion, secondQuestion, thirdQuestion] =
            added.results.map((result) => result.id);

          async function answerCurrent(key: string) {
            const opened = await learner.direct.review.open();
            const pending = await learner.direct.review.submitAnswer({
              questionId: opened.question?.questionId ?? "",
              answer: "Deterministic recall.",
              idempotencyKey: key,
            });
            return learner.direct.review.evaluatePending(pending.submissionId);
          }

          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            againQuestion,
          );
          await answerCurrent("same-day-again-first-answer");
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            secondQuestion,
          );

          evaluation.setGrade("good");
          await answerCurrent("same-day-again-second-answer");
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            thirdQuestion,
          );
          await answerCurrent("same-day-again-third-answer");

          const reopenedWhenAlone = await learner.direct.review.open();
          assert.equal(reopenedWhenAlone.summary.queueRemaining, 1);
          assert.equal(reopenedWhenAlone.question?.questionId, againQuestion);

          evaluation.setGrade("again");
          await answerCurrent("same-day-again-only-answer");
          const reopenedImmediately = await learner.direct.review.open();
          assert.equal(reopenedImmediately.summary.queueRemaining, 1);
          assert.equal(reopenedImmediately.question?.questionId, againQuestion);
          assert.equal(reopenedImmediately.waitingOnEvaluation, false);
          assert.deepEqual(
            await learner.direct.questionBank.evidence(againQuestion ?? ""),
            {
              learnerAnswers: 2,
              evaluations: 2,
              gradeEvents: 2,
              dueAt: "2030-08-20T10:00:00.000Z",
            },
          );
          await learner.direct.review.open();
          assert.equal(
            (await learner.direct.questionBank.evidence(againQuestion ?? ""))
              .gradeEvents,
            2,
          );
          clock.set("2030-08-21T10:00:00.000Z");
          await learner.direct.questionBank.add({
            idempotencyKey: "next-day-after-again-question",
            items: [
              {
                prompt: "Which Question was added after yesterday's Again?",
                referenceAnswer: "The newly added Question.",
              },
            ],
          });
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            againQuestion,
          );
          evaluation.setGrade("good");
        },
      );

      await suite.test(
        "Hard, Good, and Easy schedule progressively later Local Days",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const scheduled: string[] = [];

          for (const grade of ["hard", "good", "easy"] as const) {
            evaluation.setGrade(grade);
            const learner = await provisionLearner(`${grade} interval learner`);
            await learner.direct.questionBank.add({
              idempotencyKey: `${grade}-interval-question`,
              items: [
                {
                  prompt: `Which interval follows ${grade}?`,
                  referenceAnswer: `${grade} uses its grade-history interval.`,
                },
              ],
            });
            const opened = await learner.direct.review.open();
            const pending = await learner.direct.review.submitAnswer({
              questionId: opened.question?.questionId ?? "",
              answer: "Deterministic recall.",
              idempotencyKey: `${grade}-interval-answer`,
            });
            const completed = await learner.direct.review.evaluatePending(
              pending.submissionId,
            );
            assert.equal(completed.grade, grade);
            assert.ok(completed.nextDueOn);
            scheduled.push(completed.nextDueOn);
          }

          assert.equal(scheduled[0]! < scheduled[1]!, true);
          assert.equal(scheduled[1]! < scheduled[2]!, true);

          evaluation.setGrade("good");
          clock.set("2030-08-20T10:00:00.000Z");
          const correctedLearner = await provisionLearner(
            "Delayed successful correction learner",
          );
          await correctedLearner.direct.questionBank.add({
            idempotencyKey: "delayed-successful-correction-question",
            items: [
              {
                prompt: "When does a delayed successful correction return?",
                referenceAnswer: "On a future Local Day.",
              },
            ],
          });
          const correctedOpen = await correctedLearner.direct.review.open();
          const correctedPending =
            await correctedLearner.direct.review.submitAnswer({
              questionId:
                correctedOpen.question?.questionId ?? "",
              answer: "On a future Local Day.",
              idempotencyKey: "delayed-successful-correction-answer",
            });
          await correctedLearner.direct.review.evaluatePending(
            correctedPending.submissionId,
          );
          clock.set("2030-09-10T10:00:00.000Z");
          const correctedDates: string[] = [];
          for (const grade of ["hard", "good", "easy"] as const) {
            const corrected = await correctedLearner.direct.review.grade({
              submissionId: correctedPending.submissionId,
              grade,
            });
            assert.ok(corrected.nextDueOn);
            assert.equal(corrected.nextDueOn! > "2030-09-10", true);
            assert.equal((await correctedLearner.direct.review.open()).question, null);
            correctedDates.push(corrected.nextDueOn);
          }
          assert.equal(correctedDates[0]! < correctedDates[1]!, true);
          assert.equal(correctedDates[1]! < correctedDates[2]!, true);

          clock.set("2030-08-20T10:00:00.000Z");
          const dstLearner = await provisionLearner(
            "DST correction learner",
          );
          const dstAdded = await dstLearner.direct.questionBank.add({
            idempotencyKey: "dst-correction-question",
            items: [
              {
                prompt: "How are future Local Days calculated across DST?",
                referenceAnswer: "With calendar dates in the Learner timezone.",
              },
            ],
          });
          const dstOpen = await dstLearner.direct.review.open();
          const dstPending = await dstLearner.direct.review.submitAnswer({
            questionId: dstOpen.question?.questionId ?? "",
            answer: "With timezone-aware calendar dates.",
            idempotencyKey: "dst-correction-answer",
          });
          await dstLearner.direct.review.evaluatePending(dstPending.submissionId);
          await dstLearner.direct.settings.updateTimezone("America/New_York");
          clock.set("2030-11-02T16:00:00.000Z");
          const dstHard = await dstLearner.direct.review.grade({
            submissionId: dstPending.submissionId,
            grade: "hard",
          });
          assert.equal(dstHard.nextDueOn, "2030-11-04");
          assert.equal((await dstLearner.direct.review.open()).question, null);
          assert.equal(
            (
              await dstLearner.direct.questionBank.evidence(
                dstAdded.results[0]?.id ?? "",
              )
            ).dueAt,
            "2030-11-04T05:00:00.000Z",
          );
          evaluation.setGrade("good");
        },
      );

      await suite.test(
        "correction chains replay every Learner Answer and update Review without crossing Learners",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          evaluation.setGrade("good");
          const learner = await provisionLearner("Correction chain learner");
          const otherLearner = await provisionLearner(
            "Correction isolation learner",
          );
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "correction-chain-question",
            items: [
              {
                prompt: "What determines the rebuilt schedule?",
                referenceAnswer:
                  "The latest effective grade for every Learner Answer.",
              },
            ],
          });
          const questionId = added.results[0]?.id ?? "";
          const firstOpen = await learner.direct.review.open();
          const firstPending = await learner.direct.review.submitAnswer({
            questionId: firstOpen.question?.questionId ?? "",
            answer: "Every effective Answer Grade.",
            idempotencyKey: "correction-chain-first-answer",
          });
          const firstGood = await learner.direct.review.evaluatePending(
            firstPending.submissionId,
          );

          clock.set(`${firstGood.nextDueOn}T10:00:00.000Z`);
          const secondOpen = await learner.direct.review.open();
          assert.equal(secondOpen.question?.questionId, questionId);
          const secondPending = await learner.direct.review.submitAnswer({
            questionId: secondOpen.question?.questionId ?? "",
            answer: "Every effective Answer Grade, in order.",
            idempotencyKey: "correction-chain-second-answer",
          });
          const secondGood = await learner.direct.review.evaluatePending(
            secondPending.submissionId,
          );
          assert.ok(secondGood.nextDueOn);
          const firstInterval =
            Date.parse(`${firstGood.nextDueOn}T00:00:00.000Z`) -
            Date.parse("2030-08-20T00:00:00.000Z");
          const secondInterval =
            Date.parse(`${secondGood.nextDueOn}T00:00:00.000Z`) -
            Date.parse(`${firstGood.nextDueOn}T00:00:00.000Z`);
          assert.equal(secondInterval > firstInterval, true);
          assert.equal((await learner.direct.review.open()).question, null);

          await assert.rejects(
            otherLearner.direct.review.grade({
              submissionId: firstPending.submissionId,
              grade: "hard",
            }),
            /Submission not found/u,
          );

          const firstHard = await learner.direct.review.grade({
            submissionId: firstPending.submissionId,
            grade: "hard",
          });
          assert.equal(firstHard.grade, "hard");
          assert.ok(firstHard.nextDueOn);
          assert.equal(firstHard.nextDueOn! < secondGood.nextDueOn!, true);

          const firstEasy = await learner.direct.review.grade({
            submissionId: firstPending.submissionId,
            grade: "easy",
          });
          assert.equal(firstEasy.grade, "easy");
          assert.ok(firstEasy.nextDueOn);
          assert.equal(firstEasy.nextDueOn! > firstHard.nextDueOn!, true);

          clock.set("2030-08-25T10:00:00.000Z");
          const secondAgain = await learner.direct.review.grade({
            submissionId: secondPending.submissionId,
            grade: "again",
          });
          assert.equal(secondAgain.grade, "again");
          assert.equal(secondAgain.nextDueOn, "2030-08-25");
          const reopened = await learner.direct.review.open();
          assert.equal(reopened.question?.questionId, questionId);
          assert.equal(reopened.summary.queueRemaining, 1);
          assert.equal((await otherLearner.direct.review.open()).question, null);

          assert.deepEqual(
            await learner.direct.questionBank.evidence(questionId),
            {
              learnerAnswers: 2,
              evaluations: 2,
              gradeEvents: 5,
              dueAt: "2030-08-25T10:00:00.000Z",
            },
          );
          evaluation.setGrade("good");
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
              questionId: opened.question?.questionId ?? "",
              answer: "A cross-Learner answer must fail.",
              idempotencyKey: "cross-learner-review-answer",
            }),
            /no longer available in Review/u,
          );

          const answer = {
            questionId: opened.question?.questionId ?? "",
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
              canCorrectGrade: completed.canCorrectGrade,
            },
            {
              status: "complete",
              grade: "good",
              expectedAnswer:
                "Active Questions, the Learner's Local Day, and immutable Learning Evidence.",
              demonstratedGap:
                "No gap was demonstrated by this successful recall.",
              nextDueOn: "2030-08-23",
              canSelfGrade: false,
              canCorrectGrade: true,
            },
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(questionId),
            {
              learnerAnswers: 1,
              evaluations: 1,
              gradeEvents: 1,
              dueAt: "2030-08-23T10:00:00.000Z",
            },
          );

          const closedOutcome = await learner.direct.review.open();
          assert.equal(closedOutcome.question, null);
          assert.deepEqual(await learner.direct.review.open(), closedOutcome);
          assert.equal(closedOutcome.summary.nextScheduledOn, "2030-08-23");
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
              nextDueOn: "2030-08-23",
            },
          );

          clock.set("2030-08-23T10:00:00.000Z");
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
            questionId: opened.question?.questionId ?? "",
            answer: "The persisted IANA Local Day.",
            idempotencyKey: "timezone-boundary-answer",
          });
          assert.equal(
            (await learner.direct.review.evaluatePending(pending.submissionId))
              .nextDueOn,
            "2030-08-23",
          );

          clock.set("2030-08-22T23:30:00.000Z");
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
          assert.equal(westward.localDay, "2030-08-22");
          assert.equal(westward.question, null);

          await learner.direct.settings.updateTimezone("Europe/Lisbon");
          const eastward = await learner.direct.review.open();
          assert.equal(eastward.localDay, "2030-08-23");
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
        "timezone edits serialize ahead of answer and grade Local Day derivation",
        async () => {
          const { getV2Client } = await import("../app/db/v2/client.ts");
          const { pool } = getV2Client();

          async function waitForAdvisoryWaiters(expected: number) {
            for (let attempt = 0; attempt < 200; attempt += 1) {
              const result = await pool.query<{ count: number }>(
                `SELECT count(*)::integer AS count
                   FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND wait_event = 'advisory'`,
              );
              if ((result.rows[0]?.count ?? 0) >= expected) return;
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            throw new Error(
              `Timed out waiting for ${expected} advisory-lock waiters.`,
            );
          }

          async function runAfterQueuedTimezoneUpdate<T>(input: {
            userId: string;
            updateTimezone: () => Promise<unknown>;
            operation: () => Promise<T>;
          }): Promise<T> {
            const blocker = await pool.connect();
            let transactionOpen = false;
            let timezoneUpdate: Promise<unknown> | undefined;
            let operation: Promise<T> | undefined;
            try {
              await blocker.query("BEGIN");
              transactionOpen = true;
              await blocker.query(
                "SELECT pg_advisory_xact_lock(hashtext($1))",
                [`review-queue:${input.userId}`],
              );
              timezoneUpdate = input.updateTimezone();
              await waitForAdvisoryWaiters(1);
              operation = input.operation();
              await waitForAdvisoryWaiters(2);
              await blocker.query("COMMIT");
              transactionOpen = false;
              const [, result] = await Promise.all([
                timezoneUpdate,
                operation,
              ]);
              return result;
            } catch (error) {
              if (transactionOpen) await blocker.query("ROLLBACK");
              await Promise.allSettled(
                [timezoneUpdate, operation].filter(
                  (pending): pending is Promise<unknown> => Boolean(pending),
                ),
              );
              throw error;
            } finally {
              blocker.release();
            }
          }

          clock.set("2030-08-20T10:00:00.000Z");
          evaluation.setGrade("good");
          const answerLearner = await provisionLearner(
            "Serialized timezone answer learner",
          );
          await answerLearner.direct.questionBank.add({
            idempotencyKey: "serialized-timezone-answer-question",
            items: [
              {
                prompt: "Which Local Day authorizes a queued answer?",
                referenceAnswer: "The Local Day read after queue serialization.",
              },
            ],
          });
          const answerOpen = await answerLearner.direct.review.open();
          const initialAnswer = await answerLearner.direct.review.submitAnswer({
            questionId: answerOpen.question?.questionId ?? "",
            answer: "The serialized Local Day.",
            idempotencyKey: "serialized-timezone-initial-answer",
          });
          assert.equal(
            (
              await answerLearner.direct.review.evaluatePending(
                initialAnswer.submissionId,
              )
            ).nextDueOn,
            "2030-08-23",
          );
          await answerLearner.direct.settings.updateTimezone("Europe/Lisbon");
          clock.set("2030-08-22T23:30:00.000Z");
          const dueInLisbon = await answerLearner.direct.review.open();
          assert.equal(dueInLisbon.localDay, "2030-08-23");
          assert.ok(dueInLisbon.question);
          await assert.rejects(
            runAfterQueuedTimezoneUpdate({
              userId: answerLearner.id,
              updateTimezone: () =>
                answerLearner.direct.settings.updateTimezone(
                  "America/Los_Angeles",
                ),
              operation: () =>
                answerLearner.direct.review.submitAnswer({
                  questionId:
                    dueInLisbon.question?.questionId ?? "",
                  answer: "A stale Local Day must not authorize this answer.",
                  idempotencyKey: "serialized-timezone-stale-answer",
                }),
            }),
            /no longer available in Review/u,
          );
          assert.equal(
            (await answerLearner.direct.review.open()).localDay,
            "2030-08-22",
          );

          evaluation.setGrade("again");
          const gradeLearner = await provisionLearner(
            "Serialized timezone grade learner",
          );
          await gradeLearner.direct.settings.updateTimezone("Europe/Lisbon");
          await gradeLearner.direct.questionBank.add({
            idempotencyKey: "serialized-timezone-grade-question",
            items: [
              {
                prompt: "Which Local Day anchors a serialized Grade?",
                referenceAnswer: "The Local Day read after the timezone edit.",
              },
            ],
          });
          const gradeOpen = await gradeLearner.direct.review.open();
          const pendingGrade = await gradeLearner.direct.review.submitAnswer({
            questionId: gradeOpen.question?.questionId ?? "",
            answer: "The post-lock Local Day.",
            idempotencyKey: "serialized-timezone-grade-answer",
          });
          const automated = await runAfterQueuedTimezoneUpdate({
            userId: gradeLearner.id,
            updateTimezone: () =>
              gradeLearner.direct.settings.updateTimezone(
                "America/Los_Angeles",
              ),
            operation: () =>
              gradeLearner.direct.review.evaluatePending(
                pendingGrade.submissionId,
              ),
          });
          assert.equal(automated.nextDueOn, "2030-08-22");

          await gradeLearner.direct.settings.updateTimezone("Europe/Lisbon");
          const corrected = await runAfterQueuedTimezoneUpdate({
            userId: gradeLearner.id,
            updateTimezone: () =>
              gradeLearner.direct.settings.updateTimezone(
                "America/Los_Angeles",
              ),
            operation: () =>
              gradeLearner.direct.review.grade({
                submissionId: pendingGrade.submissionId,
                grade: "again",
              }),
          });
          assert.equal(corrected.nextDueOn, "2030-08-22");
          evaluation.setGrade("good");
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
            questionId: review.question?.questionId ?? "",
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
          assert.equal(completed.nextDueOn, "2030-08-23");

          const evidenceBefore = await learner.direct.questionBank.evidence(
            questionId,
          );
          assert.deepEqual(evidenceBefore, {
            learnerAnswers: 1,
            evaluations: 1,
            gradeEvents: 1,
            dueAt: "2030-08-23T10:00:00.000Z",
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
              dueAt: "2030-08-23T10:00:00.000Z",
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
        "replacement applies canonical semantic quality outcomes and quarantines every non-pass",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const expectations = [
            { outcome: "fail", reason: "not_atomic" },
            {
              outcome: "inconclusive",
              reason: "semantic_validation_inconclusive",
            },
            {
              outcome: "unavailable",
              reason: "semantic_validation_unavailable",
            },
          ] as const;

          for (const { outcome, reason } of expectations) {
            semanticValidation.setOutcome("pass");
            const learner = await provisionLearner(
              `Replacement ${outcome} learner`,
            );
            const original = await learner.direct.questionBank.add({
              idempotencyKey: `replacement-${outcome}-original`,
              items: [
                {
                  prompt: `What evidence precedes a ${outcome} replacement?`,
                  referenceAnswer:
                    "The predecessor's immutable Learning Evidence.",
                },
              ],
            });
            const originalQuestionId = original.results[0]?.id ?? "";
            const opened = await learner.direct.review.open();
            const answer = await learner.direct.review.submitAnswer({
              questionId: opened.question?.questionId ?? "",
              answer: "The predecessor's immutable Learning Evidence.",
              idempotencyKey: `replacement-${outcome}-answer`,
            });
            await learner.direct.review.evaluatePending(answer.submissionId);
            const evidenceBefore = await learner.direct.questionBank.evidence(
              originalQuestionId,
            );

            semanticValidation.setOutcome(outcome);
            const replacement = await learner.direct.questionBank.replace({
              questionId: originalQuestionId,
              prompt: `Which ${outcome} replacement must stay out of Review?`,
              referenceAnswer:
                "A structurally valid replacement that did not pass semantic quality assessment.",
            });
            assert.equal(replacement.lifecycle, "flagged");
            assert.notEqual(replacement.questionId, originalQuestionId);
            assert.equal(replacement.archivedQuestionId, originalQuestionId);
            assert.equal((await learner.direct.review.open()).question, null);

            const questions = (await learner.direct.questionBank.list())
              .questions;
            const predecessor = questions.find(
              (question) => question.id === originalQuestionId,
            );
            const candidate = questions.find(
              (question) => question.id === replacement.questionId,
            );
            assert.equal(predecessor?.lifecycle, "archived");
            assert.deepEqual(
              candidate && {
                lifecycle: candidate.lifecycle,
                dueAt: candidate.dueAt,
                flags: candidate.flags.map(
                  ({ origin, reasons, detail, resolvedAt }) => ({
                    origin,
                    reasons,
                    detail,
                    resolvedAt,
                  }),
                ),
              },
              {
                lifecycle: "flagged",
                dueAt: null,
                flags: [
                  {
                    origin: "waxon_validation",
                    reasons: [reason],
                    detail: null,
                    resolvedAt: null,
                  },
                ],
              },
            );
            assert.deepEqual(
              await learner.direct.questionBank.evidence(originalQuestionId),
              evidenceBefore,
            );
            assert.deepEqual(
              await learner.direct.questionBank.evidence(
                replacement.questionId,
              ),
              {
                learnerAnswers: 0,
                evaluations: 0,
                gradeEvents: 0,
                dueAt: null,
              },
            );
          }
          semanticValidation.setOutcome("pass");
        },
      );

      await suite.test(
        "repeated same-Prompt replacement archives each predecessor and preserves its Learning Evidence",
        async () => {
          clock.set("2030-08-20T10:00:00.000Z");
          const learner = await provisionLearner(
            "Repeated replacement contract learner",
          );
          const prompt = "What survives each immutable Question replacement?";
          const added = await learner.direct.questionBank.add({
            idempotencyKey: "repeated-replacement-question",
            items: [
              {
                prompt,
                referenceAnswer: "The predecessor and its Learning Evidence.",
              },
            ],
          });
          const originalId = added.results[0]?.id ?? "";
          const originalOpen = await learner.direct.review.open();
          const originalAnswer = await learner.direct.review.submitAnswer({
            questionId: originalOpen.question?.questionId ?? "",
            answer: "The predecessor and evidence survive.",
            idempotencyKey: "repeated-replacement-original-answer",
          });
          await learner.direct.review.evaluatePending(originalAnswer.submissionId);
          const originalEvidence = await learner.direct.questionBank.evidence(
            originalId,
          );

          const firstReplacement = await learner.direct.questionBank.replace({
            questionId: originalId,
            prompt,
            referenceAnswer:
              "The Archived predecessor and all of its Learning Evidence.",
          });
          const firstReplacementOpen = await learner.direct.review.open();
          assert.equal(
            firstReplacementOpen.question?.questionId,
            firstReplacement.questionId,
          );
          const firstReplacementAnswer =
            await learner.direct.review.submitAnswer({
              questionId: firstReplacementOpen.question?.questionId ?? "",
              answer: "The archived predecessor and all evidence.",
              idempotencyKey: "repeated-replacement-first-answer",
            });
          await learner.direct.review.evaluatePending(
            firstReplacementAnswer.submissionId,
          );
          const firstReplacementEvidence =
            await learner.direct.questionBank.evidence(
              firstReplacement.questionId,
            );

          const secondReplacement = await learner.direct.questionBank.replace({
            questionId: firstReplacement.questionId,
            prompt,
            referenceAnswer:
              "Every Archived predecessor retains its own immutable Learning Evidence.",
          });
          assert.notEqual(secondReplacement.questionId, firstReplacement.questionId);
          assert.equal(secondReplacement.lifecycle, "active");
          const duplicate = await learner.direct.questionBank.add({
            idempotencyKey: "repeated-replacement-duplicate",
            items: [
              {
                prompt,
                referenceAnswer:
                  "Every Archived predecessor retains its own immutable Learning Evidence.",
              },
            ],
          });
          assert.deepEqual(
            duplicate.results[0] && {
              id: duplicate.results[0].id,
              status: duplicate.results[0].status,
              outcome: duplicate.results[0].outcome,
            },
            {
              id: secondReplacement.questionId,
              status: "existing",
              outcome: "exact_duplicate",
            },
          );
          await assert.rejects(
            learner.direct.questionBank.restore(originalId),
            /Another Active Question already uses this prompt/u,
          );

          const questions = (await learner.direct.questionBank.list()).questions;
          assert.deepEqual(
            new Map(
              questions.map((question) => [
                question.id,
                {
                  lifecycle: question.lifecycle,
                  referenceAnswer: question.referenceAnswer,
                  dueAt: question.dueAt,
                },
              ]),
            ),
            new Map([
              [
                originalId,
                {
                  lifecycle: "archived",
                  referenceAnswer:
                    "The predecessor and its Learning Evidence.",
                  dueAt: originalEvidence.dueAt,
                },
              ],
              [
                firstReplacement.questionId,
                {
                  lifecycle: "archived",
                  referenceAnswer:
                    "The Archived predecessor and all of its Learning Evidence.",
                  dueAt: firstReplacementEvidence.dueAt,
                },
              ],
              [
                secondReplacement.questionId,
                {
                  lifecycle: "active",
                  referenceAnswer:
                    "Every Archived predecessor retains its own immutable Learning Evidence.",
                  dueAt: null,
                },
              ],
            ]),
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(originalId),
            originalEvidence,
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(
              firstReplacement.questionId,
            ),
            firstReplacementEvidence,
          );
          assert.deepEqual(
            await learner.direct.questionBank.evidence(
              secondReplacement.questionId,
            ),
            {
              learnerAnswers: 0,
              evaluations: 0,
              gradeEvents: 0,
              dueAt: null,
            },
          );
          assert.equal(
            (await learner.direct.review.open()).question?.questionId,
            secondReplacement.questionId,
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
            questionId: review.question?.questionId ?? "",
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
          assert.equal(restored?.dueAt, "2030-08-23T10:00:00.000Z");
          assert.deepEqual(
            await learner.direct.questionBank.evidence(questionId),
            evidenceBefore,
          );
          assert.deepEqual(
            await learner.direct.review.getEvaluation(pending.submissionId),
            completed,
          );
          clock.set("2030-08-23T10:00:00.000Z");
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
          const original = await learnerA.direct.questionBank.add({
            idempotencyKey: "replacement-original",
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
          const originalId = original.results[0]?.id ?? "";

          const beforeStructuralRejection =
            (await learnerA.direct.questionBank.list()).questions;
          await assert.rejects(
            learnerA.direct.questionBank.replace({
              questionId: originalId,
              prompt: "   ",
              referenceAnswer: "A replacement that must never be stored.",
            }),
            /Add a question prompt/u,
          );
          assert.deepEqual(
            (await learnerA.direct.questionBank.list()).questions,
            beforeStructuralRejection,
          );

          await assert.rejects(
            learnerB.direct.questionBank.replace({
              questionId: originalId,
              prompt: "Why must a cross-Learner replacement fail?",
              referenceAnswer: "Learner ownership prevents it.",
            }),
            /Question not found/u,
          );
          await assert.rejects(
            learnerA.direct.questionBank.replace({
              questionId: originalId,
              prompt: "  WHICH PROMPT BLOCKS DUPLICATE REPLACEMENT?  ",
              referenceAnswer: "A conflicting Answer Standard.",
            }),
            /already uses this prompt/u,
          );

          const unchanged = await learnerA.direct.questionBank.replace({
            questionId: originalId,
            prompt: "  WHICH QUESTION remains after replacement rollback?  ",
            referenceAnswer: "  The original Active Question.  ",
          });
          assert.deepEqual(unchanged, {
            questionId: originalId,
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
                questionId: originalId,
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
          const retained = questions.find((question) => question.id === originalId);
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

      await suite.test(
        "repeated browser fixture seeding resets mastery without touching another Learner",
        async () => {
          const learner = await provisionLearner("Browser fixture learner");
          const unrelatedLearner = await provisionLearner(
            "Browser fixture unrelated learner",
          );
          const unrelatedQuestion =
            await unrelatedLearner.direct.questionBank.add({
              idempotencyKey: "browser-fixture-unrelated-question",
              items: [
                {
                  prompt: "Which Question must fixture seeding never alter?",
                  referenceAnswer:
                    "A Question owned by an unrelated Learner.",
                },
              ],
            });
          const unrelatedQuestionId =
            unrelatedQuestion.results[0]?.id ?? "";
          const unrelatedOpen = await unrelatedLearner.direct.review.open();
          const unrelatedSubmission =
            await unrelatedLearner.direct.review.submitAnswer({
              questionId: unrelatedOpen.question?.questionId ?? "",
              answer: "The unrelated Learner's Question.",
              idempotencyKey: "browser-fixture-unrelated-answer",
            });
          await unrelatedLearner.direct.review.evaluatePending(
            unrelatedSubmission.submissionId,
          );

          async function unrelatedSnapshot() {
            return {
              library: await unrelatedLearner.direct.questionBank.list(),
              evidence:
                await unrelatedLearner.direct.questionBank.evidence(
                  unrelatedQuestionId,
                ),
              review: await unrelatedLearner.direct.review.open(),
            };
          }

          const unrelatedBefore = await unrelatedSnapshot();
          const {
            BrowserSmokeSeedConflict,
            seedBrowserSmokeJourney,
          } = await import("../app/lib/browserSmokeFixture.ts");
          const { BROWSER_SMOKE_ISOLATION_LEARNER } = await import(
            "../app/lib/browserSmokeSupport.ts"
          );
          const { getV2Client } = await import("../app/db/v2/client.ts");
          const { pool } = getV2Client();

          try {
            const firstSeed = await seedBrowserSmokeJourney(learner.id);
            assert.equal(firstSeed.questions.length, 6);
            assert.equal(
              firstSeed.questions.every(
                (question) =>
                  question.status === "created" &&
                  question.outcome === "created_active" &&
                  question.lifecycle === "active",
              ),
              true,
            );
            const firstIds = firstSeed.questions.map((question) => question.id);
            const firstOpen = await learner.direct.review.open();
            assert.equal(firstOpen.summary.queueRemaining, 6);
            assert.equal(firstOpen.question?.questionId, firstIds[0]);

            const firstSubmission = await learner.direct.review.submitAnswer({
              questionId: firstOpen.question?.questionId ?? "",
              answer: "The first deterministic fixture answer.",
              idempotencyKey: "browser-fixture-first-answer",
            });
            await learner.direct.review.evaluatePending(
              firstSubmission.submissionId,
            );
            const firstEvidence =
              await learner.direct.questionBank.evidence(firstIds[0] ?? "");
            assert.deepEqual(firstEvidence, {
              learnerAnswers: 1,
              evaluations: 1,
              gradeEvents: 1,
              dueAt: "2030-08-23T10:00:00.000Z",
            });

            const secondSeed = await seedBrowserSmokeJourney(learner.id);
            const secondIds = secondSeed.questions.map(
              (question) => question.id,
            );
            assert.equal(secondSeed.questions.length, 6);
            assert.equal(
              secondSeed.questions.every(
                (question) =>
                  question.status === "created" &&
                  question.outcome === "created_active" &&
                  question.lifecycle === "active",
              ),
              true,
            );
            assert.equal(
              secondIds.every((id, index) => id !== firstIds[index]),
              true,
            );
            assert.deepEqual(
              await learner.direct.questionBank.evidence(secondIds[0] ?? ""),
              {
                learnerAnswers: 0,
                evaluations: 0,
                gradeEvents: 0,
                dueAt: null,
              },
            );
            assert.deepEqual(
              await learner.direct.questionBank.evidence(firstIds[0] ?? ""),
              firstEvidence,
            );
            const reopened = await learner.direct.review.open();
            assert.equal(reopened.summary.queueRemaining, 6);
            assert.equal(reopened.question?.questionId, secondIds[0]);
            const reseededLibrary =
              await learner.direct.questionBank.list();
            assert.deepEqual(reseededLibrary.counts, {
              active: 6,
              flagged: 0,
              archived: 6,
            });

            await learner.direct.review.flag({
              questionId: secondIds[0] ?? "",
              reasons: ["answer_standard_incorrect"],
              detail:
                "The current fixture is Flagged while its predecessor is Archived.",
            });
            assert.deepEqual(
              (await learner.direct.questionBank.list()).counts,
              {
                active: 5,
                flagged: 1,
                archived: 6,
              },
            );

            const thirdSeed = await seedBrowserSmokeJourney(learner.id);
            const thirdIds = thirdSeed.questions.map((question) => question.id);
            assert.equal(thirdSeed.questions.length, 6);
            assert.equal(
              thirdSeed.questions.every(
                (question) =>
                  question.status === "created" &&
                  question.outcome === "created_active" &&
                  question.lifecycle === "active",
              ),
              true,
            );
            assert.equal(
              thirdIds.every((id, index) => id !== secondIds[index]),
              true,
            );
            assert.deepEqual(
              await learner.direct.questionBank.evidence(thirdIds[0] ?? ""),
              {
                learnerAnswers: 0,
                evaluations: 0,
                gradeEvents: 0,
                dueAt: null,
              },
            );
            assert.deepEqual(
              await learner.direct.questionBank.evidence(firstIds[0] ?? ""),
              firstEvidence,
            );
            assert.deepEqual(
              (await learner.direct.questionBank.list()).counts,
              {
                active: 6,
                flagged: 0,
                archived: 12,
              },
            );
            assert.equal(
              (await learner.direct.review.open()).question?.questionId,
              thirdIds[0],
            );

            assert.deepEqual(await unrelatedSnapshot(), unrelatedBefore);

            await learner.direct.questionBank.add({
              idempotencyKey: "browser-fixture-unexpected-active",
              items: [
                {
                  prompt: "Which Active Question blocks fixture seeding?",
                  referenceAnswer:
                    "Any non-fixture Active Question in the target bank.",
                },
              ],
            });
            const targetBeforeConflict =
              await learner.direct.questionBank.list();
            await assert.rejects(
              seedBrowserSmokeJourney(learner.id),
              (error: unknown) =>
                error instanceof BrowserSmokeSeedConflict &&
                error.activeQuestions.some(
                  (question) =>
                    question.prompt ===
                    "Which Active Question blocks fixture seeding?",
                ),
            );
            assert.deepEqual(
              await learner.direct.questionBank.list(),
              targetBeforeConflict,
            );
            assert.deepEqual(await unrelatedSnapshot(), unrelatedBefore);
          } finally {
            await pool.query(
              `DELETE FROM waxon_v2.users WHERE id = $1`,
              [BROWSER_SMOKE_ISOLATION_LEARNER.id],
            );
          }
        },
      );
    });
  },
);
