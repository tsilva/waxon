import { ReviewHydrator } from "./ReviewHydrator";
import { ReviewStaticView } from "./ReviewStaticView";

export default function ReviewPage() {
  return (
    <>
      <ReviewStaticView />
      <ReviewHydrator />
    </>
  );
}
