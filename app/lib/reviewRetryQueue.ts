import type { ReviewQueueItem } from "./reviewTypes";

export type ReviewRetryQuestionIdentity = {
  questionId?: string | null;
  question: string;
};

export function isSameReviewRetryQuestion(
  left: ReviewRetryQuestionIdentity,
  right: ReviewRetryQuestionIdentity,
): boolean {
  if (left.questionId && right.questionId) {
    return left.questionId === right.questionId;
  }

  return left.question.trim() === right.question.trim();
}

export function deferredReviewRetryQuestionIds(
  items: ReviewRetryQuestionIdentity[],
): string[] {
  return items
    .map((item) => item.questionId?.trim() ?? "")
    .filter(Boolean);
}

export function mergeDeferredReviewRetryItem(
  items: ReviewQueueItem[],
  retryItem: ReviewQueueItem,
): ReviewQueueItem[] {
  return [
    ...items.filter((item) => !isSameReviewRetryQuestion(item, retryItem)),
    retryItem,
  ];
}

export function placeReviewRetryQuestion(input: {
  retryItem: ReviewQueueItem;
  currentItem?: ReviewRetryQuestionIdentity | null;
  queue: ReviewQueueItem[];
}): {
  queue: ReviewQueueItem[];
  deferredRetryItem: ReviewQueueItem | null;
} {
  const queueWithoutRetry = input.queue.filter(
    (item) => !isSameReviewRetryQuestion(item, input.retryItem),
  );
  const currentItem = input.currentItem ?? null;
  const currentIsIntervening =
    currentItem !== null &&
    !isSameReviewRetryQuestion(currentItem, input.retryItem);

  if (currentIsIntervening) {
    return {
      queue: [input.retryItem, ...queueWithoutRetry],
      deferredRetryItem: null,
    };
  }

  const [firstDifferentItem, ...remainingItems] = queueWithoutRetry;

  if (firstDifferentItem) {
    return {
      queue: [firstDifferentItem, input.retryItem, ...remainingItems],
      deferredRetryItem: null,
    };
  }

  return {
    queue: queueWithoutRetry,
    deferredRetryItem: input.retryItem,
  };
}

export function releaseDeferredReviewRetries(input: {
  currentItem: ReviewRetryQuestionIdentity | null;
  queue: ReviewQueueItem[];
  deferredRetryItems: ReviewQueueItem[];
}): {
  queue: ReviewQueueItem[];
  deferredRetryItems: ReviewQueueItem[];
} {
  let queue = input.queue;
  let deferredRetryItems: ReviewQueueItem[] = [];

  for (const retryItem of [...input.deferredRetryItems].reverse()) {
    const placement = placeReviewRetryQuestion({
      retryItem,
      currentItem: input.currentItem,
      queue,
    });

    queue = placement.queue;

    if (placement.deferredRetryItem) {
      deferredRetryItems = mergeDeferredReviewRetryItem(
        deferredRetryItems,
        placement.deferredRetryItem,
      );
    }
  }

  return {
    queue,
    deferredRetryItems,
  };
}
