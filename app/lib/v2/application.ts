import { checkQuestions } from "./questionSearch.ts";
import {
  addQuestions,
  createDirectQuestion,
  defaultV2ServiceDependencies,
  flagQuestionInBank,
  getQuestionLearningEvidence,
  listLibrary,
  mutateQuestionLifecycle,
  replaceQuestion,
  type V2ServiceDependencies,
} from "./service.ts";
import {
  applyLiveRecallResultCorrection,
  flagCurrentReviewQuestion,
  getLiveEvaluation,
  getLiveReviewQueue,
  getLiveReviewSummary,
  runLiveEvaluationForSubmission,
  retryLiveEvaluation,
  submitLiveReviewAnswer,
} from "./liveReview.ts";
import {
  getLearnerSettings,
  updateLearnerTimezone,
} from "./settings.ts";
import { listTags } from "./tags.ts";

export type WaxonApplicationDependencies = {
  clock?: { now(): Date };
  validateQuestion?: V2ServiceDependencies["validateQuestion"];
  evaluateAnswer?: V2ServiceDependencies["evaluateAnswer"];
};

export function createWaxonApplication(
  dependencies: WaxonApplicationDependencies = {},
) {
  const serviceDependencies: V2ServiceDependencies = {
    now: dependencies.clock?.now ?? defaultV2ServiceDependencies.now,
    validateQuestion:
      dependencies.validateQuestion ??
      defaultV2ServiceDependencies.validateQuestion,
    evaluateAnswer:
      dependencies.evaluateAnswer ?? defaultV2ServiceDependencies.evaluateAnswer,
  };

  function questionBankFor(userId: string, scope: "library" | "mcp") {
    return {
      add(input: {
        idempotencyKey: string;
        items: Parameters<typeof addQuestions>[0]["items"];
      }) {
        return addQuestions({ ...input, userId, scope }, serviceDependencies);
      },
      list(
        input: Omit<Parameters<typeof listLibrary>[0], "userId"> = {},
      ) {
        return listLibrary({ ...input, userId });
      },
      check(
        input: Omit<Parameters<typeof checkQuestions>[0], "userId">,
      ) {
        return checkQuestions({ ...input, userId });
      },
    };
  }

  return {
    forLearner(userId: string) {
      const questionBank = questionBankFor(userId, "library");
      return {
        questionBank: {
          ...questionBank,
          create(
            input: Omit<
              Parameters<typeof createDirectQuestion>[0],
              "userId"
            >,
          ) {
            return createDirectQuestion(
              { ...input, userId },
              serviceDependencies,
            );
          },
          replace(
            input: Omit<Parameters<typeof replaceQuestion>[0], "userId">,
          ) {
            return replaceQuestion({ ...input, userId }, serviceDependencies);
          },
          flag(
            input: Omit<Parameters<typeof flagQuestionInBank>[0], "userId">,
          ) {
            return flagQuestionInBank(
              { ...input, userId },
              serviceDependencies,
            );
          },
          archive(questionId: string) {
            return mutateQuestionLifecycle(
              { userId, questionId, action: "archive" },
              serviceDependencies,
            );
          },
          restore(questionId: string) {
            return mutateQuestionLifecycle(
              { userId, questionId, action: "restore" },
              serviceDependencies,
            );
          },
          evidence(questionId: string) {
            return getQuestionLearningEvidence({ userId, questionId });
          },
        },
        tags: {
          list(input: Omit<Parameters<typeof listTags>[0], "userId"> = {}) {
            return listTags({ ...input, userId });
          },
        },
        review: {
          open(
            selection: Parameters<typeof getLiveReviewQueue>[2] = {},
          ) {
            return getLiveReviewQueue(
              userId,
              serviceDependencies,
              selection,
            );
          },
          summary() {
            return getLiveReviewSummary(userId, serviceDependencies.now());
          },
          submitAnswer(
            input: Omit<Parameters<typeof submitLiveReviewAnswer>[0], "userId">,
          ) {
            return submitLiveReviewAnswer(
              { ...input, userId },
              serviceDependencies,
            );
          },
          getEvaluation(submissionId: string) {
            return getLiveEvaluation(userId, submissionId);
          },
          evaluatePending(submissionId: string) {
            return runLiveEvaluationForSubmission(
              userId,
              submissionId,
              serviceDependencies,
            );
          },
          correctRecallResult(
            input: Omit<
              Parameters<typeof applyLiveRecallResultCorrection>[0],
              "userId"
            >,
          ) {
            return applyLiveRecallResultCorrection(
              { ...input, userId },
              serviceDependencies,
            );
          },
          retryEvaluation(submissionId: string) {
            return retryLiveEvaluation(
              { userId, submissionId },
              serviceDependencies,
            );
          },
          flag(
            input: Omit<
              Parameters<typeof flagCurrentReviewQuestion>[0],
              "userId"
            >,
          ) {
            return flagCurrentReviewQuestion(
              { ...input, userId },
              serviceDependencies,
            );
          },
        },
        settings: {
          get() {
            return getLearnerSettings(userId);
          },
          updateTimezone(timezone: string) {
            return updateLearnerTimezone({ userId, timezone });
          },
        },
      };
    },
    forAuthorizedMcpClient(userId: string) {
      return { questionBank: questionBankFor(userId, "mcp") };
    },
  };
}

export const waxonApplication = createWaxonApplication();
