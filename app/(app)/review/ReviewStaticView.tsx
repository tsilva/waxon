import type { QuestionAttempt, ReviewQueueItem } from "@/app/lib/reviewTypes";
import { AppStaticLoadingView } from "../AppStaticLoadingView";

type UserProfileResponse = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

type QueueStatusResponse = {
  queueRemaining: number;
  recentAttempts?: QuestionAttempt[];
};

export type ReviewInitialViewProps = {
  initialCurrentUser?: UserProfileResponse | null;
  initialPreviousAnswerStatus?: QueueStatusResponse | null;
  initialReviewSessionQueue?: ReviewQueueItem[] | null;
};

export function ReviewStaticView() {
  return <AppStaticLoadingView staticView="review" />;
}
