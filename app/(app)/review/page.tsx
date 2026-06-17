import { ReviewHydrator } from "./ReviewHydrator";
import { ReviewStaticView } from "./ReviewStaticView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function ReviewPage() {
  return (
    <>
      <ReviewStaticView />
      <ReviewHydrator />
    </>
  );
}
