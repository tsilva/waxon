export const MINIMUM_SOLO_RETRY_DELAY_MS = 10 * 60_000;

export function retryEarliestAt(input: {
  hasDifferentQuestionAfter: boolean;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();

  return input.hasDifferentQuestionAfter
    ? now
    : new Date(now.getTime() + MINIMUM_SOLO_RETRY_DELAY_MS);
}
