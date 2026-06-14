import { ReviewHydrator } from "./ReviewHydrator";
import { ReviewStaticView } from "./ReviewStaticView";
import { loadInitialReviewPageData } from "@/app/lib/reviewQueue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const initialData = await loadInitialReviewPageData();

  return (
    <>
      <ReviewStaticView
        initialCurrentUser={initialData.currentUser}
        initialPreviousAnswerStatus={initialData.previousAnswerStatus}
        initialReviewSessionQueue={initialData.reviewSessionQueue.items}
      />
      <ReviewHydrator />
    </>
  );
}
