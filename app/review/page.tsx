import ReviewApp from "./ReviewApp";
import { loadInitialReviewPageData } from "@/app/lib/reviewQueue";

export default async function ReviewPage() {
  const initialReviewPage = await loadInitialReviewPageData();

  return (
    <ReviewApp
      initialCurrentUser={initialReviewPage.currentUser}
      initialActiveTab="review"
      initialPreviousAnswerStatus={initialReviewPage.previousAnswerStatus}
      initialReviewSessionQueue={initialReviewPage.reviewSessionQueue.items}
    />
  );
}
