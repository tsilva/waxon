import { checkQuestions } from "./questionSearch.ts";
import {
  actOnReviewItem,
  addQuestions,
  applyLearnerGrade,
  createDirectQuestion,
  defaultV2ServiceDependencies,
  getQuestionLearningEvidence,
  getEvaluationForSubmission,
  getOrCreateReviewSession,
  getReviewSummary,
  listLibrary,
  mutateQuestionLifecycle,
  replaceQuestion,
  runEvaluationForSubmission,
  submitReviewAnswer,
  type V2ServiceDependencies,
} from "./service.ts";

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
        return listLibrary({ ...input, userId }, serviceDependencies.now());
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
        review: {
          open() {
            return getOrCreateReviewSession(userId, serviceDependencies);
          },
          act(
            input: Omit<Parameters<typeof actOnReviewItem>[0], "userId">,
          ) {
            return actOnReviewItem(
              { ...input, userId },
              serviceDependencies,
            );
          },
          summary() {
            return getReviewSummary(userId, serviceDependencies.now());
          },
          submitAnswer(
            input: Omit<Parameters<typeof submitReviewAnswer>[0], "userId">,
          ) {
            return submitReviewAnswer(
              { ...input, userId },
              serviceDependencies,
            );
          },
          getEvaluation(submissionId: string) {
            return getEvaluationForSubmission(userId, submissionId);
          },
          evaluatePending(submissionId: string) {
            return runEvaluationForSubmission(
              userId,
              submissionId,
              serviceDependencies,
            );
          },
          grade(
            input: Omit<Parameters<typeof applyLearnerGrade>[0], "userId">,
          ) {
            return applyLearnerGrade(
              { ...input, userId },
              serviceDependencies,
            );
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
